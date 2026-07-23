import { describe, expect, it } from "vitest";
import { isValidTimeZone, zonedDayRange } from "../src/timezone";

describe("zonedDayRange", () => {
	it("computes UTC day boundaries for a zone west of UTC", () => {
		const { start, end } = zonedDayRange(2026, 7, 22, "America/Los_Angeles");
		expect(start.toISOString()).toBe("2026-07-22T07:00:00.000Z");
		expect(end.toISOString()).toBe("2026-07-23T07:00:00.000Z");
	});

	it("computes boundaries for UTC itself", () => {
		const { start, end } = zonedDayRange(2026, 1, 15, "UTC");
		expect(start.toISOString()).toBe("2026-01-15T00:00:00.000Z");
		expect(end.toISOString()).toBe("2026-01-16T00:00:00.000Z");
	});

	it("handles a zone east of UTC", () => {
		const { start, end } = zonedDayRange(2026, 3, 1, "Asia/Tokyo");
		expect(start.toISOString()).toBe("2026-02-28T15:00:00.000Z");
		expect(end.toISOString()).toBe("2026-03-01T15:00:00.000Z");
	});

	it("handles a US spring-forward DST transition day (23-hour day)", () => {
		const { start, end } = zonedDayRange(2026, 3, 8, "America/New_York");
		expect(start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
		expect(end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
	});

	it("rolls over month/year boundaries", () => {
		const { end } = zonedDayRange(2025, 12, 31, "UTC");
		expect(end.toISOString()).toBe("2026-01-01T00:00:00.000Z");
	});
});

describe("isValidTimeZone", () => {
	it("accepts real IANA zones", () => {
		expect(isValidTimeZone("America/New_York")).toBe(true);
		expect(isValidTimeZone("UTC")).toBe(true);
		expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
	});

	it("rejects garbage, empty, and made-up zone names", () => {
		expect(isValidTimeZone("")).toBe(false);
		expect(isValidTimeZone("Not/AZone")).toBe(false);
		expect(isValidTimeZone("America/New York")).toBe(false);
	});
});
