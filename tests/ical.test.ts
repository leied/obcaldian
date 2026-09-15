import { SecretStorage } from "obsidian";
import { describe, expect, it } from "vitest";
import type { AuthDeps } from "../src/googleAuth";
import { getICalUrl, parseICalendar, setICalUrl } from "../src/ical";
import { DEFAULT_SETTINGS } from "../src/settings";

function deps(): AuthDeps {
	return {
		settings: { ...DEFAULT_SETTINGS, iCalCalendars: [], iCalCaches: {} },
		saveSettings: async () => {},
		secretStorage: new SecretStorage(),
	};
}

describe("Secret iCalendar URL storage", () => {
	it("stores HTTPS feed URLs only in SecretStorage", () => {
		const auth = deps();
		setICalUrl(auth, "ical-test", "https://calendar.example/private/feed.ics?secret=abc");
		expect(getICalUrl(auth, "ical-test")).toBe("https://calendar.example/private/feed.ics?secret=abc");
		expect(JSON.stringify(auth.settings)).not.toContain("secret=abc");
		expect(() => setICalUrl(auth, "ical-test", "http://calendar.example/feed.ics")).toThrow(/HTTPS/i);
	});
});

describe("iCalendar parsing", () => {
	it("parses all-day and folded event text", () => {
		const events = parseICalendar(
			[
				"BEGIN:VCALENDAR",
				"BEGIN:VEVENT",
				"UID:event-1",
				"DTSTART;VALUE=DATE:20260901",
				"DTEND;VALUE=DATE:20260903",
				"SUMMARY:Offsite\\, part one",
				"DESCRIPTION:First line\\nSecond",
				" line",
				"END:VEVENT",
				"END:VCALENDAR",
			].join("\r\n"),
			new Date("2026-09-01T00:00:00Z"),
			new Date("2026-09-04T00:00:00Z"),
			"UTC"
		);
		expect(events).toEqual([
			expect.objectContaining({
				id: "event-1",
				summary: "Offsite, part one",
				description: "First line\nSecondline",
				start: { date: "2026-09-01" },
				end: { date: "2026-09-03" },
			}),
		]);
	});

	it("expands recurrence, applies EXDATE, and preserves identity when an occurrence moves", () => {
		const events = parseICalendar(
			[
				"BEGIN:VCALENDAR",
				"BEGIN:VEVENT",
				"UID:series-1",
				"DTSTART;TZID=America/Los_Angeles:20260901T090000",
				"DTEND;TZID=America/Los_Angeles:20260901T100000",
				"RRULE:FREQ=DAILY;COUNT=3",
				"EXDATE;TZID=America/Los_Angeles:20260902T090000",
				"SUMMARY:Standup",
				"END:VEVENT",
				"BEGIN:VEVENT",
				"UID:series-1",
				"RECURRENCE-ID;TZID=America/Los_Angeles:20260903T090000",
				"DTSTART;TZID=America/Los_Angeles:20260903T120000",
				"DTEND;TZID=America/Los_Angeles:20260903T130000",
				"SUMMARY:Moved standup",
				"END:VEVENT",
				"END:VCALENDAR",
			].join("\r\n"),
			new Date("2026-09-01T00:00:00Z"),
			new Date("2026-09-05T00:00:00Z"),
			"UTC"
		);
		expect(events).toHaveLength(2);
		expect(events[1]).toEqual(expect.objectContaining({
			recurringEventId: "series-1",
			summary: "Moved standup",
			originalStartTime: expect.objectContaining({ dateTime: "2026-09-03T16:00:00.000Z" }),
			start: { dateTime: "2026-09-03T19:00:00.000Z" },
		}));
	});

	it("keeps DTSTART's day when a yearly rule specifies only BYMONTH", () => {
		const events = parseICalendar(
			[
				"BEGIN:VCALENDAR",
				"BEGIN:VEVENT",
				"UID:annual-1",
				"DTSTART;VALUE=DATE:20260915",
				"RRULE:FREQ=YEARLY;BYMONTH=9;COUNT=3",
				"SUMMARY:Annual review",
				"END:VEVENT",
				"END:VCALENDAR",
			].join("\r\n"),
			new Date("2026-09-01T00:00:00Z"),
			new Date("2026-10-01T00:00:00Z"),
			"UTC"
		);

		expect(events.map((event) => event.start.date)).toEqual(["2026-09-15"]);
	});

	it("honors BYSETPOS when selecting the last weekday of each month", () => {
		const events = parseICalendar(
			[
				"BEGIN:VCALENDAR",
				"BEGIN:VEVENT",
				"UID:month-end-1",
				"DTSTART;VALUE=DATE:20260930",
				"RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3",
				"SUMMARY:Month end",
				"END:VEVENT",
				"END:VCALENDAR",
			].join("\r\n"),
			new Date("2026-09-01T00:00:00Z"),
			new Date("2026-12-01T00:00:00Z"),
			"UTC"
		);

		expect(events.map((event) => event.start.date)).toEqual([
			"2026-09-30",
			"2026-10-30",
			"2026-11-30",
		]);
	});

	it("keeps a timed recurrence at the same wall time across daylight-saving changes", () => {
		const events = parseICalendar(
			[
				"BEGIN:VCALENDAR",
				"BEGIN:VEVENT",
				"UID:dst-1",
				"DTSTART;TZID=America/Los_Angeles:20261031T090000",
				"DTEND;TZID=America/Los_Angeles:20261031T100000",
				"RRULE:FREQ=DAILY;COUNT=3",
				"SUMMARY:Daily meeting",
				"END:VEVENT",
				"END:VCALENDAR",
			].join("\r\n"),
			new Date("2026-10-31T00:00:00Z"),
			new Date("2026-11-03T23:59:59Z"),
			"UTC"
		);

		expect(events.map((event) => event.start.dateTime)).toEqual([
			"2026-10-31T16:00:00.000Z",
			"2026-11-01T17:00:00.000Z",
			"2026-11-02T17:00:00.000Z",
		]);
	});

	it("fails invalid recurrence rules instead of silently approximating them", () => {
		expect(() => parseICalendar(
			[
				"BEGIN:VCALENDAR",
				"BEGIN:VEVENT",
				"UID:invalid-rule-1",
				"DTSTART;VALUE=DATE:20260915",
				"RRULE:FREQ=FORTNIGHTLY;COUNT=3",
				"SUMMARY:Invalid recurrence",
				"END:VEVENT",
				"END:VCALENDAR",
			].join("\r\n"),
			new Date("2026-09-01T00:00:00Z"),
			new Date("2026-10-01T00:00:00Z"),
			"UTC"
		)).toThrow(/Could not expand recurrence for "Invalid recurrence"/);
	});
});
