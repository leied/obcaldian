import { requestUrl, SecretStorage } from "obsidian";
import moment from "moment";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthDeps } from "../src/googleAuth";
import {
	cachedEventsForDay,
	listCalendars,
	listEventsForDay,
	refreshCalendarCache,
} from "../src/googleCalendar";
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
		settings: {
			...DEFAULT_SETTINGS,
			timezone: "UTC",
			calendarCaches: {},
			calendarHealth: {},
			rendering: { ...DEFAULT_SETTINGS.rendering },
		},
		saveSettings: async () => {},
		secretStorage: new SecretStorage(),
	};
}

beforeEach(() => {
	vi.mocked(requestUrl).mockReset();
});

describe("incremental calendar cache", () => {
	it("stores a full-sync token and then requests only changes", async () => {
		const auth = deps();
		vi.mocked(requestUrl)
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				json: {
					items: [
						{
							id: "event-1",
							summary: "Original",
							start: { date: "2026-07-22" },
							end: { date: "2026-07-23" },
						},
					],
					nextSyncToken: "token-1",
				},
			} as never)
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				json: {
					items: [
						{
							id: "event-1",
							summary: "Updated",
							start: { date: "2026-07-22" },
							end: { date: "2026-07-23" },
						},
					],
					nextSyncToken: "token-2",
				},
			} as never);

		await refreshCalendarCache(auth, "work", new Date("2026-07-01T00:00:00Z"));
		const events = await refreshCalendarCache(auth, "work", new Date("2026-07-10T00:00:00Z"));

		expect(events[0].summary).toBe("Updated");
		expect(auth.settings.calendarCaches.work.syncToken).toBe("token-2");
		expect(vi.mocked(requestUrl).mock.calls[1][0].url).toContain("syncToken=token-1");
	});

	it("rebuilds after Google invalidates a sync token", async () => {
		const auth = deps();
		auth.settings.calendarCaches.work = {
			syncToken: "expired",
			coverageStart: "2026-07-01T00:00:00.000Z",
			updatedAt: Date.now(),
			events: {},
		};
		vi.mocked(requestUrl)
			.mockResolvedValueOnce({ status: 410, headers: {}, json: {} } as never)
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				json: { items: [], nextSyncToken: "replacement" },
			} as never);

		await refreshCalendarCache(auth, "work", new Date("2026-07-10T00:00:00Z"));
		expect(auth.settings.calendarCaches.work.syncToken).toBe("replacement");
		expect(vi.mocked(requestUrl).mock.calls[1][0].url).toContain("timeMin=");
	});

	it("filters cached all-day and timed events by overlap", () => {
		const events = [
			{
				id: "all-day",
				summary: "Trip",
				start: { date: "2026-07-21" },
				end: { date: "2026-07-24" },
			},
			{
				id: "later",
				summary: "Later",
				start: { dateTime: "2026-07-23T09:00:00Z" },
				end: { dateTime: "2026-07-23T10:00:00Z" },
			},
		];
		expect(
			cachedEventsForDay(events, moment("2026-07-22"), "UTC").map((event) => event.id)
		).toEqual(["all-day"]);
	});
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
