/** Returns the UTC offset, in minutes, of `timeZone` at the instant `epochMs`. */
function offsetMinutesAt(epochMs: number, timeZone: string): number {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const parts: Record<string, string> = {};
	for (const part of dtf.formatToParts(new Date(epochMs))) {
		if (part.type !== "literal") parts[part.type] = part.value;
	}
	const hour = Number(parts.hour) % 24; // some ICU builds report midnight as "24"
	const asUtc = Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		hour,
		Number(parts.minute),
		Number(parts.second)
	);
	return (asUtc - epochMs) / 60_000;
}

/** Resolves the wall-clock time in `timeZone` to the UTC instant it represents. */
export function zonedDateTime(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	timeZone: string
): Date {
	const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
	const offset = offsetMinutesAt(naiveUtc, timeZone);
	let instant = naiveUtc - offset * 60_000;
	// Re-check near DST transitions, where the first guess's offset may not
	// match the offset actually in effect at the resolved instant.
	const offset2 = offsetMinutesAt(instant, timeZone);
	if (offset2 !== offset) {
		instant = naiveUtc - offset2 * 60_000;
	}
	return new Date(instant);
}

/** True if `timeZone` is a recognized IANA time zone name. */
export function isValidTimeZone(timeZone: string): boolean {
	if (!timeZone) return false;
	try {
		new Intl.DateTimeFormat(undefined, { timeZone });
		return true;
	} catch {
		return false;
	}
}

/**
 * Returns the [start, end) UTC instants spanning the given calendar day
 * (year/month/day, month is 1-12) as midnight-to-midnight in `timeZone`.
 */
export function zonedDayRange(
	year: number,
	month: number,
	day: number,
	timeZone: string
): { start: Date; end: Date } {
	const start = zonedDateTime(year, month, day, 0, 0, 0, timeZone);
	const end = zonedDateTime(year, month, day + 1, 0, 0, 0, timeZone);
	return { start, end };
}
