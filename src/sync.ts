import { Notice, TFile, TFolder, Vault, normalizePath } from "obsidian";
import type { Moment } from "moment";
import {
	ReconnectRequiredError,
	isConnected,
	withGoogleAccount,
	type AuthDeps,
} from "./googleAuth";
import {
	cachedEventsForDay,
	calendarCacheEvents,
	refreshCalendarCache,
	type GoogleEvent,
} from "./googleCalendar";
import {
	calendarSectionFromContent,
	eventIsIncluded,
	extractPreservedEvents,
	notePathFor,
	renderCalendarBlock,
	renderNewDailyNoteContent,
	replaceCalendarSectionContent,
	type PreservedEventState,
} from "./dailyNote";
import {
	datesInSpan,
	eventOccurrenceKey,
	eventStartDate,
	isMultiDayEventChecked,
	multiDaySpan,
	shiftDate,
	type MultiDaySpan,
} from "./multiDay";
import { GoogleHttpError } from "./network";
import { ICalHttpError } from "./network";
import { refreshICalCalendar } from "./ical";
import type {
	CalendarConfig,
	GoogleAccountProfile,
	ICalCalendarConfig,
	MultiDayCompletionRule,
	RenderingSettings,
	SyncFailureCategory,
} from "./settings";
import { zonedDayRange } from "./timezone";

const MAX_SYNC_DAYS = 366;

interface DateToSync {
	date: Moment;
	file?: TFile;
}

interface FetchedDay extends DateToSync {
	dateKey: string;
	eventsByCalendar: Map<string, GoogleEvent[]>;
	calendars: CalendarConfig[];
}

type EnabledCalendarSource =
	| { kind: "google"; config: CalendarConfig; remoteId: string; account: GoogleAccountProfile }
	| { kind: "ical"; config: CalendarConfig; calendar: ICalCalendarConfig };

interface MultiDayGroup {
	eventKey: string;
	title: string;
	span: MultiDaySpan;
}

export type SyncPlanOperation = "create" | "change" | "skip";

export interface SyncPlanEntry {
	dateKey: string;
	path: string;
	operation: SyncPlanOperation;
	beforeContent: string | null;
	afterContent: string | null;
	beforeSection: string | null;
	afterSection: string | null;
}

export interface SyncPlan {
	createdAt: number;
	entries: SyncPlanEntry[];
	dayCount: number;
}

export interface SyncUndoSnapshot {
	createdAt: number;
	entries: Array<{
		path: string;
		beforeSection: string;
		afterSection: string;
	}>;
}

export interface MultiDayConfirmation {
	eventKey: string;
	title: string;
	completedFrom: string;
	eventEnd: string;
}

export interface SyncOptions {
	/** Whether to surface result Notices. Defaults to true. False is used by background sync. */
	notify?: boolean;
	/** UI callback used only by interactive syncs when multi-day behavior is ask. */
	confirmMultiDay?: (request: MultiDayConfirmation) => Promise<boolean>;
	/** Optional manual-sync preview. Return false to cancel without writing. */
	preview?: (plan: SyncPlan) => Promise<boolean>;
	/** Receives the managed-section snapshot used by the undo command. */
	onApplied?: (snapshot: SyncUndoSnapshot) => void;
	/** Fired once preconditions pass and the coordinated run actually starts. */
	onStart?: () => void;
	/** Fired after every requested day is processed successfully. */
	onSuccess?: (dayCount: number) => void;
	/** Fired when a user closes or cancels the preview. */
	onCancelled?: () => void;
	/** Fired on a hard failure or failed precondition. */
	onError?: (message: string) => void;
	signal?: AbortSignal;
	/** Overrides the persisted create-missing/update-existing setting for one run. */
	existingOnly?: boolean;
}

interface CheckedResolution {
	checkedByDate: Map<string, Set<string>>;
	rules: Record<string, MultiDayCompletionRule>;
	rulesChanged: boolean;
}

interface PreparedSync {
	plan: SyncPlan;
	rules: Record<string, MultiDayCompletionRule>;
	rulesChanged: boolean;
}

class CategorizedSyncError extends Error {
	constructor(
		message: string,
		public readonly category: SyncFailureCategory,
		public readonly calendarId?: string
	) {
		super(message);
		this.name = "CategorizedSyncError";
	}
}

function classifyFailure(error: unknown): SyncFailureCategory {
	if (error instanceof ReconnectRequiredError) return "auth";
	if (error instanceof GoogleHttpError) {
		if (error.status === 401 || error.status === 403) return "auth";
		if (error.status === 429) return "quota";
		return "google";
	}
	if (error instanceof ICalHttpError) return "ical";
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	if (message.includes("template")) return "template";
	if (message.includes("marker")) return "markers";
	if (message.includes("network") || message.includes("fetch")) return "network";
	if (message.includes("vault") || message.includes("folder") || message.includes("file")) {
		return "vault";
	}
	return "unknown";
}

function enabledCalendarSources(deps: AuthDeps): EnabledCalendarSource[] {
	const google = deps.settings.googleAccounts.flatMap((account) =>
		account.calendars
			.filter((calendar) => calendar.enabled)
			.map((calendar) => ({
				kind: "google" as const,
				account,
				remoteId: calendar.id,
				config: { ...calendar, id: `google:${account.id}:${calendar.id}` },
			}))
	);
	const iCal = deps.settings.iCalCalendars
		.filter((calendar) => calendar.enabled)
		.map((calendar) => ({
			kind: "ical" as const,
			calendar,
			config: { ...calendar, id: `ical:${calendar.id}` },
		}));
	return [...google, ...iCal];
}

function cachedICalEvents(deps: AuthDeps, calendarId: string): GoogleEvent[] {
	const cache = deps.settings.iCalCaches[calendarId];
	if (!cache) return [];
	return Object.values(cache.events).flatMap((value) => {
		const candidate = value as unknown as GoogleEvent;
		return typeof candidate.summary === "string" && candidate.start && candidate.end
			? [candidate]
			: [];
	});
}

function eventKeysForDay(day: FetchedDay, rendering?: RenderingSettings): Set<string> {
	const keys = new Set<string>();
	for (const [calendarId, events] of day.eventsByCalendar) {
		for (const event of events) {
			if (rendering && !eventIsIncluded(event, rendering)) continue;
			const key = eventOccurrenceKey(calendarId, event);
			if (key) keys.add(key);
		}
	}
	return keys;
}

async function fetchDays(deps: AuthDeps, dates: DateToSync[], signal?: AbortSignal): Promise<FetchedDay[]> {
	const enabled = enabledCalendarSources(deps);
	const firstDate = dates.reduce((earliest, item) =>
		item.date.isBefore(earliest.date) ? item : earliest
	);
	const range = zonedDayRange(
		firstDate.date.year(),
		firstDate.date.month() + 1,
		firstDate.date.date(),
		deps.settings.timezone
	);
	const lastDate = dates.reduce((latest, item) => item.date.isAfter(latest.date) ? item : latest);
	const lastRange = zonedDayRange(lastDate.date.year(), lastDate.date.month() + 1, lastDate.date.date(), deps.settings.timezone);
	const eventsByCalendar = new Map<string, GoogleEvent[]>();
	for (const source of enabled) {
		try {
			const events = source.kind === "google"
				? await refreshCalendarCache(withGoogleAccount(deps, source.account.id), source.remoteId, range.start)
				: await refreshICalCalendar(deps, source.calendar, range.start, lastRange.end, signal);
			eventsByCalendar.set(source.config.id, events);
		} catch (error) {
			const category = source.kind === "ical" ? "ical" : classifyFailure(error);
			const dateKey = firstDate.date.format("YYYY-MM-DD");
			const reason = (error instanceof Error ? error.message : "Unknown calendar error.")
				.replace(/https?:\/\/\S+/g, "[redacted URL]");
			if (source.kind === "google") {
				source.account.calendarHealth[source.remoteId] = {
					...source.account.calendarHealth[source.remoteId],
					lastFailureAt: Date.now(),
					lastFailureCategory: category,
					lastFailureMessage: `Failed for range starting ${dateKey}: ${reason}`.slice(0, 300),
				};
			}
			throw new CategorizedSyncError(
				`Failed to fetch "${source.config.summary}" for range starting ${dateKey}: ${reason}`,
				category,
				source.config.id
			);
		}
	}
	const fetched = dates.map((input) => ({
		...input,
		dateKey: input.date.format("YYYY-MM-DD"),
			calendars: enabled.map((source) => source.config),
			eventsByCalendar: new Map(
				enabled.map((source) => [
					source.config.id,
					cachedEventsForDay(
						eventsByCalendar.get(source.config.id) ?? [],
					input.date,
					deps.settings.timezone
				),
			])
		),
	}));
	const now = Date.now();
	for (const source of enabled) {
		if (source.kind === "google") {
			source.account.calendarHealth[source.remoteId] = { lastSuccessAt: now };
		}
	}
	return fetched;
}

function collectMultiDayGroups(deps: AuthDeps, days: FetchedDay[]): MultiDayGroup[] {
	const groups = new Map<string, MultiDayGroup>();
	const checkboxCalendarIds = new Set(
		days.flatMap((day) => day.calendars)
			.filter((calendar) => calendar.addAs === "checkbox")
			.map((calendar) => calendar.id)
	);
	for (const day of days) {
		for (const [calendarId, events] of day.eventsByCalendar) {
			if (!checkboxCalendarIds.has(calendarId)) continue;
			for (const event of events) {
				const span = multiDaySpan(event, deps.settings.timezone);
				const eventKey = eventOccurrenceKey(calendarId, event);
				if (!span || !eventKey) continue;
				groups.set(eventKey, {
					eventKey,
					title: event.summary || "(untitled event)",
					span,
				});
			}
		}
	}
	return [...groups.values()];
}

async function resolveCheckedEvents(
	vault: Vault,
	deps: AuthDeps,
	days: FetchedDay[],
	opts: SyncOptions
): Promise<CheckedResolution> {
	const settings = deps.settings;
	const groups = collectMultiDayGroups(deps, days);
	const checkedByDate = new Map(days.map((day) => [day.dateKey, new Set<string>()]));
	const contentByDate = new Map<string, string | null>();
	const rules = { ...settings.multiDayCompletionRules };
	let rulesChanged = false;
	const readDate = async (dateKey: string): Promise<string | null> => {
		if (contentByDate.has(dateKey)) return contentByDate.get(dateKey) ?? null;
		const requested = days.find((day) => day.dateKey === dateKey);
		const path = notePathFor(settings, window.moment(dateKey, "YYYY-MM-DD"));
		const file = requested?.file ?? vault.getAbstractFileByPath(path);
		const content = file instanceof TFile ? await vault.read(file) : null;
		contentByDate.set(dateKey, content);
		return content;
	};
	const expiryCutoff = shiftDate(window.moment().format("YYYY-MM-DD"), -30);
	for (const [eventKey, rule] of Object.entries(rules)) {
		if (rule.eventEnd < expiryCutoff) {
			delete rules[eventKey];
			rulesChanged = true;
		}
	}
	for (const group of groups) {
		const spanDates = datesInSpan(group.span);
		const checkedDates: string[] = [];
		for (const dateKey of spanDates) {
			const content = await readDate(dateKey);
			if (content && isMultiDayEventChecked(content, group.eventKey)) checkedDates.push(dateKey);
		}
		let rule =
			settings.multiDayCompletionBehavior === "independent" ? undefined : rules[group.eventKey];
		if (rule && rule.eventEnd !== group.span.endDate) {
			rule = { ...rule, eventEnd: group.span.endDate };
			rules[group.eventKey] = rule;
			rulesChanged = true;
		}
		const completedFrom = checkedDates.sort()[0];
		const uncheckedFollowingDay =
			completedFrom &&
			spanDates.some((dateKey) => dateKey >= completedFrom && !checkedDates.includes(dateKey));
		if (!rule && uncheckedFollowingDay) {
			let propagate = settings.multiDayCompletionBehavior === "following";
			if (
				settings.multiDayCompletionBehavior === "ask" &&
				(opts.notify ?? true) &&
				opts.confirmMultiDay
			) {
				propagate = await opts.confirmMultiDay({
					eventKey: group.eventKey,
					title: group.title,
					completedFrom,
					eventEnd: group.span.endDate,
				});
			}
			if (propagate) {
				rule = { completedFrom, eventEnd: group.span.endDate };
				rules[group.eventKey] = rule;
				rulesChanged = true;
			}
		}
		for (const day of days) {
			const checkedByRule =
				rule !== undefined && day.dateKey >= rule.completedFrom && day.dateKey <= rule.eventEnd;
			if (checkedDates.includes(day.dateKey) || checkedByRule) {
				checkedByDate.get(day.dateKey)?.add(group.eventKey);
			}
		}
	}
	return { checkedByDate, rules, rulesChanged };
}

async function preflightFolder(vault: Vault, deps: AuthDeps): Promise<void> {
	const paths = [deps.settings.dailyNoteFolder.trim()].filter(Boolean);
	for (const folder of paths) {
		const existing = vault.getAbstractFileByPath(normalizePath(folder));
		if (existing && !(existing instanceof TFolder)) {
			throw new CategorizedSyncError(
				`Daily note folder path is occupied by a file: ${folder}`,
				"vault"
			);
		}
	}
}

async function prepareSync(
	vault: Vault,
	deps: AuthDeps,
	dates: DateToSync[],
	opts: SyncOptions
): Promise<PreparedSync> {
	await preflightFolder(vault, deps);
	const previousLocations = new Map<string, Set<string>>();
	for (const source of enabledCalendarSources(deps)) {
		const events = source.kind === "google"
			? calendarCacheEvents(withGoogleAccount(deps, source.account.id), source.remoteId)
			: cachedICalEvents(deps, source.calendar.id);
		for (const event of events) {
			const eventKey = eventOccurrenceKey(source.config.id, event);
			const dateKey = eventStartDate(event, deps.settings.timezone);
			if (!eventKey || !dateKey) continue;
			const dates = previousLocations.get(eventKey) ?? new Set<string>();
			dates.add(dateKey);
			previousLocations.set(eventKey, dates);
		}
	}
	const days = await fetchDays(deps, dates, opts.signal);
	const checked = await resolveCheckedEvents(vault, deps, days, opts);
	const localPreserved = new Map<string, Map<string, PreservedEventState>>();
	const globalPreserved = new Map<string, PreservedEventState>();
	for (const day of days) {
		const file = day.file ?? vault.getAbstractFileByPath(notePathFor(deps.settings, day.date));
		const preserved =
			file instanceof TFile
				? extractPreservedEvents(await vault.read(file))
				: new Map<string, PreservedEventState>();
		localPreserved.set(day.dateKey, preserved);
		for (const [key, state] of preserved) globalPreserved.set(key, state);
	}
	const currentKeys = new Set(
		days.flatMap((day) => [...eventKeysForDay(day, deps.settings.rendering)])
	);
	for (const eventKey of currentKeys) {
		if (globalPreserved.has(eventKey)) continue;
		for (const previousDate of previousLocations.get(eventKey) ?? []) {
			const sourcePath = notePathFor(
				deps.settings,
				window.moment(previousDate, "YYYY-MM-DD")
			);
			const sourceFile = vault.getAbstractFileByPath(sourcePath);
			if (!(sourceFile instanceof TFile)) continue;
			const state = extractPreservedEvents(await vault.read(sourceFile)).get(eventKey);
			if (state) {
				globalPreserved.set(eventKey, state);
				break;
			}
		}
	}
	const allRenderedKeys = currentKeys;
	const entries: SyncPlanEntry[] = [];
	for (const day of days) {
		const path = notePathFor(deps.settings, day.date);
		const abstractFile = day.file ?? vault.getAbstractFileByPath(path);
		if (abstractFile && !(abstractFile instanceof TFile)) {
			throw new CategorizedSyncError(`Target note path is not a file: ${path}`, "vault");
		}
		if (!abstractFile && (opts.existingOnly || deps.settings.noteCreationMode === "existing-only")) {
			entries.push({
				dateKey: day.dateKey,
				path,
				operation: "skip",
				beforeContent: null,
				afterContent: null,
				beforeSection: null,
				afterSection: null,
			});
			continue;
		}
		const beforeContent =
			abstractFile instanceof TFile
				? await vault.read(abstractFile)
				: await renderNewDailyNoteContent(vault, deps.settings, day.date);
		const preserved = new Map(localPreserved.get(day.dateKey) ?? []);
		for (const [calendarId, events] of day.eventsByCalendar) {
			for (const event of events) {
				if (!eventIsIncluded(event, deps.settings.rendering)) continue;
				const eventKey = eventOccurrenceKey(calendarId, event);
				const state = eventKey ? globalPreserved.get(eventKey) : undefined;
				if (eventKey && state && !preserved.has(eventKey)) {
					preserved.set(eventKey, {
						...state,
						// Multi-day completion is date-specific and is resolved separately above.
						checked: multiDaySpan(event, deps.settings.timezone) ? false : state.checked,
					});
				}
			}
		}
		const renderedBlock = renderCalendarBlock(
			day.calendars,
			day.eventsByCalendar,
			deps.settings.timezone,
			day.dateKey,
			checked.checkedByDate.get(day.dateKey),
			deps.settings.rendering,
			preserved,
			allRenderedKeys
		);
		const afterContent = replaceCalendarSectionContent(beforeContent, renderedBlock);
		if (afterContent === null) {
			throw new CategorizedSyncError(
				`Calendar markers not found in ${path}; note was not changed.`,
				"markers"
			);
		}
		entries.push({
			dateKey: day.dateKey,
			path,
			operation:
				abstractFile instanceof TFile
					? afterContent === beforeContent
						? "skip"
						: "change"
					: "create",
			beforeContent,
			afterContent,
			beforeSection: calendarSectionFromContent(beforeContent),
			afterSection: calendarSectionFromContent(afterContent),
		});
	}
	return {
		plan: { createdAt: Date.now(), entries, dayCount: days.length },
		rules: checked.rules,
		rulesChanged: checked.rulesChanged,
	};
}

async function verifyPlanIsCurrent(vault: Vault, plan: SyncPlan): Promise<void> {
	for (const entry of plan.entries) {
		if (entry.operation === "skip") continue;
		const file = vault.getAbstractFileByPath(entry.path);
		if (entry.operation === "create") {
			if (file) throw new Error(`${entry.path} appeared after preview; sync was cancelled safely.`);
			continue;
		}
		if (!(file instanceof TFile) || (await vault.read(file)) !== entry.beforeContent) {
			throw new Error(`${entry.path} changed after preview; sync was cancelled safely.`);
		}
	}
}

async function applyPlan(vault: Vault, deps: AuthDeps, prepared: PreparedSync): Promise<SyncUndoSnapshot> {
	await verifyPlanIsCurrent(vault, prepared.plan);
	const folders = new Set(
		prepared.plan.entries.flatMap((entry) => {
			const slash = entry.path.lastIndexOf("/");
			return entry.operation === "create" && slash > 0 ? [entry.path.slice(0, slash)] : [];
		})
	);
	for (const folder of [...folders].sort((left, right) => left.length - right.length)) {
		if (!vault.getAbstractFileByPath(normalizePath(folder))) {
			await vault.createFolder(normalizePath(folder));
		}
	}
	const applied: SyncPlanEntry[] = [];
	try {
		for (const entry of prepared.plan.entries) {
			if (entry.operation === "skip" || entry.afterContent === null) continue;
			if (entry.operation === "create") {
				await vault.create(entry.path, entry.afterContent);
			} else {
				const file = vault.getAbstractFileByPath(entry.path);
				if (!(file instanceof TFile)) throw new Error(`Target note disappeared: ${entry.path}`);
				await vault.modify(file, entry.afterContent);
			}
			applied.push(entry);
		}
	} catch (error) {
		for (const entry of applied.reverse()) {
			const file = vault.getAbstractFileByPath(entry.path);
			if (!(file instanceof TFile)) continue;
			try {
				if (entry.operation === "create" && deps.rollbackCreatedFile) {
					await deps.rollbackCreatedFile(file);
				} else if (entry.beforeContent !== null) {
					// Test/fallback dependencies retain the new note but restore its template placeholder.
					await vault.modify(file, entry.beforeContent);
				}
			} catch {
				// Preserve the original failure; diagnostics will identify the partially rolled-back note.
			}
		}
		throw error;
	}
	if (prepared.rulesChanged) deps.settings.multiDayCompletionRules = prepared.rules;
	deps.settings.lastSuccessfulSyncAt = Date.now();
	await deps.saveSettings();
	return {
		createdAt: Date.now(),
		entries: applied.flatMap((entry) =>
			entry.beforeSection !== null && entry.afterSection !== null
				? [
						{
							path: entry.path,
							beforeSection: entry.beforeSection,
							afterSection: entry.afterSection,
						},
					]
				: []
		),
	};
}

const syncQueues = new WeakMap<object, Promise<void>>();

async function coordinated(vault: Vault, task: () => Promise<void>): Promise<void> {
	const previous = syncQueues.get(vault) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(task);
	syncQueues.set(vault, current);
	try {
		await current;
	} finally {
		if (syncQueues.get(vault) === current) syncQueues.delete(vault);
	}
}

async function runDates(
	vault: Vault,
	deps: AuthDeps,
	dates: DateToSync[],
	opts: SyncOptions
): Promise<void> {
	const notify = opts.notify ?? true;
	const disconnected = deps.settings.googleAccounts.find(
		(account) => account.calendars.some((calendar) => calendar.enabled) && !isConnected(withGoogleAccount(deps, account.id))
	);
	if (disconnected) {
		const message = `connect the Google account "${disconnected.name}" first`;
		if (notify) new Notice(`DailyCalSync: ${message}.`);
		opts.onError?.(message);
		return;
	}
	if (enabledCalendarSources(deps).length === 0) {
		const message = "no calendars enabled";
		if (notify) new Notice(`DailyCalSync: ${message} — nothing to sync.`);
		opts.onError?.(message);
		return;
	}
	opts.onStart?.();
	try {
		const prepared = await prepareSync(vault, deps, dates, opts);
		// Cache tokens and per-calendar health are safe to persist even when note changes are declined.
		await deps.saveSettings();
		if (opts.preview && !(await opts.preview(prepared.plan))) {
			opts.onCancelled?.();
			return;
		}
		const snapshot = await applyPlan(vault, deps, prepared);
		opts.onApplied?.(snapshot);
		if (notify) {
			new Notice(
				`DailyCalSync: synced ${dates.length} day${dates.length === 1 ? "" : "s"}.`
			);
		}
		opts.onSuccess?.(dates.length);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown sync error.";
		const category =
			error instanceof CategorizedSyncError ? error.category : classifyFailure(error);
		deps.settings.recentFailures = [
			...deps.settings.recentFailures,
			{
				at: Date.now(),
				category,
				message: message.replace(/https?:\/\/\S+/g, "[redacted URL]").slice(0, 300),
			},
		].slice(-20);
		try {
			await deps.saveSettings();
		} catch {
			// The original categorized failure remains the useful error.
		}
		if (notify) new Notice(`DailyCalSync sync failed: ${message}`);
		else console.error("DailyCalSync: background sync failed", error);
		opts.onError?.(message);
	}
}

export async function syncDateRange(
	vault: Vault,
	deps: AuthDeps,
	start: Moment,
	end: Moment,
	opts: SyncOptions = {}
): Promise<void> {
	const first = start.clone().startOf("day");
	const last = end.clone().startOf("day");
	const ascendingStart = first.isAfter(last) ? last : first;
	const ascendingEnd = first.isAfter(last) ? first : last;
	const dayCount = ascendingEnd.diff(ascendingStart, "days") + 1;
	if (dayCount > MAX_SYNC_DAYS) {
		const message = `date range is limited to ${MAX_SYNC_DAYS} days`;
		if (opts.notify ?? true) new Notice(`DailyCalSync: ${message}.`);
		opts.onError?.(message);
		return;
	}
	const dates = Array.from({ length: dayCount }, (_, offset) => ({
		date: ascendingStart.clone().add(offset, "day"),
	}));
	return coordinated(vault, () => runDates(vault, deps, dates, opts));
}

/** Syncs today plus daysAhead, retaining the original public API. */
export async function syncRange(
	vault: Vault,
	deps: AuthDeps,
	daysAhead: number,
	opts: SyncOptions = {}
): Promise<void> {
	const normalized = Math.max(0, Math.floor(daysAhead));
	const today = window.moment().startOf("day");
	return syncDateRange(vault, deps, today, today.clone().add(normalized, "day"), opts);
}

export async function syncAll(vault: Vault, deps: AuthDeps, opts: SyncOptions = {}): Promise<void> {
	return syncRange(vault, deps, deps.settings.syncDaysAhead, opts);
}

/** Background sync never opens confirmation or preview UI. */
export async function autoSyncTick(
	vault: Vault,
	deps: AuthDeps,
	opts: SyncOptions = {}
): Promise<void> {
	return syncRange(vault, deps, deps.settings.syncDaysAhead, {
		...opts,
		notify: false,
		confirmMultiDay: undefined,
		preview: undefined,
		onApplied: undefined,
	});
}

/** Syncs a single already-created note through the same overlap coordinator. */
export async function syncSingleNote(
	vault: Vault,
	deps: AuthDeps,
	date: Moment,
	file: TFile
): Promise<void> {
	return coordinated(vault, () => runDates(vault, deps, [{ date, file }], { notify: true }));
}

/** Restores only managed calendar sections that have not changed since the corresponding sync. */
export async function undoSyncSnapshot(
	vault: Vault,
	snapshot: SyncUndoSnapshot
): Promise<{ restored: number; skipped: number }> {
	let restored = 0;
	let skipped = 0;
	for (const entry of snapshot.entries) {
		const file = vault.getAbstractFileByPath(entry.path);
		if (!(file instanceof TFile)) {
			skipped += 1;
			continue;
		}
		const content = await vault.read(file);
		if (calendarSectionFromContent(content) !== entry.afterSection) {
			skipped += 1;
			continue;
		}
		const restoredContent = replaceCalendarSectionContent(content, entry.beforeSection);
		if (restoredContent === null) {
			skipped += 1;
			continue;
		}
		await vault.modify(file, restoredContent);
		restored += 1;
	}
	return { restored, skipped };
}
