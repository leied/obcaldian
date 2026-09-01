import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, loadSettingsData } from "../src/settings";

describe("DEFAULT_SETTINGS", () => {
	it("defaults timezone to the system's IANA zone", () => {
		expect(DEFAULT_SETTINGS.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
	});

	it("defaults syncDaysAhead to 1", () => {
		expect(DEFAULT_SETTINGS.syncDaysAhead).toBe(1);
	});

	it("defaults automatic calendar checks to an infrequent three-hour interval", () => {
		expect(DEFAULT_SETTINGS.autoSyncIntervalMinutes).toBe(180);
	});

	it("asks before propagating multi-day completion by default", () => {
		expect(DEFAULT_SETTINGS.multiDayCompletionBehavior).toBe("ask");
		expect(DEFAULT_SETTINGS.multiDayCompletionRules).toEqual({});
	});

	it("no longer carries a plaintext client secret or token fields", () => {
		expect(DEFAULT_SETTINGS).not.toHaveProperty("googleClientSecret");
		expect(DEFAULT_SETTINGS).not.toHaveProperty("tokens");
	});
});

describe("loadSettingsData", () => {
	it("migrates legacy data and repairs malformed nested values", () => {
		const loaded = loadSettingsData({
			googleClientId: "  client  ",
			syncDaysAhead: -4,
			calendars: [
				{ id: "work", summary: "Work", enabled: true, addAs: "invalid" },
				{ id: "work", summary: "Duplicate", enabled: true, addAs: "bullet" },
			],
			multiDayCompletionRules: {
				good: { completedFrom: "2026-01-01", eventEnd: "2026-01-02" },
				bad: { completedFrom: "later", eventEnd: "earlier" },
			},
			rendering: { hourCycle: "impossible", showDescriptions: false },
		});
		expect(loaded.changed).toBe(true);
		expect(loaded.settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
		expect(loaded.settings.googleAccounts[0].clientId).toBe("client");
		expect(loaded.settings.syncDaysAhead).toBe(DEFAULT_SETTINGS.syncDaysAhead);
		expect(loaded.settings.googleAccounts[0].calendars).toHaveLength(1);
		expect(loaded.settings.googleAccounts[0].calendars[0].addAs).toBe("checkbox");
		expect(loaded.settings.onboardingComplete).toBe(true);
		expect(loaded.settings.multiDayCompletionRules).toEqual({
			good: { completedFrom: "2026-01-01", eventEnd: "2026-01-02" },
		});
		expect(loaded.settings.rendering.hourCycle).toBe("24");
		expect(loaded.settings.rendering.showDescriptions).toBe(false);
	});
});
