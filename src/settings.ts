export const SETTINGS_SCHEMA_VERSION = 5;

export type AddAsStyle = "checkbox" | "bullet";
export type MultiDayCompletionBehavior = "independent" | "ask" | "following";
export type NoteCreationMode = "create-missing" | "existing-only";
export type HourCycleSetting = "system" | "12" | "24";

export interface MultiDayCompletionRule {
	/** First YYYY-MM-DD occurrence that should render checked. Earlier days stay unchanged. */
	completedFrom: string;
	/** Inclusive YYYY-MM-DD final occurrence, used to expire old rules. */
	eventEnd: string;
}

export interface CalendarConfig {
	id: string;
	summary: string;
	enabled: boolean;
	addAs: AddAsStyle;
	/** Optional CSS color supplied by Google or chosen by the user. */
	color?: string;
	/** Google Calendar color palette identifier, rendered through a stable CSS class. */
	colorId?: string;
}

export type SyncFailureCategory =
	| "auth"
	| "quota"
	| "network"
	| "google"
	| "template"
	| "markers"
	| "vault"
	| "unknown";

export interface CalendarHealth {
	lastSuccessAt?: number;
	lastFailureAt?: number;
	lastFailureCategory?: SyncFailureCategory;
	/** Redacted, user-actionable summary. Never persist event data or identifiers here. */
	lastFailureMessage?: string;
}

export interface CalendarEventCache {
	syncToken: string;
	/** Earliest instant included by the most recent full sync. */
	coverageStart: string;
	updatedAt: number;
	/** Raw Google Event resources, validated again before use. */
	events: Record<string, Record<string, unknown>>;
}

export interface RecentSyncFailure {
	at: number;
	category: SyncFailureCategory;
	message: string;
}

export interface RenderingSettings {
	allDayFirst: boolean;
	showDescriptions: boolean;
	showAttendees: boolean;
	includeAttendeeEmails: boolean;
	showLocations: boolean;
	showMeetingLinks: boolean;
	redactPrivateEvents: boolean;
	includeDeclined: boolean;
	includeCancelled: boolean;
	includeFreeEvents: boolean;
	includeFocusTime: boolean;
	includeOutOfOffice: boolean;
	includeWorkingLocation: boolean;
	includeBirthdays: boolean;
	locale: string;
	hourCycle: HourCycleSetting;
	showEndTime: boolean;
	timeSeparator: string;
	useGoogleCalendarColors: boolean;
}

export interface ObcaldianSettings {
	schemaVersion: number;
	googleClientId: string;
	googleProjectId: string;
	/**
	 * Epoch ms the current Google access token expires at. The access/refresh
	 * token strings themselves, and the client secret, live in Obsidian's
	 * secret storage (see googleAuth.ts) rather than here, since this object
	 * is persisted to plugin data.json in plain text.
	 */
	tokenExpiresAt?: number;
	calendars: CalendarConfig[];
	calendarHealth: Record<string, CalendarHealth>;
	calendarCaches: Record<string, CalendarEventCache>;
	dailyNoteFolder: string;
	templatePath: string;
	useDailyNotesSettings: boolean;
	dailyNoteFormat: string;
	noteCreationMode: NoteCreationMode;
	/** IANA time zone used to align calendar sync day boundaries with Google. */
	timezone: string;
	/** Default number of days beyond today that a sync covers. */
	syncDaysAhead: number;
	/** Minutes between automatic background syncs. 0 disables auto-sync. */
	autoSyncIntervalMinutes: number;
	/** How checking one occurrence of a multi-day event affects later occurrences. */
	multiDayCompletionBehavior: MultiDayCompletionBehavior;
	/** Persisted propagation rules ensure not-yet-synced dates are handled later. */
	multiDayCompletionRules: Record<string, MultiDayCompletionRule>;
	rendering: RenderingSettings;
	lastSuccessfulSyncAt?: number;
	recentFailures: RecentSyncFailure[];
}

function detectSystemTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

export const DEFAULT_RENDERING_SETTINGS: RenderingSettings = {
	allDayFirst: true,
	showDescriptions: true,
	showAttendees: true,
	includeAttendeeEmails: true,
	showLocations: true,
	showMeetingLinks: true,
	redactPrivateEvents: false,
	includeDeclined: false,
	includeCancelled: false,
	includeFreeEvents: true,
	includeFocusTime: true,
	includeOutOfOffice: true,
	includeWorkingLocation: true,
	includeBirthdays: true,
	locale: "system",
	hourCycle: "24",
	showEndTime: true,
	timeSeparator: "-",
	useGoogleCalendarColors: true,
};

export const DEFAULT_SETTINGS: ObcaldianSettings = {
	schemaVersion: SETTINGS_SCHEMA_VERSION,
	googleClientId: "",
	googleProjectId: "",
	tokenExpiresAt: undefined,
	calendars: [],
	calendarHealth: {},
	calendarCaches: {},
	dailyNoteFolder: "",
	templatePath: "",
	useDailyNotesSettings: false,
	dailyNoteFormat: "YYYYMMDD",
	noteCreationMode: "create-missing",
	timezone: detectSystemTimezone(),
	syncDaysAhead: 1,
	// Keep new installations reasonably fresh without polling Google aggressively.
	autoSyncIntervalMinutes: 180,
	multiDayCompletionBehavior: "ask",
	multiDayCompletionRules: {},
	rendering: DEFAULT_RENDERING_SETTINGS,
	lastSuccessfulSyncAt: undefined,
	recentFailures: [],
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: fallback;
}

function optionalTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function validDateKey(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeCalendars(value: unknown): CalendarConfig[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const calendars: CalendarConfig[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id || seen.has(entry.id)) {
			continue;
		}
		seen.add(entry.id);
		calendars.push({
			id: entry.id,
			summary: stringValue(entry.summary, "(unnamed calendar)"),
			enabled: booleanValue(entry.enabled, false),
			addAs: oneOf(entry.addAs, ["checkbox", "bullet"] as const, "checkbox"),
			...(typeof entry.color === "string" && /^#[0-9a-f]{6}$/i.test(entry.color)
				? { color: entry.color }
				: {}),
			...(typeof entry.colorId === "string" && /^\d{1,2}$/.test(entry.colorId)
				? { colorId: entry.colorId }
				: {}),
		});
	}
	return calendars;
}

function normalizeRules(value: unknown): Record<string, MultiDayCompletionRule> {
	if (!isRecord(value)) return {};
	const rules: Record<string, MultiDayCompletionRule> = {};
	for (const [key, rule] of Object.entries(value)) {
		if (
			key &&
			isRecord(rule) &&
			validDateKey(rule.completedFrom) &&
			validDateKey(rule.eventEnd) &&
			rule.completedFrom <= rule.eventEnd
		) {
			rules[key] = { completedFrom: rule.completedFrom, eventEnd: rule.eventEnd };
		}
	}
	return rules;
}

function normalizeHealth(value: unknown): Record<string, CalendarHealth> {
	if (!isRecord(value)) return {};
	const health: Record<string, CalendarHealth> = {};
	for (const [calendarId, item] of Object.entries(value)) {
		if (!calendarId || !isRecord(item)) continue;
		const category = oneOf(
			item.lastFailureCategory,
			["auth", "quota", "network", "google", "template", "markers", "vault", "unknown"] as const,
			"unknown"
		);
		health[calendarId] = {
			lastSuccessAt: optionalTimestamp(item.lastSuccessAt),
			lastFailureAt: optionalTimestamp(item.lastFailureAt),
			...(item.lastFailureCategory ? { lastFailureCategory: category } : {}),
			...(typeof item.lastFailureMessage === "string"
				? { lastFailureMessage: item.lastFailureMessage.slice(0, 300) }
				: {}),
		};
	}
	return health;
}

function normalizeCaches(value: unknown): Record<string, CalendarEventCache> {
	if (!isRecord(value)) return {};
	const caches: Record<string, CalendarEventCache> = {};
	for (const [calendarId, item] of Object.entries(value)) {
		if (
			!calendarId ||
			!isRecord(item) ||
			typeof item.syncToken !== "string" ||
			!item.syncToken ||
			typeof item.coverageStart !== "string" ||
			!Number.isFinite(Date.parse(item.coverageStart)) ||
			!isRecord(item.events)
		) {
			continue;
		}
		const events: Record<string, Record<string, unknown>> = {};
		for (const [eventKey, event] of Object.entries(item.events)) {
			if (eventKey && isRecord(event)) events[eventKey] = event;
		}
		caches[calendarId] = {
			syncToken: item.syncToken,
			coverageStart: item.coverageStart,
			updatedAt: optionalTimestamp(item.updatedAt) ?? Date.now(),
			events,
		};
	}
	return caches;
}

function normalizeRecentFailures(value: unknown): RecentSyncFailure[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item) || typeof item.message !== "string") return [];
		const at = optionalTimestamp(item.at);
		if (!at) return [];
		return [
			{
				at,
				category: oneOf(
					item.category,
					["auth", "quota", "network", "google", "template", "markers", "vault", "unknown"] as const,
					"unknown"
				),
				message: item.message.slice(0, 300),
			},
		];
	}).slice(-20);
}

function normalizeRendering(value: unknown): RenderingSettings {
	const raw = isRecord(value) ? value : {};
	const defaults = DEFAULT_RENDERING_SETTINGS;
	return {
		allDayFirst: booleanValue(raw.allDayFirst, defaults.allDayFirst),
		showDescriptions: booleanValue(raw.showDescriptions, defaults.showDescriptions),
		showAttendees: booleanValue(raw.showAttendees, defaults.showAttendees),
		includeAttendeeEmails: booleanValue(
			raw.includeAttendeeEmails,
			defaults.includeAttendeeEmails
		),
		showLocations: booleanValue(raw.showLocations, defaults.showLocations),
		showMeetingLinks: booleanValue(raw.showMeetingLinks, defaults.showMeetingLinks),
		redactPrivateEvents: booleanValue(raw.redactPrivateEvents, defaults.redactPrivateEvents),
		includeDeclined: booleanValue(raw.includeDeclined, defaults.includeDeclined),
		includeCancelled: booleanValue(raw.includeCancelled, defaults.includeCancelled),
		includeFreeEvents: booleanValue(raw.includeFreeEvents, defaults.includeFreeEvents),
		includeFocusTime: booleanValue(raw.includeFocusTime, defaults.includeFocusTime),
		includeOutOfOffice: booleanValue(raw.includeOutOfOffice, defaults.includeOutOfOffice),
		includeWorkingLocation: booleanValue(
			raw.includeWorkingLocation,
			defaults.includeWorkingLocation
		),
		includeBirthdays: booleanValue(raw.includeBirthdays, defaults.includeBirthdays),
		locale: stringValue(raw.locale, defaults.locale).trim() || "system",
		hourCycle: oneOf(raw.hourCycle, ["system", "12", "24"] as const, defaults.hourCycle),
		showEndTime: booleanValue(raw.showEndTime, defaults.showEndTime),
		timeSeparator: stringValue(raw.timeSeparator, defaults.timeSeparator).slice(0, 8) || "–",
		useGoogleCalendarColors: booleanValue(
			raw.useGoogleCalendarColors,
			defaults.useGoogleCalendarColors
		),
	};
}

/** Sequential structural migrations. Secrets are migrated separately before this function runs. */
function migrateSettings(rawInput: UnknownRecord): UnknownRecord {
	const raw = { ...rawInput };
	let version = nonNegativeInteger(raw.schemaVersion, 0);
	if (version < 1) {
		// Version 1 names the pre-schema settings shape; normalization supplies missing values.
		version = 1;
	}
	if (version < 2) {
		raw.rendering = isRecord(raw.rendering) ? raw.rendering : {};
		raw.calendarHealth = isRecord(raw.calendarHealth) ? raw.calendarHealth : {};
		version = 2;
	}
	if (version < 3) {
		raw.calendarCaches = isRecord(raw.calendarCaches) ? raw.calendarCaches : {};
		version = 3;
	}
	if (version < 4) {
		raw.dailyNoteFormat =
			typeof raw.dailyNoteFormat === "string" && raw.dailyNoteFormat
				? raw.dailyNoteFormat
				: "YYYYMMDD";
		version = 4;
	}
	if (version < 5) {
		raw.recentFailures = Array.isArray(raw.recentFailures) ? raw.recentFailures : [];
		version = 5;
	}
	raw.schemaVersion = Math.min(version, SETTINGS_SCHEMA_VERSION);
	return raw;
}

/** Returns a fully validated settings object and whether repaired data should be persisted. */
export function loadSettingsData(rawInput: unknown): {
	settings: ObcaldianSettings;
	changed: boolean;
} {
	const original = isRecord(rawInput) ? rawInput : {};
	const raw = migrateSettings(original);
	const settings: ObcaldianSettings = {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		googleClientId: stringValue(raw.googleClientId, "").trim(),
		googleProjectId: stringValue(raw.googleProjectId, "").trim(),
		tokenExpiresAt: optionalTimestamp(raw.tokenExpiresAt),
		calendars: normalizeCalendars(raw.calendars),
		calendarHealth: normalizeHealth(raw.calendarHealth),
		calendarCaches: normalizeCaches(raw.calendarCaches),
		dailyNoteFolder: stringValue(raw.dailyNoteFolder, ""),
		templatePath: stringValue(raw.templatePath, ""),
		useDailyNotesSettings: booleanValue(raw.useDailyNotesSettings, false),
		dailyNoteFormat: stringValue(raw.dailyNoteFormat, "YYYYMMDD").trim() || "YYYYMMDD",
		noteCreationMode: oneOf(
			raw.noteCreationMode,
			["create-missing", "existing-only"] as const,
			"create-missing"
		),
		timezone: stringValue(raw.timezone, DEFAULT_SETTINGS.timezone),
		syncDaysAhead: nonNegativeInteger(raw.syncDaysAhead, DEFAULT_SETTINGS.syncDaysAhead),
		autoSyncIntervalMinutes: nonNegativeInteger(
			raw.autoSyncIntervalMinutes,
			DEFAULT_SETTINGS.autoSyncIntervalMinutes
		),
		multiDayCompletionBehavior: oneOf(
			raw.multiDayCompletionBehavior,
			["independent", "ask", "following"] as const,
			"ask"
		),
		multiDayCompletionRules: normalizeRules(raw.multiDayCompletionRules),
		rendering: normalizeRendering(raw.rendering),
		lastSuccessfulSyncAt: optionalTimestamp(raw.lastSuccessfulSyncAt),
		recentFailures: normalizeRecentFailures(raw.recentFailures),
	};
	return { settings, changed: JSON.stringify(settings) !== JSON.stringify(original) };
}
