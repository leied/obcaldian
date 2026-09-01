import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs helper script, not part of the tsconfig project.
import { buildTestCalendar } from "../scripts/generate-test-ical.mjs";
import { parseICalendar } from "../src/ical";
import { multiDaySpan } from "../src/multiDay";

const START = "2026-09-01";
const RANGE_START = new Date("2026-08-31T00:00:00Z");
const RANGE_END = new Date("2026-11-01T00:00:00Z");

describe("generate-test-ical script", () => {
	it("produces an .ics feed the plugin's own parser accepts", () => {
		const { ics, eventCount } = buildTestCalendar({ start: START });
		expect(eventCount).toBeGreaterThan(0);

		const events = parseICalendar(ics, RANGE_START, RANGE_END, "UTC");
		expect(events.length).toBeGreaterThanOrEqual(eventCount);
	});

	it("expands recurrence, EXDATE, and the moved-instance override", () => {
		const { ics } = buildTestCalendar({ start: START });
		const events = parseICalendar(ics, RANGE_START, RANGE_END, "UTC");

		const dailyCheckins = events.filter((event) => event.summary.startsWith("Daily check-in"));
		expect(dailyCheckins).toHaveLength(5);

		const standingSyncs = events.filter((event) => event.summary.startsWith("Standing sync"));
		expect(standingSyncs).toHaveLength(5); // COUNT=6 minus one EXDATE-skipped occurrence.

		const moved = events.find((event) => event.summary.includes("Weekly 1:1 (moved)"));
		expect(moved).toBeDefined();
		expect(moved?.recurringEventId).toBeDefined();
	});

	it("flags the multi-day all-day event but not the midnight-boundary event", () => {
		const { ics } = buildTestCalendar({ start: START });
		const events = parseICalendar(ics, RANGE_START, RANGE_END, "UTC");

		const offsite = events.find((event) => event.summary.startsWith("Offsite conference"));
		expect(offsite).toBeDefined();
		expect(multiDaySpan(offsite!, "UTC")).toEqual({ startDate: "2026-09-03", endDate: "2026-09-05", totalDays: 3 });

		const boundary = events.find((event) => event.summary.startsWith("Late wrap-up"));
		expect(boundary).toBeDefined();
		expect(multiDaySpan(boundary!, "UTC")).toBeNull();
	});
});
