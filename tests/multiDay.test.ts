import { describe, expect, it } from "vitest";
import type { GoogleEvent } from "../src/googleCalendar";
import {
	dayNumberInSpan,
	eventOccurrenceKey,
	isMultiDayEventChecked,
	multiDayEventKey,
	multiDayEventMarker,
	multiDaySpan,
} from "../src/multiDay";

describe("multiDaySpan", () => {
	it("handles Google's exclusive end date for all-day events", () => {
		const event: GoogleEvent = {
			summary: "Conference",
			start: { date: "2026-07-21" },
			end: { date: "2026-07-24" },
		};
		const span = multiDaySpan(event, "UTC");
		expect(span).toEqual({
			startDate: "2026-07-21",
			endDate: "2026-07-23",
			totalDays: 3,
		});
		expect(dayNumberInSpan("2026-07-22", span!)).toBe(2);
	});

	it("detects an overnight timed event in the configured timezone", () => {
		const event: GoogleEvent = {
			summary: "Overnight flight",
			start: { dateTime: "2026-07-22T06:00:00Z" },
			end: { dateTime: "2026-07-22T10:00:00Z" },
		};
		expect(multiDaySpan(event, "America/Los_Angeles")).toEqual({
			startDate: "2026-07-21",
			endDate: "2026-07-22",
			totalDays: 2,
		});
	});

	it("does not count an event ending exactly at midnight as spanning the next day", () => {
		const event: GoogleEvent = {
			summary: "Late shift",
			start: { dateTime: "2026-07-21T20:00:00Z" },
			end: { dateTime: "2026-07-22T00:00:00Z" },
		};
		expect(multiDaySpan(event, "UTC")).toBeNull();
	});
});

describe("multi-day event identity", () => {
	it("recognizes a checked marker without confusing a different event", () => {
		const key = multiDayEventKey("work@example.com", "event--123");
		const content = `- [x] Conference ${multiDayEventMarker(key)}`;
		expect(isMultiDayEventChecked(content, key)).toBe(true);
		expect(isMultiDayEventChecked(content, multiDayEventKey("work", "other"))).toBe(false);
		expect(multiDayEventMarker(key)).not.toContain("--123");
	});

	it("uses immutable original start time when a recurring instance moves", () => {
		const originalStartTime = { dateTime: "2026-07-22T09:00:00Z" };
		const before: GoogleEvent = {
			id: "instance-a",
			recurringEventId: "series-1",
			originalStartTime,
			summary: "Standup",
			start: { dateTime: "2026-07-22T09:00:00Z" },
			end: { dateTime: "2026-07-22T09:30:00Z" },
		};
		const moved: GoogleEvent = {
			...before,
			start: { dateTime: "2026-07-23T12:00:00Z" },
			end: { dateTime: "2026-07-23T12:30:00Z" },
		};
		expect(eventOccurrenceKey("work", moved)).toBe(eventOccurrenceKey("work", before));
	});
});
