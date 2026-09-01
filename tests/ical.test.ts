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
});
