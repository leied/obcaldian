import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings";

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

	it("no longer carries a plaintext client secret or token fields", () => {
		expect(DEFAULT_SETTINGS).not.toHaveProperty("googleClientSecret");
		expect(DEFAULT_SETTINGS).not.toHaveProperty("tokens");
	});
});
