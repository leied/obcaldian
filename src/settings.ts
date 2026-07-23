export type AddAsStyle = "checkbox" | "bullet";

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
	autoSyncIntervalMinutes: 0,
};
