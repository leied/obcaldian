export type AddAsStyle = "checkbox" | "bullet";

export interface CalendarConfig {
	id: string;
	summary: string;
	enabled: boolean;
	addAs: AddAsStyle;
}

export interface GoogleTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // epoch ms
}

export interface ObcaldianSettings {
	googleClientId: string;
	googleClientSecret: string;
	tokens?: GoogleTokens;
	calendars: CalendarConfig[];
	dailyNoteFolder: string;
	templatePath: string;
}

export const DEFAULT_SETTINGS: ObcaldianSettings = {
	googleClientId: "",
	googleClientSecret: "",
	tokens: undefined,
	calendars: [],
	dailyNoteFolder: "",
	templatePath: "",
};
