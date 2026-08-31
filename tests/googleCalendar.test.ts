import { requestUrl, SecretStorage } from "obsidian";
import moment from "moment";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthDeps } from "../src/googleAuth";
import { listCalendars, listEventsForDay } from "../src/googleCalendar";
import { DEFAULT_SETTINGS } from "../src/settings";

vi.mock("../src/googleAuth", () => ({
	getValidAccessToken: vi.fn(async () => "access-token"),
}));

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<typeof import("obsidian")>()),
	requestUrl: vi.fn(),
}));

function deps(): AuthDeps {
	return {
		settings: { ...DEFAULT_SETTINGS, timezone: "UTC" },
		saveSettings: async () => {},
		secretStorage: new SecretStorage(),
	};
}

beforeEach(() => {
	vi.mocked(requestUrl).mockReset();
});

describe("Google Calendar pagination", () => {
	it("loads every page of the calendar list", async () => {
		vi.mocked(requestUrl)
			.mockResolvedValueOnce({
				json: { items: [{ id: "one", summary: "One" }], nextPageToken: "next token" },
			} as never)
			.mockResolvedValueOnce({
				json: { items: [{ id: "two", summary: "Two" }] },
			} as never);

		await expect(listCalendars(deps())).resolves.toEqual([
			{ id: "one", summary: "One" },
			{ id: "two", summary: "Two" },
		]);
		expect(vi.mocked(requestUrl).mock.calls[1][0].url).toContain("pageToken=next+token");
	});

	it("loads every page of a day's events without dropping query parameters", async () => {
		vi.mocked(requestUrl)
			.mockResolvedValueOnce({
				json: {
					items: [{ summary: "First", start: {}, end: {} }],
					nextPageToken: "page-2",
				},
			} as never)
			.mockResolvedValueOnce({
				json: { items: [{ summary: "Second", start: {}, end: {} }] },
			} as never);

		const events = await listEventsForDay(deps(), "work@example.com", moment("2026-07-22"));

		expect(events.map((event) => event.summary)).toEqual(["First", "Second"]);
		const secondUrl = vi.mocked(requestUrl).mock.calls[1][0].url;
		expect(secondUrl).toContain("singleEvents=true");
		expect(secondUrl).toContain("pageToken=page-2");
		expect(secondUrl).toContain("calendars/work%40example.com/events");
	});
});
