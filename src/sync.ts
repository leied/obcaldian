import { Notice, TFile, Vault } from "obsidian";
import type { Moment } from "moment";
import type { AuthDeps } from "./googleAuth";
import { isConnected } from "./googleAuth";
import { listEventsForDay, type GoogleEvent } from "./googleCalendar";
import {
	ensureDailyNote,
	notePathFor,
	renderCalendarBlock,
	syncNoteCalendarSection,
} from "./dailyNote";
import {
	datesInSpan,
	isMultiDayEventChecked,
	multiDayEventKey,
	multiDaySpan,
	shiftDate,
	type MultiDaySpan,
} from "./multiDay";

interface DateToSync {
	date: Moment;
	file?: TFile;
}

interface FetchedDay extends DateToSync {
	dateKey: string;
	eventsByCalendar: Map<string, GoogleEvent[]>;
}

interface MultiDayGroup {
	eventKey: string;
	title: string;
	span: MultiDaySpan;
}

export interface MultiDayConfirmation {
	eventKey: string;
	title: string;
	completedFrom: string;
	eventEnd: string;
}

export interface SyncOptions {
	/** Whether to surface progress/result as Notices. Defaults to true. Set false for silent background syncs. */
	notify?: boolean;
	/** UI callback used only by interactive syncs when multi-day behavior is "ask". */
	confirmMultiDay?: (request: MultiDayConfirmation) => Promise<boolean>;
	/** Fired once the connected/enabled-calendars checks pass, before any fetching starts. */
	onStart?: () => void;
	/** Fired after every requested day synced successfully. */
	onSuccess?: (dayCount: number) => void;
	/** Fired on a hard failure, or when the connected/enabled-calendars precondition fails. */
	onError?: (message: string) => void;
}

async function fetchDays(deps: AuthDeps, dates: DateToSync[]): Promise<FetchedDay[]> {
	const enabled = deps.settings.calendars.filter((calendar) => calendar.enabled);
	const fetched: FetchedDay[] = [];

	// Complete every network request before changing a note. A failed calendar/date therefore
	// cannot replace existing Markdown with a partial result.
	for (const input of dates) {
		const eventsByCalendar = new Map<string, GoogleEvent[]>();
		for (const calendar of enabled) {
			try {
				eventsByCalendar.set(
					calendar.id,
					await listEventsForDay(deps, calendar.id, input.date)
				);
			} catch (error) {
				throw new Error(
					`Failed to fetch "${calendar.summary}" for ${input.date.format("YYYY-MM-DD")}: ${(error as Error).message}`
				);
			}
		}
		fetched.push({ ...input, dateKey: input.date.format("YYYY-MM-DD"), eventsByCalendar });
	}
	return fetched;
}

function collectMultiDayGroups(deps: AuthDeps, days: FetchedDay[]): MultiDayGroup[] {
	const groups = new Map<string, MultiDayGroup>();
	const checkboxCalendarIds = new Set(
		deps.settings.calendars
			.filter((calendar) => calendar.enabled && calendar.addAs === "checkbox")
			.map((calendar) => calendar.id)
	);

	for (const day of days) {
		for (const [calendarId, events] of day.eventsByCalendar) {
			if (!checkboxCalendarIds.has(calendarId)) continue;
			for (const event of events) {
				const span = multiDaySpan(event, deps.settings.timezone);
				if (!span || !event.id) continue;
				const eventKey = multiDayEventKey(calendarId, event.id);
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
): Promise<{ checkedByDate: Map<string, Set<string>>; rulesChanged: boolean }> {
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

	// Rules are only useful shortly after their event. Expire them lazily without requiring a timer.
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
			if (content && isMultiDayEventChecked(content, group.eventKey)) {
				checkedDates.push(dateKey);
			}
		}

		let rule =
			settings.multiDayCompletionBehavior === "independent"
				? undefined
				: rules[group.eventKey];
		if (rule && rule.eventEnd !== group.span.endDate) {
			rule = { ...rule, eventEnd: group.span.endDate };
			rules[group.eventKey] = rule;
			rulesChanged = true;
		}

		const completedFrom = checkedDates.sort()[0];
		const uncheckedFollowingDay =
			completedFrom &&
			spanDates.some(
				(dateKey) => dateKey >= completedFrom && !checkedDates.includes(dateKey)
			);
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
				rule = {
					completedFrom,
					eventEnd: group.span.endDate,
				};
				rules[group.eventKey] = rule;
				rulesChanged = true;
			}
		}

		for (const day of days) {
			const checkedIndependently = checkedDates.includes(day.dateKey);
			const checkedByRule =
				rule !== undefined &&
				day.dateKey >= rule.completedFrom &&
				day.dateKey <= rule.eventEnd;
			if (checkedIndependently || checkedByRule) {
				checkedByDate.get(day.dateKey)?.add(group.eventKey);
			}
		}
	}

	if (rulesChanged) settings.multiDayCompletionRules = rules;
	return { checkedByDate, rulesChanged };
}

async function syncDates(
	vault: Vault,
	deps: AuthDeps,
	dates: DateToSync[],
	opts: SyncOptions
): Promise<void> {
	const days = await fetchDays(deps, dates);
	const { checkedByDate, rulesChanged } = await resolveCheckedEvents(vault, deps, days, opts);

	for (const day of days) {
		const block = renderCalendarBlock(
			deps.settings.calendars,
			day.eventsByCalendar,
			deps.settings.timezone,
			day.dateKey,
			checkedByDate.get(day.dateKey)
		);
		const noteFile = day.file ?? (await ensureDailyNote(vault, deps.settings, day.date));
		const updated = await syncNoteCalendarSection(vault, noteFile, block, false);
		if (!updated) {
			throw new Error(`Calendar markers not found in ${noteFile.path}; note was not changed.`);
		}
	}

	if (rulesChanged) await deps.saveSettings();
}

/** Syncs today plus `daysAhead`, creating notes from the template when needed. */
export async function syncRange(
	vault: Vault,
	deps: AuthDeps,
	daysAhead: number,
	opts: SyncOptions = {}
): Promise<void> {
	const notify = opts.notify ?? true;

	if (!isConnected(deps)) {
		const message = "connect your Google account first";
		if (notify) new Notice(`Obcaldian: ${message}.`);
		opts.onError?.(message);
		return;
	}
	if (deps.settings.calendars.filter((calendar) => calendar.enabled).length === 0) {
		const message = "no calendars enabled";
		if (notify) new Notice(`Obcaldian: ${message} — nothing to sync.`);
		opts.onError?.(message);
		return;
	}

	const dayCount = Math.max(0, Math.floor(daysAhead)) + 1;
	opts.onStart?.();

	try {
		const dates = Array.from({ length: dayCount }, (_, offset) => ({
			date: window.moment().add(offset, "day"),
		}));
		await syncDates(vault, deps, dates, { ...opts, notify });
		if (notify) {
			new Notice(`Obcaldian: synced ${dayCount} day${dayCount === 1 ? "" : "s"}.`);
		}
		opts.onSuccess?.(dayCount);
	} catch (error) {
		const message = (error as Error).message;
		if (notify) {
			new Notice(`Obcaldian sync failed: ${message}`);
		} else {
			console.error("Obcaldian: background sync failed", error);
		}
		opts.onError?.(message);
	}
}

export async function syncAll(vault: Vault, deps: AuthDeps, opts: SyncOptions = {}): Promise<void> {
	return syncRange(vault, deps, deps.settings.syncDaysAhead, opts);
}

/** Background sync never opens a multi-day confirmation modal. */
export async function autoSyncTick(
	vault: Vault,
	deps: AuthDeps,
	opts: SyncOptions = {}
): Promise<void> {
	return syncRange(vault, deps, deps.settings.syncDaysAhead, {
		...opts,
		notify: false,
		confirmMultiDay: undefined,
	});
}

/** Syncs a single, already-created note (used right after it's generated). */
export async function syncSingleNote(
	vault: Vault,
	deps: AuthDeps,
	date: Moment,
	file: TFile
): Promise<void> {
	if (!isConnected(deps)) return;
	if (deps.settings.calendars.filter((calendar) => calendar.enabled).length === 0) return;
	try {
		await syncDates(vault, deps, [{ date, file }], { notify: true });
	} catch (error) {
		new Notice(`Obcaldian: initial calendar sync failed: ${(error as Error).message}`);
	}
}
