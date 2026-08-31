export type AddAsStyle = "checkbox" | "bullet";
export type MultiDayCompletionBehavior = "independent" | "ask" | "following";

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
}

export interface ObcaldianSettings {
	googleClientId: string;
	/**
	 * Epoch ms the current Google access token expires at. The access/refresh
	 * token strings themselves, and the client secret, live in Obsidian's
	 * secret storage (see googleAuth.ts) rather than here, since this object
	 * is persisted to plugin data.json in plain text.
	 */
	tokenExpiresAt?: number;
	calendars: CalendarConfig[];
	dailyNoteFolder: string;
	templatePath: string;
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
}

function detectSystemTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

export const DEFAULT_SETTINGS: ObcaldianSettings = {
	googleClientId: "",
	tokenExpiresAt: undefined,
	calendars: [],
	dailyNoteFolder: "",
	templatePath: "",
	timezone: detectSystemTimezone(),
	syncDaysAhead: 1,
	// Keep new installations reasonably fresh without polling Google aggressively.
	autoSyncIntervalMinutes: 180,
	multiDayCompletionBehavior: "ask",
	multiDayCompletionRules: {},
};
