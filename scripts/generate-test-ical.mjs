// Generates an .ics file of test events for manually exercising DailyCalSync
// against a real Google account: import it into a (preferably dedicated,
// secondary) Google Calendar via Settings > Import & export > Import, then
// connect that account/calendar in the plugin and run "Sync now".
//
// Usage:
//   node scripts/generate-test-ical.mjs [--out=test-calendar.ics] [--start=YYYY-MM-DD]
//
// Times are built from local wall-clock values in the system timezone the
// script runs under (override with `TZ=America/New_York node ...`). Set the
// plugin's Timezone setting to match so multi-day/boundary events land where
// this script intends.
//
// Caveats: Google's .ics importer doesn't always preserve a modified single
// occurrence of a recurring series (the "Weekly 1:1 (moved)" event below) as
// cleanly as creating it by hand in Google Calendar would — check it after
// import.
//
// `buildTestCalendar` is also exported for `tests/generate-test-ical.test.ts`,
// which feeds its output back through the plugin's own `parseICalendar` as a
// smoke test, since this script isn't exercised against a live Google account
// in CI.

import { writeFileSync } from "node:fs";

function pad(value, len = 2) {
	return String(value).padStart(len, "0");
}

function parseYMD(text) {
	const [year, month, day] = text.split("-").map(Number);
	return new Date(year, month - 1, day);
}

function addDays(base, days) {
	return new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
}

function nextWeekday(base, weekday) {
	let candidate = base;
	while (candidate.getDay() !== weekday) candidate = addDays(candidate, 1);
	return candidate;
}

function local(dateOnly, hour = 0, minute = 0) {
	return new Date(dateOnly.getFullYear(), dateOnly.getMonth(), dateOnly.getDate(), hour, minute, 0);
}

function fmtUtc(date) {
	return (
		`${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
		`T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
	);
}

function fmtDate(dateOnly) {
	return `${dateOnly.getFullYear()}${pad(dateOnly.getMonth() + 1)}${pad(dateOnly.getDate())}`;
}

function escapeText(value) {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\r?\n/g, "\\n");
}

function attendeeLine(name, email) {
	return `ATTENDEE;CN=${escapeText(name)}:mailto:${email}`;
}

/**
 * Builds the DailyCalSync test-calendar .ics text. `start` (YYYY-MM-DD) defaults to today.
 * Returns `{ ics, eventCount }`, where `eventCount` counts VEVENT blocks (a recurring series
 * with one overridden occurrence contributes two).
 */
export function buildTestCalendar({ start } = {}) {
	const today = start ? parseYMD(start) : new Date();
	today.setHours(0, 0, 0, 0);

	const lines = [];
	let vEventCount = 0;
	function push(...vevent) {
		vEventCount += 1;
		lines.push("BEGIN:VEVENT", ...vevent, "END:VEVENT");
	}

	let uidCounter = 0;
	function nextUid(slug) {
		uidCounter += 1;
		return `${slug}-${uidCounter}@dailycalsync.test`;
	}

	const dtstamp = `DTSTAMP:${fmtUtc(new Date())}`;

	function timedEvent({ uid, summary, start: eventStart, end, description, location, attendees, transp, status, klass, rrule, exdate }) {
		push(
			`UID:${uid}`,
			dtstamp,
			`SUMMARY:${escapeText(summary)}`,
			`DTSTART:${fmtUtc(eventStart)}`,
			`DTEND:${fmtUtc(end)}`,
			...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
			...(location ? [`LOCATION:${escapeText(location)}`] : []),
			...(attendees ?? []).map(([name, email]) => attendeeLine(name, email)),
			...(transp ? [`TRANSP:${transp}`] : []),
			...(status ? [`STATUS:${status}`] : []),
			...(klass ? [`CLASS:${klass}`] : []),
			...(rrule ? [`RRULE:${rrule}`] : []),
			...(exdate ? [`EXDATE:${fmtUtc(exdate)}`] : [])
		);
	}

	function allDayEvent({ uid, summary, startDate, endDateExclusive }) {
		push(
			`UID:${uid}`,
			dtstamp,
			`SUMMARY:${escapeText(summary)}`,
			`DTSTART;VALUE=DATE:${fmtDate(startDate)}`,
			`DTEND;VALUE=DATE:${fmtDate(endDateExclusive)}`
		);
	}

	// 1. Below the attendee-listing threshold (MIN_ATTENDEES_TO_LIST = 3) — no "Participants:" line expected.
	timedEvent({
		uid: nextUid("standup"),
		summary: "Daily standup [2 attendees, below participants threshold]",
		start: local(today, 9, 0),
		end: local(today, 9, 15),
		attendees: [["Alice", "alice@example.com"], ["Bob", "bob@example.com"]],
	});

	// 2. Description only — single footnote with just the description.
	timedEvent({
		uid: nextUid("design-review"),
		summary: "Design review [description footnote]",
		start: local(today, 10, 0),
		end: local(today, 11, 0),
		description: "Discuss the new onboarding flow and open questions.\nBring mocks if you have them.",
	});

	// 3. Description + 4 attendees — footnote combines both.
	timedEvent({
		uid: nextUid("all-hands"),
		summary: "All-hands [description + participants footnote]",
		start: local(today, 14, 0),
		end: local(today, 15, 0),
		description: "Quarterly all-hands. Bring questions for Q&A.",
		attendees: [
			["Alice", "alice@example.com"],
			["Bob", "bob@example.com"],
			["Carol", "carol@example.com"],
			["Dave", "dave@example.com"],
		],
	});

	// 4. CLASS:PRIVATE — exercises redactPrivateEvents ("Busy" title when enabled).
	timedEvent({
		uid: nextUid("private-appt"),
		summary: "Personal appointment (private)",
		start: local(today, 12, 0),
		end: local(today, 12, 30),
		klass: "PRIVATE",
	});

	// 5. TRANSP:TRANSPARENT — exercises includeFreeEvents filter.
	timedEvent({
		uid: nextUid("free-block"),
		summary: "Reading time [marked free/transparent]",
		start: local(today, 20, 0),
		end: local(today, 21, 0),
		transp: "TRANSPARENT",
	});

	// 6. STATUS:CANCELLED — exercises includeCancelled filter.
	timedEvent({
		uid: nextUid("cancelled-sync"),
		summary: "Cancelled 1:1 [status=cancelled]",
		start: local(today, 16, 0),
		end: local(today, 16, 30),
		status: "CANCELLED",
	});

	// 7. Markdown/marker-lookalike title + a comma-bearing location — exercises safeInlineText escaping.
	timedEvent({
		uid: nextUid("weird-chars"),
		summary: "Ship party 🎉 *big* [release]! <!-- not a marker -->",
		start: local(today, 18, 0),
		end: local(today, 19, 0),
		location: "Rooftop, 5th floor — bring a jacket",
	});

	// 8. Overnight timed event — exercises multiDaySpan() across a real day boundary.
	timedEvent({
		uid: nextUid("overnight-flight"),
		summary: "Red-eye flight to SF [multi-day timed]",
		start: local(today, 23, 0),
		end: local(addDays(today, 1), 6, 0),
	});

	// 9. Ends exactly at midnight — must NOT be treated as multi-day (multiDay.ts subtracts 1ms from the end).
	timedEvent({
		uid: nextUid("midnight-boundary"),
		summary: "Late wrap-up [ends exactly at midnight, should stay single-day]",
		start: local(today, 23, 0),
		end: local(addDays(today, 1), 0, 0),
	});

	// 10. All-day, 3 days inclusive — exercises "(Day X/3)" labeling.
	allDayEvent({
		uid: nextUid("offsite"),
		summary: "Offsite conference [multi-day all-day, Day X/3]",
		startDate: addDays(today, 2),
		endDateExclusive: addDays(today, 5), // Google/iCal all-day DTEND is exclusive.
	});

	// 11. All-day, single day.
	allDayEvent({
		uid: nextUid("holiday"),
		summary: "Team holiday [single all-day]",
		startDate: addDays(today, 5),
		endDateExclusive: addDays(today, 6),
	});

	// 12. Recurring daily, COUNT-bounded.
	timedEvent({
		uid: nextUid("daily-checkin"),
		summary: "Daily check-in [recurring daily]",
		start: local(addDays(today, 1), 9, 30),
		end: local(addDays(today, 1), 9, 45),
		rrule: "FREQ=DAILY;COUNT=5",
	});

	// 13. Recurring weekly on specific weekdays.
	const firstGymDay = nextWeekday(today, 1); // next Monday on/after today
	timedEvent({
		uid: nextUid("gym"),
		summary: "Gym [recurring weekly BYDAY]",
		start: local(firstGymDay, 6, 30),
		end: local(firstGymDay, 7, 15),
		rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6",
	});

	// 14. Recurring monthly.
	timedEvent({
		uid: nextUid("monthly-report"),
		summary: "Monthly report [recurring monthly]",
		start: local(today, 9, 0),
		end: local(today, 10, 0),
		rrule: "FREQ=MONTHLY;COUNT=3",
	});

	// 15. Recurring daily with one occurrence excluded via EXDATE.
	const skipSeriesStart = addDays(today, 2);
	timedEvent({
		uid: nextUid("skip-day"),
		summary: "Standing sync [recurring, one day skipped via EXDATE]",
		start: local(skipSeriesStart, 8, 0),
		end: local(skipSeriesStart, 8, 15),
		rrule: "FREQ=DAILY;COUNT=6",
		exdate: local(addDays(skipSeriesStart, 2), 8, 0),
	});

	// 16. Recurring weekly series with one instance moved via RECURRENCE-ID override.
	const oneOnOneUid = nextUid("weekly-1on1");
	const firstTuesday = nextWeekday(today, 2);
	const secondTuesday = addDays(firstTuesday, 7);
	push(
		`UID:${oneOnOneUid}`,
		dtstamp,
		"SUMMARY:Weekly 1:1 [recurring, one instance moved]",
		`DTSTART:${fmtUtc(local(firstTuesday, 15, 0))}`,
		`DTEND:${fmtUtc(local(firstTuesday, 15, 30))}`,
		"RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4"
	);
	push(
		`UID:${oneOnOneUid}`,
		dtstamp,
		`RECURRENCE-ID:${fmtUtc(local(secondTuesday, 15, 0))}`,
		"SUMMARY:Weekly 1:1 (moved) [overridden occurrence]",
		`DTSTART:${fmtUtc(local(secondTuesday, 16, 0))}`,
		`DTEND:${fmtUtc(local(secondTuesday, 16, 30))}`
	);

	const ics = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//DailyCalSync//test-calendar//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		...lines,
		"END:VCALENDAR",
	].join("\r\n");

	return { ics: `${ics}\r\n`, eventCount: vEventCount };
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href;
if (isMain) {
	const args = Object.fromEntries(
		process.argv.slice(2).map((arg) => {
			const [key, value] = arg.replace(/^--/, "").split("=");
			return [key, value ?? true];
		})
	);
	const outPath = args.out ?? "test-calendar.ics";
	const { ics, eventCount } = buildTestCalendar({ start: args.start });
	writeFileSync(outPath, ics);
	console.log(`Wrote ${eventCount} test events (incl. 1 recurrence override) to ${outPath}`);
	console.log("Import: Google Calendar > Settings > Import & export > Import, choose this file,");
	console.log("and pick (or create) a dedicated secondary calendar so test data stays isolated.");
	console.log("Then enable that calendar in DailyCalSync's Google account settings and run \"Sync now\".");
}
