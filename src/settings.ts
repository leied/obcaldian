export const SETTINGS_SCHEMA_VERSION = 6;
export const LEGACY_GOOGLE_ACCOUNT_ID = "default-google";

export type AddAsStyle = "checkbox" | "bullet";
export type MultiDayCompletionBehavior = "independent" | "ask" | "following";
export type NoteCreationMode = "create-missing" | "existing-only";
export type HourCycleSetting = "system" | "12" | "24";

export interface MultiDayCompletionRule {
	completedFrom: string;
	eventEnd: string;
}

export interface CalendarConfig {
	id: string;
	summary: string;
	enabled: boolean;
	addAs: AddAsStyle;
	color?: string;
	colorId?: string;
}

export type SyncFailureCategory =
	| "auth"
	| "quota"
	| "network"
	| "google"
	| "ical"
	| "template"
	| "markers"
	| "vault"
	| "unknown";

export interface CalendarHealth {
	lastSuccessAt?: number;
	lastFailureAt?: number;
	lastFailureCategory?: SyncFailureCategory;
	lastFailureMessage?: string;
}

export interface CalendarEventCache {
	syncToken: string;
	coverageStart: string;
	updatedAt: number;
	events: Record<string, Record<string, unknown>>;
}

export interface ICalEventCache {
	updatedAt: number;
	etag?: string;
	lastModified?: string;
	events: Record<string, Record<string, unknown>>;
}

export interface GoogleAccountProfile {
	id: string;
	name: string;
	clientId: string;
	projectId: string;
	tokenExpiresAt?: number;
	calendars: CalendarConfig[];
	calendarHealth: Record<string, CalendarHealth>;
	calendarCaches: Record<string, CalendarEventCache>;
}

export interface ICalCalendarConfig extends CalendarConfig {
	/** Secret feed URLs live in Obsidian SecretStorage under this local identifier. */
	id: string;
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

export interface DailyCalSyncSettings {
	schemaVersion: number;
	onboardingComplete: boolean;
	googleAccounts: GoogleAccountProfile[];
	iCalCalendars: ICalCalendarConfig[];
	iCalCaches: Record<string, ICalEventCache>;
	dailyNoteFolder: string;
	templatePath: string;
	useDailyNotesSettings: boolean;
	dailyNoteFormat: string;
	noteCreationMode: NoteCreationMode;
	timezone: string;
	syncDaysAhead: number;
	autoSyncIntervalMinutes: number;
	multiDayCompletionBehavior: MultiDayCompletionBehavior;
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

export const DEFAULT_SETTINGS: DailyCalSyncSettings = {
	schemaVersion: SETTINGS_SCHEMA_VERSION,
	onboardingComplete: false,
	googleAccounts: [],
	iCalCalendars: [],
	iCalCaches: {},
	dailyNoteFolder: "",
	templatePath: "",
	useDailyNotesSettings: false,
	dailyNoteFormat: "YYYYMMDD",
	noteCreationMode: "create-missing",
	timezone: detectSystemTimezone(),
	syncDaysAhead: 1,
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

function validLocalId(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function normalizeCalendars(value: unknown): CalendarConfig[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const calendars: CalendarConfig[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id || seen.has(entry.id)) continue;
		seen.add(entry.id);
		calendars.push({
			id: entry.id,
			summary: stringValue(entry.summary, "(unnamed calendar)").slice(0, 200),
			enabled: booleanValue(entry.enabled, false),
			addAs: oneOf(entry.addAs, ["checkbox", "bullet"] as const, "checkbox"),
			...(typeof entry.color === "string" && /^#[0-9a-f]{6}$/i.test(entry.color) ? { color: entry.color } : {}),
			...(typeof entry.colorId === "string" && /^\d{1,2}$/.test(entry.colorId) ? { colorId: entry.colorId } : {}),
		});
	}
	return calendars;
}

function normalizeHealth(value: unknown): Record<string, CalendarHealth> {
	if (!isRecord(value)) return {};
	const health: Record<string, CalendarHealth> = {};
	for (const [calendarId, item] of Object.entries(value)) {
		if (!calendarId || !isRecord(item)) continue;
		const category = oneOf(item.lastFailureCategory, ["auth", "quota", "network", "google", "ical", "template", "markers", "vault", "unknown"] as const, "unknown");
		health[calendarId] = {
			lastSuccessAt: optionalTimestamp(item.lastSuccessAt),
			lastFailureAt: optionalTimestamp(item.lastFailureAt),
			...(item.lastFailureCategory ? { lastFailureCategory: category } : {}),
			...(typeof item.lastFailureMessage === "string" ? { lastFailureMessage: item.lastFailureMessage.slice(0, 300) } : {}),
		};
	}
	return health;
}

function normalizeCaches(value: unknown): Record<string, CalendarEventCache> {
	if (!isRecord(value)) return {};
	const caches: Record<string, CalendarEventCache> = {};
	for (const [calendarId, item] of Object.entries(value)) {
		if (!calendarId || !isRecord(item) || typeof item.syncToken !== "string" || !item.syncToken || typeof item.coverageStart !== "string" || !Number.isFinite(Date.parse(item.coverageStart)) || !isRecord(item.events)) continue;
		const events: Record<string, Record<string, unknown>> = {};
		for (const [eventKey, event] of Object.entries(item.events)) if (eventKey && isRecord(event)) events[eventKey] = event;
		caches[calendarId] = {
			syncToken: item.syncToken,
			coverageStart: item.coverageStart,
			updatedAt: optionalTimestamp(item.updatedAt) ?? Date.now(),
			events,
		};
	}
	return caches;
}

function normalizeICalCaches(value: unknown): Record<string, ICalEventCache> {
	if (!isRecord(value)) return {};
	const caches: Record<string, ICalEventCache> = {};
	for (const [calendarId, item] of Object.entries(value)) {
		if (!validLocalId(calendarId) || !isRecord(item) || !isRecord(item.events)) continue;
		const events: Record<string, Record<string, unknown>> = {};
		for (const [eventKey, event] of Object.entries(item.events)) if (eventKey && isRecord(event)) events[eventKey] = event;
		caches[calendarId] = {
			updatedAt: optionalTimestamp(item.updatedAt) ?? Date.now(),
			...(typeof item.etag === "string" ? { etag: item.etag.slice(0, 500) } : {}),
			...(typeof item.lastModified === "string" ? { lastModified: item.lastModified.slice(0, 200) } : {}),
			events,
		};
	}
	return caches;
}

function normalizeGoogleAccounts(value: unknown): GoogleAccountProfile[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const accounts: GoogleAccountProfile[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || !validLocalId(entry.id) || seen.has(entry.id)) continue;
		seen.add(entry.id);
		accounts.push({
			id: entry.id,
			name: stringValue(entry.name, "Google account").trim().slice(0, 100) || "Google account",
			clientId: stringValue(entry.clientId, "").trim(),
			projectId: stringValue(entry.projectId, "").trim(),
			tokenExpiresAt: optionalTimestamp(entry.tokenExpiresAt),
			calendars: normalizeCalendars(entry.calendars),
			calendarHealth: normalizeHealth(entry.calendarHealth),
			calendarCaches: normalizeCaches(entry.calendarCaches),
		});
	}
	return accounts;
}

function normalizeICalCalendars(value: unknown): ICalCalendarConfig[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const calendars: ICalCalendarConfig[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || !validLocalId(entry.id) || seen.has(entry.id)) continue;
		seen.add(entry.id);
		calendars.push({
			id: entry.id,
			summary: stringValue(entry.summary, "iCalendar feed").trim().slice(0, 200) || "iCalendar feed",
			enabled: booleanValue(entry.enabled, true),
			addAs: oneOf(entry.addAs, ["checkbox", "bullet"] as const, "checkbox"),
			...(typeof entry.color === "string" && /^#[0-9a-f]{6}$/i.test(entry.color) ? { color: entry.color } : {}),
		});
	}
	return calendars;
}

function normalizeRules(value: unknown): Record<string, MultiDayCompletionRule> {
	if (!isRecord(value)) return {};
	const rules: Record<string, MultiDayCompletionRule> = {};
	for (const [key, rule] of Object.entries(value)) {
		if (key && isRecord(rule) && validDateKey(rule.completedFrom) && validDateKey(rule.eventEnd) && rule.completedFrom <= rule.eventEnd) rules[key] = { completedFrom: rule.completedFrom, eventEnd: rule.eventEnd };
	}
	return rules;
}

function normalizeRecentFailures(value: unknown): RecentSyncFailure[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item) || typeof item.message !== "string") return [];
		const at = optionalTimestamp(item.at);
		if (!at) return [];
		return [{ at, category: oneOf(item.category, ["auth", "quota", "network", "google", "ical", "template", "markers", "vault", "unknown"] as const, "unknown"), message: item.message.slice(0, 300) }];
	}).slice(-20);
}

function normalizeRendering(value: unknown): RenderingSettings {
	const raw = isRecord(value) ? value : {};
	const defaults = DEFAULT_RENDERING_SETTINGS;
	return {
		allDayFirst: booleanValue(raw.allDayFirst, defaults.allDayFirst),
		showDescriptions: booleanValue(raw.showDescriptions, defaults.showDescriptions),
		showAttendees: booleanValue(raw.showAttendees, defaults.showAttendees),
		includeAttendeeEmails: booleanValue(raw.includeAttendeeEmails, defaults.includeAttendeeEmails),
		showLocations: booleanValue(raw.showLocations, defaults.showLocations),
		showMeetingLinks: booleanValue(raw.showMeetingLinks, defaults.showMeetingLinks),
		redactPrivateEvents: booleanValue(raw.redactPrivateEvents, defaults.redactPrivateEvents),
		includeDeclined: booleanValue(raw.includeDeclined, defaults.includeDeclined),
		includeCancelled: booleanValue(raw.includeCancelled, defaults.includeCancelled),
		includeFreeEvents: booleanValue(raw.includeFreeEvents, defaults.includeFreeEvents),
		includeFocusTime: booleanValue(raw.includeFocusTime, defaults.includeFocusTime),
		includeOutOfOffice: booleanValue(raw.includeOutOfOffice, defaults.includeOutOfOffice),
		includeWorkingLocation: booleanValue(raw.includeWorkingLocation, defaults.includeWorkingLocation),
		includeBirthdays: booleanValue(raw.includeBirthdays, defaults.includeBirthdays),
		locale: stringValue(raw.locale, defaults.locale).trim() || "system",
		hourCycle: oneOf(raw.hourCycle, ["system", "12", "24"] as const, defaults.hourCycle),
		showEndTime: booleanValue(raw.showEndTime, defaults.showEndTime),
		timeSeparator: stringValue(raw.timeSeparator, defaults.timeSeparator).slice(0, 8) || "-",
		useGoogleCalendarColors: booleanValue(raw.useGoogleCalendarColors, defaults.useGoogleCalendarColors),
	};
}

function migrateSettings(rawInput: UnknownRecord): UnknownRecord {
	const raw = { ...rawInput };
	let version = nonNegativeInteger(raw.schemaVersion, 0);
	if (version < 1) version = 1;
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
		raw.dailyNoteFormat = typeof raw.dailyNoteFormat === "string" && raw.dailyNoteFormat ? raw.dailyNoteFormat : "YYYYMMDD";
		version = 4;
	}
	if (version < 5) {
		raw.recentFailures = Array.isArray(raw.recentFailures) ? raw.recentFailures : [];
		version = 5;
	}
	if (version < 6) {
		const hadLegacyGoogle = Boolean(raw.googleClientId || raw.googleProjectId || raw.tokenExpiresAt || (Array.isArray(raw.calendars) && raw.calendars.length > 0));
		raw.googleAccounts = hadLegacyGoogle ? [{
			id: LEGACY_GOOGLE_ACCOUNT_ID,
			name: "Google account",
			clientId: raw.googleClientId,
			projectId: raw.googleProjectId,
			tokenExpiresAt: raw.tokenExpiresAt,
			calendars: raw.calendars,
			calendarHealth: raw.calendarHealth,
			calendarCaches: raw.calendarCaches,
		}] : [];
		raw.iCalCalendars = [];
		raw.iCalCaches = {};
		raw.onboardingComplete = Boolean(raw.templatePath || raw.useDailyNotesSettings || hadLegacyGoogle);
		version = 6;
	}
	raw.schemaVersion = Math.min(version, SETTINGS_SCHEMA_VERSION);
	return raw;
}

export function loadSettingsData(rawInput: unknown): { settings: DailyCalSyncSettings; changed: boolean } {
	const original = isRecord(rawInput) ? rawInput : {};
	const raw = migrateSettings(original);
	const settings: DailyCalSyncSettings = {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		onboardingComplete: booleanValue(raw.onboardingComplete, false),
		googleAccounts: normalizeGoogleAccounts(raw.googleAccounts),
		iCalCalendars: normalizeICalCalendars(raw.iCalCalendars),
		iCalCaches: normalizeICalCaches(raw.iCalCaches),
		dailyNoteFolder: stringValue(raw.dailyNoteFolder, ""),
		templatePath: stringValue(raw.templatePath, ""),
		useDailyNotesSettings: booleanValue(raw.useDailyNotesSettings, false),
		dailyNoteFormat: stringValue(raw.dailyNoteFormat, "YYYYMMDD").trim() || "YYYYMMDD",
		noteCreationMode: oneOf(raw.noteCreationMode, ["create-missing", "existing-only"] as const, "create-missing"),
		timezone: stringValue(raw.timezone, DEFAULT_SETTINGS.timezone),
		syncDaysAhead: nonNegativeInteger(raw.syncDaysAhead, DEFAULT_SETTINGS.syncDaysAhead),
		autoSyncIntervalMinutes: nonNegativeInteger(raw.autoSyncIntervalMinutes, DEFAULT_SETTINGS.autoSyncIntervalMinutes),
		multiDayCompletionBehavior: oneOf(raw.multiDayCompletionBehavior, ["independent", "ask", "following"] as const, "ask"),
		multiDayCompletionRules: normalizeRules(raw.multiDayCompletionRules),
		rendering: normalizeRendering(raw.rendering),
		lastSuccessfulSyncAt: optionalTimestamp(raw.lastSuccessfulSyncAt),
		recentFailures: normalizeRecentFailures(raw.recentFailures),
	};
	return { settings, changed: JSON.stringify(settings) !== JSON.stringify(original) };
}
