import type { GoogleEvent } from "./googleCalendar";

export interface MultiDaySpan {
	/** Inclusive local calendar date. */
	startDate: string;
	/** Inclusive local calendar date. */
	endDate: string;
	totalDays: number;
}

function dateOrdinal(date: string): number {
	const [year, month, day] = date.split("-").map(Number);
	return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function shiftDate(date: string, days: number): string {
	const shifted = new Date((dateOrdinal(date) + days) * 86_400_000);
	return shifted.toISOString().slice(0, 10);
}

function localDateForInstant(dateTime: string, timeZone: string): string {
	const parts: Record<string, string> = {};
	for (const part of new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date(dateTime))) {
		if (part.type !== "literal") parts[part.type] = part.value;
	}
	return `${parts.year}-${parts.month}-${parts.day}`;
}

export function eventStartDate(event: GoogleEvent, timeZone: string): string | null {
	if (event.start.date) return event.start.date;
	if (event.start.dateTime) return localDateForInstant(event.start.dateTime, timeZone);
	if (event.originalStartTime?.date) return event.originalStartTime.date;
	if (event.originalStartTime?.dateTime) {
		return localDateForInstant(event.originalStartTime.dateTime, timeZone);
	}
	return null;
}

/** Returns an inclusive span only when the event overlaps more than one local calendar day. */
export function multiDaySpan(ev: GoogleEvent, timeZone: string): MultiDaySpan | null {
	let startDate: string | undefined;
	let endDate: string | undefined;

	if (ev.start.date && ev.end.date) {
		startDate = ev.start.date;
		// Google all-day end dates are exclusive.
		endDate = shiftDate(ev.end.date, -1);
	} else if (ev.start.dateTime && ev.end.dateTime) {
		startDate = localDateForInstant(ev.start.dateTime, timeZone);
		// Treat an event ending exactly at midnight as belonging to the prior day only.
		endDate = localDateForInstant(
			new Date(new Date(ev.end.dateTime).getTime() - 1).toISOString(),
			timeZone
		);
	}

	if (!startDate || !endDate) return null;
	const totalDays = dateOrdinal(endDate) - dateOrdinal(startDate) + 1;
	return totalDays > 1 ? { startDate, endDate, totalDays } : null;
}

export function dayNumberInSpan(date: string, span: MultiDaySpan): number | null {
	const day = dateOrdinal(date) - dateOrdinal(span.startDate) + 1;
	return day >= 1 && day <= span.totalDays ? day : null;
}

export function datesInSpan(span: MultiDaySpan): string[] {
	return Array.from({ length: span.totalDays }, (_, index) => shiftDate(span.startDate, index));
}

/** Calendar ID is included because the same shared event can appear on more than one calendar. */
export function multiDayEventKey(calendarId: string, eventId: string): string {
	return `${calendarId}::${eventId}`;
}

/**
 * Canonical identity for one occurrence. Recurring instances use their series ID plus Google's
 * immutable original start, so moved and detached instances continue to match their old notes.
 */
export function eventOccurrenceKey(calendarId: string, event: GoogleEvent): string | null {
	const eventId = event.recurringEventId || event.id;
	if (!eventId) return null;
	const originalStart = event.originalStartTime?.dateTime || event.originalStartTime?.date;
	return event.recurringEventId && originalStart
		? `${calendarId}::${eventId}::${originalStart}`
		: multiDayEventKey(calendarId, eventId);
}

export function multiDayEventMarker(eventKey: string): string {
	// Escape hyphens too, keeping the HTML comment body valid even for IDs containing "--".
	const encoded = encodeURIComponent(eventKey).replace(/-/g, "%2D");
	return `<!-- obcaldian:event:${encoded} -->`;
}

export const eventMarker = multiDayEventMarker;

export function eventKeyFromMarkerLine(line: string): string | null {
	const match = line.match(/<!-- obcaldian:event:([^\s]+) -->/);
	if (!match) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return null;
	}
}

/** Reads a checkbox state only from the event's own invisible marker line. */
export function isMultiDayEventChecked(content: string, eventKey: string): boolean {
	const marker = multiDayEventMarker(eventKey);
	return content
		.split("\n")
		.some((line) => line.includes(marker) && /^\s*- \[[xX]\]/.test(line));
}
