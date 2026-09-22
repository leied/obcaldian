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

vi.mock("../src/googleAuth", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/googleAuth")>()),
	getValidAccessToken: vi.fn(async () => "access-token"),
}));

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<typeof import("obsidian")>()),
	requestUrl: vi.fn(),
}));

function deps(): AuthDeps {
	const account = {
		id: "account-one",
		name: "Account one",
		clientId: "client",
		projectId: "project",
		calendars: [],
		calendarCaches: {},
		calendarHealth: {},
	};
	return {
		settings: {
			...DEFAULT_SETTINGS,
			timezone: "UTC",
			googleAccounts: [account],
			rendering: { ...DEFAULT_SETTINGS.rendering },
		},
		saveSettings: async () => {},
		secretStorage: new SecretStorage(),
		accountId: account.id,
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
		expect(auth.settings.googleAccounts[0].calendarCaches.work.syncToken).toBe("token-2");
		expect(vi.mocked(requestUrl).mock.calls[1][0].url).toContain("syncToken=token-1");
		expect(vi.mocked(requestUrl).mock.calls[1][0].url).toContain("timeZone=UTC");
	});

	it("rebuilds the cache when the configured timezone changes", async () => {
		const auth = deps();
		vi.mocked(requestUrl)
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				json: { items: [], nextSyncToken: "utc-token" },
			} as never)
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				json: { items: [], nextSyncToken: "la-token" },
			} as never);

		await refreshCalendarCache(auth, "work", new Date("2026-07-01T00:00:00Z"));
		auth.settings.timezone = "America/Los_Angeles";
		await refreshCalendarCache(auth, "work", new Date("2026-07-10T00:00:00Z"));

		const secondUrl = vi.mocked(requestUrl).mock.calls[1][0].url;
		expect(secondUrl).toContain("timeMin=");
		expect(secondUrl).not.toContain("syncToken=");
		expect(secondUrl).toContain("timeZone=America%2FLos_Angeles");
		expect(auth.settings.googleAccounts[0].calendarCaches.work).toMatchObject({
			syncToken: "la-token",
			timeZone: "America/Los_Angeles",
		});
	});

	it("drops finished events and moves coverage up so stale days are refetched", async () => {
		const auth = deps();
		const now = Date.parse("2026-07-10T00:00:00Z");
		auth.settings.googleAccounts[0].calendarCaches.work = {
			syncToken: "token-1",
			coverageStart: "2026-01-01T00:00:00.000Z",
			timeZone: "UTC",
			updatedAt: now,
			events: {
				"old::": {
					id: "old",
					summary: "Long gone",
					start: { dateTime: "2026-01-02T09:00:00Z" },
					end: { dateTime: "2026-01-02T10:00:00Z" },
				},
				"recent::": {
					id: "recent",
					summary: "Still in range",
					start: { dateTime: "2026-07-09T09:00:00Z" },
					end: { dateTime: "2026-07-09T10:00:00Z" },
				},
			},
		};
		vi.mocked(requestUrl).mockResolvedValueOnce({
			status: 200,
			headers: {},
			json: { items: [], nextSyncToken: "token-2" },
		} as never);
		vi.setSystemTime(now);

		const events = await refreshCalendarCache(auth, "work", new Date(now));

		const cache = auth.settings.googleAccounts[0].calendarCaches.work;
		expect(Object.keys(cache.events)).toEqual(["recent::"]);
		expect(events).toHaveLength(1);
		// Coverage now starts at the retention cutoff, so an older range rebuilds.
		expect(cache.coverageStart).toBe("2026-06-10T00:00:00.000Z");
		vi.useRealTimers();
	});

	it("drops cancelled instances of a deleted series but keeps other cancellations", async () => {
		const auth = deps();
		const instance = (id: string, series: string | undefined, day: string, status: string) => ({
			id,
			summary: `${status} ${id}`,
			status,
			...(series ? { recurringEventId: series } : {}),
			originalStartTime: { dateTime: `2026-07-${day}T13:00:00Z` },
			start: { dateTime: `2026-07-${day}T13:00:00Z` },
			end: { dateTime: `2026-07-${day}T14:00:00Z` },
		});
		vi.mocked(requestUrl)
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				json: {
					items: [
						// A series the organizer deleted: every occurrence is a tombstone.
						instance("dead_1", "dead", "20", "cancelled"),
						instance("dead_2", "dead", "27", "cancelled"),
						// A live series with one skipped week.
						instance("live_1", "live", "21", "confirmed"),
						instance("live_2", "live", "28", "cancelled"),
						// A cancelled one-off event.
						instance("single", undefined, "22", "cancelled"),
					],
					nextSyncToken: "token-1",
				},
			} as never)
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				// The live series is deleted later; incremental sync reports its tombstone.
				json: { items: [instance("live_1", "live", "21", "cancelled")], nextSyncToken: "token-2" },
			} as never);

		const first = await refreshCalendarCache(auth, "work", new Date("2026-07-01T00:00:00Z"));
		expect(first.map((event) => event.id).sort()).toEqual(["live_1", "live_2", "single"]);

		const second = await refreshCalendarCache(auth, "work", new Date("2026-07-01T00:00:00Z"));
		expect(second.map((event) => event.id)).toEqual(["single"]);
	});

	it("keeps a range the caller actually asked for, even past the retention window", async () => {
		const auth = deps();
		const now = Date.parse("2026-07-10T00:00:00Z");
		auth.settings.googleAccounts[0].calendarCaches.work = {
			syncToken: "token-1",
			coverageStart: "2026-01-01T00:00:00.000Z",
			timeZone: "UTC",
			updatedAt: now,
			events: {
				"old::": {
					id: "old",
					summary: "Long gone",
					start: { dateTime: "2026-01-02T09:00:00Z" },
					end: { dateTime: "2026-01-02T10:00:00Z" },
				},
			},
		};
		vi.mocked(requestUrl).mockResolvedValueOnce({
			status: 200,
			headers: {},
			json: { items: [], nextSyncToken: "token-2" },
		} as never);
		vi.setSystemTime(now);

		await refreshCalendarCache(auth, "work", new Date("2026-01-01T00:00:00Z"));

		const cache = auth.settings.googleAccounts[0].calendarCaches.work;
		expect(Object.keys(cache.events)).toEqual(["old::"]);
		expect(cache.coverageStart).toBe("2026-01-01T00:00:00.000Z");
		vi.useRealTimers();
	});

	it("stores only the fields it renders, dropping the rest of Google's payload", async () => {
		const auth = deps();
		vi.mocked(requestUrl).mockResolvedValueOnce({
			status: 200,
			headers: {},
			json: {
				items: [
					{
						id: "meeting",
						summary: "Sync",
						start: { dateTime: "2026-07-10T09:00:00Z" },
						end: { dateTime: "2026-07-10T10:00:00Z" },
						etag: '"3419"',
						conferenceData: { entryPoints: [{ uri: "https://meet.example/abc" }] },
						reminders: { useDefault: true },
						organizer: { email: "boss@example.com" },
						attendees: [
							{ email: "a@example.com", displayName: "A", comment: "running late" },
						],
					},
				],
				nextSyncToken: "token-1",
			},
		} as never);

		await refreshCalendarCache(auth, "work", new Date("2026-07-01T00:00:00Z"));

		const stored = auth.settings.googleAccounts[0].calendarCaches.work.events["meeting::"];
		expect(Object.keys(stored).sort()).toEqual(["attendees", "end", "id", "start", "summary"]);
		expect(stored.attendees).toEqual([{ email: "a@example.com", displayName: "A" }]);
	});

	it("rebuilds after Google invalidates a sync token", async () => {
		const auth = deps();
		auth.settings.googleAccounts[0].calendarCaches.work = {
			syncToken: "expired",
			coverageStart: "2026-07-01T00:00:00.000Z",
			timeZone: "UTC",
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
		expect(auth.settings.googleAccounts[0].calendarCaches.work.syncToken).toBe("replacement");
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
