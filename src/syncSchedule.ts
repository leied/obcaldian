import type { DailyCalSyncSettings } from "./settings";

type AutomaticCatchUpSettings = Pick<
	DailyCalSyncSettings,
	"autoSyncIntervalMinutes" | "googleAccounts" | "iCalCalendars" | "lastSuccessfulSyncAt"
>;

/** Whether an automatic startup/resume/online catch-up is enabled and overdue. */
export function shouldRunAutomaticCatchUp(
	settings: AutomaticCatchUpSettings,
	now = Date.now()
): boolean {
	if (settings.autoSyncIntervalMinutes <= 0) return false;
	const hasEnabledSource =
		settings.googleAccounts.some((account) =>
			account.calendars.some((calendar) => calendar.enabled)
		) || settings.iCalCalendars.some((calendar) => calendar.enabled);
	if (!hasEnabledSource) return false;
	const lastSuccess = settings.lastSuccessfulSyncAt ?? 0;
	return now - lastSuccess >= settings.autoSyncIntervalMinutes * 60_000;
}
