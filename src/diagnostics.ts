import { Platform, apiVersion } from "obsidian";
import { ALLOWED_OUTBOUND_HOSTS } from "./network";
import type { DailyCalSyncSettings } from "./settings";

function platformName(): string {
	if (Platform.isMacOS) return "macOS";
	if (Platform.isWin) return "Windows";
	if (Platform.isLinux) return "Linux";
	return Platform.isDesktopApp ? "Desktop" : "Unsupported platform";
}

export function buildRedactedDiagnostics(
	pluginVersion: string,
	settings: DailyCalSyncSettings
): string {
	const enabledGoogleCalendars = settings.googleAccounts.reduce(
		(total, account) => total + account.calendars.filter((calendar) => calendar.enabled).length,
		0
	);
	const enabledICalCalendars = settings.iCalCalendars.filter((calendar) => calendar.enabled).length;
	const failures = settings.recentFailures.map(
		(failure) =>
			`- ${failure.category} at ${new Date(failure.at).toISOString()} — ${failure.message}`
	);
	return [
		"DailyCalSync diagnostics (redacted)",
		`Plugin version: ${pluginVersion}`,
		`Obsidian API version: ${apiVersion}`,
		`Platform: ${platformName()}`,
		`Timezone: ${settings.timezone}`,
		`Google account profiles: ${settings.googleAccounts.length}`,
		`Enabled Google calendars: ${enabledGoogleCalendars}`,
		`Enabled iCalendar feeds: ${enabledICalCalendars}`,
		`Daily note folder: ${settings.dailyNoteFolder || "(vault root)"}`,
		`Template path: ${settings.templatePath || "(not configured)"}`,
		`Filename format: ${settings.dailyNoteFormat}`,
		`Last successful sync: ${settings.lastSuccessfulSyncAt ? new Date(settings.lastSuccessfulSyncAt).toISOString() : "never"}`,
		`Fixed network hosts: ${[...ALLOWED_OUTBOUND_HOSTS].sort().join(", ")}, 127.0.0.1`,
		"User-configured iCalendar hosts: redacted",
		"Recent categorized failures:",
		...(failures.length ? failures : ["- None recorded"]),
		"",
		"Excluded: credentials, tokens, calendar/event IDs, event text, attendee data, and URLs.",
	].join("\n");
}

export async function copyRedactedDiagnostics(
	pluginVersion: string,
	settings: DailyCalSyncSettings
): Promise<void> {
	await window.navigator.clipboard.writeText(
		buildRedactedDiagnostics(pluginVersion, settings)
	);
}
