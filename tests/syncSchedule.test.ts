import { describe, expect, it } from "vitest";
import { shouldRunAutomaticCatchUp } from "../src/syncSchedule";
import { DEFAULT_SETTINGS } from "../src/settings";

function settings(interval: number, lastSuccessfulSyncAt?: number) {
	return {
		...DEFAULT_SETTINGS,
		autoSyncIntervalMinutes: interval,
		lastSuccessfulSyncAt,
		googleAccounts: [],
		iCalCalendars: [{
			id: "feed",
			summary: "Feed",
			enabled: true,
			addAs: "checkbox" as const,
		}],
	};
}

describe("automatic catch-up scheduling", () => {
	it("does not run startup, resume, or online catch-up when auto-sync is off", () => {
		expect(shouldRunAutomaticCatchUp(settings(0), Date.UTC(2026, 8, 15))).toBe(false);
	});

	it("runs only when an enabled source is overdue", () => {
		const now = Date.UTC(2026, 8, 15, 12);
		expect(shouldRunAutomaticCatchUp(settings(60, now - 60 * 60_000), now)).toBe(true);
		expect(shouldRunAutomaticCatchUp(settings(60, now - 59 * 60_000), now)).toBe(false);
		expect(shouldRunAutomaticCatchUp({
			...settings(60),
			iCalCalendars: [],
		}, now)).toBe(false);
	});
});
