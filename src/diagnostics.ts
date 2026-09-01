import { Platform, apiVersion } from "obsidian";
import { ALLOWED_OUTBOUND_HOSTS } from "./network";
import type { ObcaldianSettings } from "./settings";

function platformName(): string {
	if (Platform.isMacOS) return "macOS";
	if (Platform.isWin) return "Windows";
	if (Platform.isLinux) return "Linux";
	return Platform.isDesktopApp ? "Desktop" : "Unsupported platform";
}

export function buildRedactedDiagnostics(
	pluginVersion: string,
	settings: ObcaldianSettings
): string {
	const enabledCalendars = settings.calendars.filter((calendar) => calendar.enabled);
	const failures = settings.recentFailures.map(
		(failure) =>
			`- ${failure.category} at ${new Date(failure.at).toISOString()} — ${failure.message}`
	);
	return [
		"Obcaldian diagnostics (redacted)",
		`Plugin version: ${pluginVersion}`,
		`Obsidian API version: ${apiVersion}`,
		`Platform: ${platformName()}`,
		`Timezone: ${settings.timezone}`,
		`Enabled calendars: ${enabledCalendars.length}`,
		`Daily note folder: ${settings.dailyNoteFolder || "(vault root)"}`,
		`Template path: ${settings.templatePath || "(not configured)"}`,
		`Filename format: ${settings.dailyNoteFormat}`,
		`Last successful sync: ${settings.lastSuccessfulSyncAt ? new Date(settings.lastSuccessfulSyncAt).toISOString() : "never"}`,
		`Network hosts: ${[...ALLOWED_OUTBOUND_HOSTS].sort().join(", ")}, 127.0.0.1`,
		"Recent categorized failures:",
		...(failures.length ? failures : ["- None recorded"]),
		"",
		"Excluded: credentials, tokens, calendar/event IDs, event text, attendee data, and URLs.",
	].join("\n");
}

export async function copyRedactedDiagnostics(
	pluginVersion: string,
	settings: ObcaldianSettings
): Promise<void> {
	await window.navigator.clipboard.writeText(
		buildRedactedDiagnostics(pluginVersion, settings)
	);
}
