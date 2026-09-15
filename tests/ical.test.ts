import { SecretStorage } from "obsidian";
import { RRule } from "rrule";
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

const CLAMP_WINDOW_START = new Date("2026-09-14T00:00:00Z");
const CLAMP_WINDOW_END = new Date("2026-10-15T00:00:00Z");
const CLAMP_DURATION_MS = 3_600_000;

function recurringFeed(dtstart: string, rule: string): string {
	const endHour = String(Number(dtstart.slice(9, 11)) + 1).padStart(2, "0");
	return [
		"BEGIN:VCALENDAR",
		"BEGIN:VEVENT",
		"UID:clamp-1",
		`DTSTART:${dtstart}Z`,
		`DTEND:${dtstart.slice(0, 9)}${endHour}${dtstart.slice(11, 15)}Z`,
		`RRULE:${rule}`,
		"SUMMARY:Long-running series",
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");
}

/** Expands `rule` from its true DTSTART, as the unclamped equivalent would. */
function unclampedStarts(dtstart: string, rule: string): string[] {
	const trueStart = new Date(Date.UTC(
		Number(dtstart.slice(0, 4)),
		Number(dtstart.slice(4, 6)) - 1,
		Number(dtstart.slice(6, 8)),
		Number(dtstart.slice(9, 11)),
		Number(dtstart.slice(11, 13)),
		Number(dtstart.slice(13, 15))
	));
	const options = RRule.parseString(rule);
	options.dtstart = trueStart;
	options.tzid = null;
	const found = new Set<number>([trueStart.getTime()]);
	const padded = 2 * 86_400_000;
	for (const occurrence of new RRule(options, true).between(
		new Date(CLAMP_WINDOW_START.getTime() - CLAMP_DURATION_MS - padded),
		new Date(CLAMP_WINDOW_END.getTime() + padded),
		true
	)) {
		found.add(occurrence.getTime());
	}
	return [...found]
		.filter((time) =>
			time < CLAMP_WINDOW_END.getTime()
			&& time + CLAMP_DURATION_MS > CLAMP_WINDOW_START.getTime())
		.sort((left, right) => left - right)
		.map((time) => new Date(time).toISOString());
}

describe("recurrence expansion starts from a clamped DTSTART", () => {
	// A DTSTART years before the window is walked period by period by rrule, so
	// expansion advances it by whole INTERVAL periods first. These DTSTARTs cover
	// the month days that cannot land on every period boundary (Feb 29, the 31st).
	const dtstarts = ["20100104T090000", "20150228T093000", "20160229T100000", "20170131T083000"];
	const rules = [
		"FREQ=DAILY",
		"FREQ=DAILY;INTERVAL=17",
		"FREQ=WEEKLY;BYDAY=MO,WE,FR",
		"FREQ=WEEKLY;INTERVAL=3;BYDAY=SA,SU;WKST=SU",
		"FREQ=WEEKLY;INTERVAL=5;WKST=MO",
		"FREQ=MONTHLY;BYMONTHDAY=31",
		"FREQ=MONTHLY;BYMONTHDAY=-1",
		"FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
		"FREQ=MONTHLY;INTERVAL=7;BYMONTHDAY=15",
		"FREQ=YEARLY;INTERVAL=2",
		"FREQ=YEARLY;BYMONTH=9;BYDAY=3MO",
		"FREQ=YEARLY;BYWEEKNO=38;BYDAY=MO",
		"FREQ=DAILY;UNTIL=20261001T090000Z",
		"FREQ=DAILY;COUNT=10000",
	];
	for (const dtstart of dtstarts) {
		for (const rule of rules) {
			it(`matches the unclamped expansion of ${rule} from ${dtstart}`, () => {
				const events = parseICalendar(
					recurringFeed(dtstart, rule),
					CLAMP_WINDOW_START,
					CLAMP_WINDOW_END,
					"UTC"
				);
				expect(events.map((event) => event.start.dateTime).sort())
					.toEqual(unclampedStarts(dtstart, rule));
			});
		}
	}

	it("expands a series running since 1970 without walking every day", () => {
		const events = parseICalendar(
			recurringFeed("19700101T090000", "FREQ=DAILY"),
			new Date("2026-03-01T00:00:00Z"),
			new Date("2026-03-08T00:00:00Z"),
			"UTC"
		);
		expect(events).toHaveLength(7);
	});
});

describe("recurrence expansion refuses rules it cannot bound", () => {
	function expand(rule: string, dtstart = "20250301T090000"): () => unknown {
		return () => parseICalendar(
			recurringFeed(dtstart, rule),
			new Date("2026-03-01T00:00:00Z"),
			new Date("2026-03-08T00:00:00Z"),
			"UTC"
		);
	}

	// rrule only compares UNTIL against candidates that survive the BY* filters,
	// so a rule that never matches walks to year 9999 rather than calling back.
	// Both guards below have to reject before expansion, not during it.
	for (const frequency of ["SECONDLY", "MINUTELY", "HOURLY"]) {
		it(`rejects FREQ=${frequency} instead of expanding it`, () => {
			expect(expand(`FREQ=${frequency}`)).toThrow(
				new RegExp(`FREQ=${frequency} recurrence is not supported`)
			);
		});
	}

	for (const rule of [
		"FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30",
		"FREQ=DAILY;COUNT=99999;BYMONTH=2;BYMONTHDAY=30",
		"FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=31",
		"FREQ=MONTHLY;BYMONTH=4,6;BYMONTHDAY=31",
	]) {
		it(`rejects the unsatisfiable rule ${rule}`, () => {
			expect(expand(rule)).toThrow(/month day that no month in BYMONTH contains/);
		});
	}

	for (const rule of [
		"FREQ=MONTHLY;BYMONTHDAY=31",
		"FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29",
		"FREQ=MONTHLY;BYMONTHDAY=-31",
		"FREQ=MONTHLY;BYMONTH=4;BYMONTHDAY=30",
	]) {
		it(`still accepts the satisfiable rule ${rule}`, () => {
			expect(expand(rule)).not.toThrow();
		});
	}

	it("bounds a feed whose rules would otherwise expand without limit", () => {
		const events = Array.from({ length: 200 }, (_, index) => [
			"BEGIN:VEVENT",
			`UID:wide-${index}`,
			"DTSTART:20100101T090000Z",
			"DTEND:20100101T100000Z",
			"RRULE:FREQ=DAILY",
			"SUMMARY:Wide",
			"END:VEVENT",
		].join("\r\n"));
		expect(() => parseICalendar(
			["BEGIN:VCALENDAR", ...events, "END:VCALENDAR"].join("\r\n"),
			new Date("2026-01-01T00:00:00Z"),
			new Date("2026-12-31T00:00:00Z"),
			"UTC"
		)).toThrow(/expands beyond 5000 events|too expensive to expand/);
	});
});
