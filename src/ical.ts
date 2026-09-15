import type { AuthDeps } from "./googleAuth";
import type { GoogleEvent, GoogleEventAttendee } from "./googleCalendar";
import { iCalRequest, assertSafeICalUrl } from "./network";
import { RRule } from "rrule";
import type { Options as RRuleOptions } from "rrule";
import type { ICalCalendarConfig } from "./settings";
import { isValidTimeZone, wallClockFormatter, zonedDateTime } from "./timezone";

const MAX_FEED_BYTES = 5_000_000;
const MAX_EXPANDED_EVENTS = 5_000;
/**
 * Hard ceiling on recurrence periods walked while expanding one feed. Expansion
 * is synchronous on Obsidian's only thread and `rrule` visits every period from
 * DTSTART onward, so a sub-daily `FREQ` or a rule whose selectors can never
 * match (`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`) would otherwise block the UI for
 * minutes. `clampedDtstart` keeps well-formed feeds orders of magnitude below
 * this, so reaching it means the feed is malformed rather than merely large.
 */
const MAX_RECURRENCE_PERIODS = 200_000;

const EXPANSION_LIMIT_MESSAGE =
	`The iCalendar feed expands beyond ${MAX_EXPANDED_EVENTS} events for this range.`;

/** Thrown for safety limits, which describe the feed rather than one event. */
class RecurrenceLimitError extends Error {}

interface Property {
	value: string;
	params: Record<string, string>;
}

interface ParsedDate {
	allDay: boolean;
	dateKey: string;
	date: Date;
	timeZone: string;
}

interface RawEvent {
	properties: Map<string, Property[]>;
}

function secretKey(calendarId: string): string {
	return `dailycalsync-ical-${calendarId}-url`;
}

export function getICalUrl(deps: AuthDeps, calendarId: string): string {
	return deps.secretStorage.getSecret(secretKey(calendarId)) ?? "";
}

export function setICalUrl(deps: AuthDeps, calendarId: string, rawUrl: string): void {
	const url = assertSafeICalUrl(rawUrl.trim());
	deps.secretStorage.setSecret(secretKey(calendarId), url.toString());
}

export function clearICalUrl(deps: AuthDeps, calendarId: string): void {
	deps.secretStorage.setSecret(secretKey(calendarId), "");
}

function unfoldLines(text: string): string[] {
	return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function parseProperty(line: string): { name: string; property: Property } | null {
	let colon = -1;
	let quoted = false;
	for (let index = 0; index < line.length; index += 1) {
		if (line[index] === '"' && line[index - 1] !== "\\") quoted = !quoted;
		if (line[index] === ":" && !quoted) {
			colon = index;
			break;
		}
	}
	if (colon <= 0) return null;
	const headerParts: string[] = [];
	let current = "";
	quoted = false;
	for (const character of line.slice(0, colon)) {
		if (character === '"') quoted = !quoted;
		if (character === ";" && !quoted) {
			headerParts.push(current);
			current = "";
		} else current += character;
	}
	headerParts.push(current);
	const [rawName, ...rawParams] = headerParts;
	const name = rawName.toUpperCase();
	const params: Record<string, string> = {};
	for (const rawParam of rawParams) {
		const equals = rawParam.indexOf("=");
		if (equals <= 0) continue;
		params[rawParam.slice(0, equals).toUpperCase()] = rawParam
			.slice(equals + 1)
			.replace(/^"|"$/g, "");
	}
	return { name, property: { value: line.slice(colon + 1), params } };
}

function parseEvents(text: string): RawEvent[] {
	const events: RawEvent[] = [];
	let current: RawEvent | null = null;
	for (const line of unfoldLines(text)) {
		if (line.toUpperCase() === "BEGIN:VEVENT") {
			current = { properties: new Map() };
			continue;
		}
		if (line.toUpperCase() === "END:VEVENT") {
			if (current) events.push(current);
			current = null;
			continue;
		}
		if (!current) continue;
		const parsed = parseProperty(line);
		if (!parsed) continue;
		const values = current.properties.get(parsed.name) ?? [];
		values.push(parsed.property);
		current.properties.set(parsed.name, values);
	}
	return events;
}

function first(event: RawEvent, name: string): Property | undefined {
	return event.properties.get(name)?.[0];
}

function unescapeText(value: string): string {
	return value
		.replace(/\\[nN]/g, "\n")
		.replace(/\\,/g, ",")
		.replace(/\\;/g, ";")
		.replace(/\\\\/g, "\\");
}

function dateKey(year: number, month: number, day: number): string {
	return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function parseDate(property: Property, fallbackTimeZone: string): ParsedDate | null {
	const raw = property.value.trim();
	const match = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
	if (!match) return null;
	const [, yearText, monthText, dayText, hourText, minuteText, secondText, utc] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const key = dateKey(year, month, day);
	const allDay = property.params.VALUE?.toUpperCase() === "DATE" || hourText === undefined;
	if (allDay) return { allDay: true, dateKey: key, date: new Date(`${key}T00:00:00.000Z`), timeZone: fallbackTimeZone };
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText ?? "0");
	const requestedTimeZone = property.params.TZID ?? fallbackTimeZone;
	const timeZone = utc
		? "UTC"
		: isValidTimeZone(requestedTimeZone)
			? requestedTimeZone
			: fallbackTimeZone;
	const date = utc
		? new Date(Date.UTC(year, month - 1, day, hour, minute, second))
		: zonedDateTime(year, month, day, hour, minute, second, timeZone);
	return { allDay: false, dateKey: key, date, timeZone };
}

function shiftDateKey(key: string, days: number): string {
	const [year, month, day] = key.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function durationMilliseconds(event: RawEvent, start: ParsedDate, end: ParsedDate | null): number {
	if (end) return Math.max(1, end.date.getTime() - start.date.getTime());
	const duration = first(event, "DURATION")?.value;
	const match = duration?.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
	if (match) return ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 60 * 60 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0)) * 1000;
	return start.allDay ? 86_400_000 : 3_600_000;
}

function wallDateAt(date: Date, timeZone: string): Date {
	const formatted = wallClockFormatter(timeZone).formatToParts(date);
	const parts = Object.fromEntries(
		formatted.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
	);
	return new Date(Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour) % 24,
		Number(parts.minute),
		Number(parts.second)
	));
}

function recurrenceWallDate(date: ParsedDate, recurrenceTimeZone: string): Date {
	if (date.allDay) return new Date(`${date.dateKey}T00:00:00.000Z`);
	return wallDateAt(date.date, recurrenceTimeZone);
}

function occurrenceDate(start: ParsedDate, wallDate: Date): ParsedDate {
	const year = wallDate.getUTCFullYear();
	const month = wallDate.getUTCMonth() + 1;
	const day = wallDate.getUTCDate();
	const key = dateKey(year, month, day);
	if (start.allDay) {
		return { ...start, dateKey: key, date: new Date(`${key}T00:00:00.000Z`) };
	}
	return {
		...start,
		dateKey: key,
		date: zonedDateTime(
			year,
			month,
			day,
			wallDate.getUTCHours(),
			wallDate.getUTCMinutes(),
			wallDate.getUTCSeconds(),
			start.timeZone
		),
	};
}

/** Milliseconds per period for the frequencies whose period is a fixed length. */
const FIXED_PERIOD_MS: Partial<Record<number, number>> = {
	[RRule.DAILY]: 86_400_000,
	[RRule.WEEKLY]: 7 * 86_400_000,
};

const FREQUENCY_NAMES: Partial<Record<number, string>> = {
	[RRule.HOURLY]: "HOURLY",
	[RRule.MINUTELY]: "MINUTELY",
	[RRule.SECONDLY]: "SECONDLY",
};

/**
 * Rejects sub-daily frequencies, which a daily note cannot usefully represent
 * and which the pre-`rrule` parser never accepted either.
 *
 * This is also the one bound that cannot be enforced after the fact: `rrule`
 * only compares UNTIL against candidates that survive the BY* filters, so a
 * rule whose selectors can never match (`BYMONTH=2;BYMONTHDAY=30`) walks every
 * period from DTSTART to year 9999 without ever calling back. At DAILY that is
 * a few seconds; at SECONDLY it would never finish.
 */
function assertExpandableFrequency(options: Partial<RRuleOptions>): void {
	const name = options.freq === undefined || options.freq === null
		? undefined
		: FREQUENCY_NAMES[options.freq];
	if (name) {
		throw new Error(`FREQ=${name} recurrence is not supported in daily notes.`);
	}
}

/** Longest possible length of each month; February allows for leap years. */
const LONGEST_MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function numberList(value: number | number[] | null | undefined): number[] {
	if (value === null || value === undefined) return [];
	return (Array.isArray(value) ? value : [value]).filter((item) => Number.isInteger(item));
}

/**
 * Rejects BYMONTH/BYMONTHDAY pairs that no calendar date can satisfy, such as
 * `BYMONTH=2;BYMONTHDAY=30`. For the same reason as `assertExpandableFrequency`,
 * `rrule` cannot discover this itself: with nothing surviving the filters it
 * never reaches its UNTIL check and walks to year 9999 instead.
 *
 * Deliberately conservative — it only looks at whether a month can contain the
 * requested day, so it can never reject a rule that some date does satisfy.
 */
function assertSatisfiableMonthDays(options: Partial<RRuleOptions>): void {
	const monthDays = numberList(options.bymonthday);
	if (monthDays.length === 0) return;
	const months = numberList(options.bymonth).filter((month) => month >= 1 && month <= 12);
	const candidateMonths = months.length > 0 ? months : LONGEST_MONTH_LENGTHS.map((_, index) => index + 1);
	const satisfiable = candidateMonths.some((month) => {
		const longest = LONGEST_MONTH_LENGTHS[month - 1];
		return monthDays.some((day) => day !== 0 && Math.abs(day) <= longest);
	});
	if (!satisfiable) {
		throw new Error("Recurrence selects a month day that no month in BYMONTH contains.");
	}
}

function addUtcMonths(date: Date, months: number): Date | null {
	const day = date.getUTCDate();
	const shifted = new Date(Date.UTC(
		date.getUTCFullYear(),
		date.getUTCMonth() + months,
		day,
		date.getUTCHours(),
		date.getUTCMinutes(),
		date.getUTCSeconds(),
		date.getUTCMilliseconds()
	));
	// Date.UTC rolls a nonexistent day into the next month (Feb 31 becomes Mar 3),
	// which would change the month day MONTHLY/YEARLY rules infer from DTSTART.
	return shifted.getUTCDate() === day ? shifted : null;
}

/**
 * Advances DTSTART forward by whole recurrence periods so expansion begins just
 * before the queried window instead of walking every period since the series
 * began — a weekly meeting standing since 2015 costs a handful of periods
 * instead of six hundred.
 *
 * Stepping by a whole multiple of INTERVAL preserves both the interval
 * alignment and the BY* parts rrule infers from DTSTART, so every occurrence
 * inside the window is unchanged. COUNT is anchored to the real DTSTART, so
 * those rules are left alone; they are self-limiting anyway.
 */
function clampedDtstart(options: Partial<RRuleOptions>, dtstart: Date, queryStart: Date): Date {
	if (options.count !== undefined && options.count !== null) return dtstart;
	if (options.freq === undefined || options.freq === null) return dtstart;
	const behindMs = queryStart.getTime() - dtstart.getTime();
	if (behindMs <= 0) return dtstart;
	const interval = Math.max(1, options.interval ?? 1);
	const fixedPeriodMs = FIXED_PERIOD_MS[options.freq];
	if (fixedPeriodMs !== undefined) {
		const stepMs = fixedPeriodMs * interval;
		const periods = Math.floor(behindMs / stepMs);
		return periods > 0 ? new Date(dtstart.getTime() + periods * stepMs) : dtstart;
	}
	const monthsPerPeriod =
		options.freq === RRule.MONTHLY ? interval
		: options.freq === RRule.YEARLY ? interval * 12
		: 0;
	if (monthsPerPeriod === 0) return dtstart;
	const monthsBehind =
		(queryStart.getUTCFullYear() - dtstart.getUTCFullYear()) * 12
		+ queryStart.getUTCMonth() - dtstart.getUTCMonth();
	let periods = Math.floor(monthsBehind / monthsPerPeriod);
	// A Feb 29 or day-31 DTSTART cannot land on every period boundary; step back
	// until one exists. Bounded so a hostile DTSTART cannot spin here either.
	for (let attempt = 0; attempt < 24 && periods > 0; attempt += 1, periods -= 1) {
		const shifted = addUtcMonths(dtstart, periods * monthsPerPeriod);
		if (shifted && shifted.getTime() <= queryStart.getTime()) return shifted;
	}
	return dtstart;
}

function normalizeRule(property: Property, start: ParsedDate, queryStart: Date): RRule {
	const options = RRule.parseString(property.value);
	assertExpandableFrequency(options);
	assertSatisfiableMonthDays(options);
	const dtstart = recurrenceWallDate(start, start.timeZone);
	options.tzid = null;
	const untilValue = property.value.match(/(?:^|;)UNTIL=([^;]+)/i)?.[1];
	if (untilValue) {
		const parsedUntil = parseDate({
			value: untilValue,
			params: untilValue.endsWith("Z") ? {} : start.allDay ? { VALUE: "DATE" } : { TZID: start.timeZone },
		}, start.timeZone);
		if (!parsedUntil) throw new Error(`Invalid recurrence UNTIL value: ${untilValue}`);
		options.until = recurrenceWallDate(parsedUntil, start.timeZone);
	}
	options.dtstart = clampedDtstart(options, dtstart, queryStart);
	return new RRule(options, true);
}

/** Mutable per-feed allowance shared by every event's recurrence expansion. */
interface ExpansionBudget {
	periods: number;
}

function recurrenceDates(
	raw: RawEvent,
	start: ParsedDate,
	rangeStart: Date,
	rangeEnd: Date,
	durationMs: number,
	remaining: number,
	budget: ExpansionBudget
): ParsedDate[] | null {
	const rules = raw.properties.get("RRULE") ?? [];
	const exclusionRules = raw.properties.get("EXRULE") ?? [];
	const recurrenceDates = raw.properties.get("RDATE") ?? [];
	if (rules.length === 0 && exclusionRules.length === 0 && recurrenceDates.length === 0) return null;
	// RRule operates on UTC-shaped wall-clock values. Two days of padding covers
	// every IANA offset; duration padding also includes events already in progress.
	const queryStart = new Date(rangeStart.getTime() - durationMs - 2 * 86_400_000);
	const queryEnd = new Date(rangeEnd.getTime() + 2 * 86_400_000);
	try {
		const included = new Map<number, Date>();
		const excluded = new Set<number>();
		let generated = 0;
		const addRuleDates = (property: Property, target: Map<number, Date> | Set<number>): void => {
			const startMs = queryStart.getTime();
			const endMs = queryEnd.getTime();
			// `all` reports every period rrule walks, unlike `between`, which only
			// reports the ones already inside the window — that is what makes the
			// period budget below an actual bound on the work done.
			normalizeRule(property, start, queryStart).all((date) => {
				budget.periods -= 1;
				if (budget.periods < 0) {
					throw new RecurrenceLimitError(
						"The iCalendar feed has a recurrence rule too expensive to expand safely."
					);
				}
				const timestamp = date.getTime();
				if (timestamp > endMs) return false;
				if (timestamp < startMs) return true;
				generated += 1;
				if (generated > MAX_EXPANDED_EVENTS) {
					throw new RecurrenceLimitError(EXPANSION_LIMIT_MESSAGE);
				}
				if (target instanceof Map) target.set(timestamp, date);
				else target.add(timestamp);
				return true;
			});
		};
		for (const property of rules) addRuleDates(property, included);
		for (const property of exclusionRules) addRuleDates(property, excluded);
		const firstWall = recurrenceWallDate(start, start.timeZone);
		included.set(firstWall.getTime(), firstWall);
		for (const property of recurrenceDates) {
			for (const value of property.value.split(",")) {
				generated += 1;
				if (generated > MAX_EXPANDED_EVENTS) {
					throw new RecurrenceLimitError(EXPANSION_LIMIT_MESSAGE);
				}
				const parsed = parseDate({ ...property, value }, start.timeZone);
				if (!parsed) throw new Error(`Unsupported or invalid RDATE value: ${value}`);
				const wall = recurrenceWallDate(parsed, start.timeZone);
				included.set(wall.getTime(), wall);
			}
		}
		for (const property of raw.properties.get("EXDATE") ?? []) {
			for (const value of property.value.split(",")) {
				const parsed = parseDate({ ...property, value }, start.timeZone);
				if (!parsed) throw new Error(`Unsupported or invalid EXDATE value: ${value}`);
				excluded.add(recurrenceWallDate(parsed, start.timeZone).getTime());
			}
		}
		const walls = [...included]
			.filter(([timestamp]) => !excluded.has(timestamp))
			.map(([, date]) => date)
			.sort((left, right) => left.getTime() - right.getTime());
		if (walls.length > remaining) throw new RecurrenceLimitError(EXPANSION_LIMIT_MESSAGE);
		return walls.map((wall) => occurrenceDate(start, wall));
	} catch (error) {
		if (error instanceof RecurrenceLimitError) throw error;
		const summary = unescapeText(first(raw, "SUMMARY")?.value ?? "(untitled event)");
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not expand recurrence for "${summary}": ${detail}`);
	}
}

function attendee(property: Property): GoogleEventAttendee | null {
	const email = property.value.replace(/^mailto:/i, "").trim();
	if (!email) return null;
	const partstat = property.params.PARTSTAT?.toLowerCase();
	const allowed = ["needsaction", "declined", "tentative", "accepted"];
	return {
		email,
		...(property.params.CN ? { displayName: unescapeText(property.params.CN) } : {}),
		...(allowed.includes(partstat) ? { responseStatus: partstat === "needsaction" ? "needsAction" : partstat as GoogleEventAttendee["responseStatus"] } : {}),
	};
}

function toGoogleEvent(raw: RawEvent, uid: string, original: ParsedDate, actual: ParsedDate, durationMs: number, recurring: boolean): GoogleEvent {
	const endInstant = new Date(actual.date.getTime() + durationMs);
	const summary = unescapeText(first(raw, "SUMMARY")?.value ?? "(untitled event)");
	const statusValue = first(raw, "STATUS")?.value.toLowerCase();
	const status = statusValue === "cancelled" || statusValue === "tentative" ? statusValue : "confirmed";
	const classValue = first(raw, "CLASS")?.value.toLowerCase();
	const visibility = classValue === "private" || classValue === "confidential" || classValue === "public" ? classValue : "default";
	const attendees = (raw.properties.get("ATTENDEE") ?? []).flatMap((property) => {
		const parsed = attendee(property);
		return parsed ? [parsed] : [];
	});
	const event: GoogleEvent = {
		id: recurring ? `${uid}:${original.allDay ? original.dateKey : original.date.toISOString()}` : uid,
		...(recurring ? { recurringEventId: uid, originalStartTime: original.allDay ? { date: original.dateKey } : { dateTime: original.date.toISOString(), timeZone: original.timeZone } } : {}),
		summary,
		...(first(raw, "DESCRIPTION") ? { description: unescapeText(first(raw, "DESCRIPTION")?.value ?? "") } : {}),
		...(first(raw, "LOCATION") ? { location: unescapeText(first(raw, "LOCATION")?.value ?? "") } : {}),
		status,
		visibility,
		transparency: first(raw, "TRANSP")?.value.toUpperCase() === "TRANSPARENT" ? "transparent" : "opaque",
		start: actual.allDay ? { date: actual.dateKey } : { dateTime: actual.date.toISOString() },
		end: actual.allDay ? { date: shiftDateKey(actual.dateKey, Math.max(1, Math.round(durationMs / 86_400_000))) } : { dateTime: endInstant.toISOString() },
		...(attendees.length ? { attendees } : {}),
	};
	return event;
}

function occurrenceIdentity(date: ParsedDate): string {
	return date.allDay ? date.dateKey : date.date.toISOString();
}

export function parseICalendar(text: string, rangeStart: Date, rangeEnd: Date, fallbackTimeZone: string): GoogleEvent[] {
	if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("The URL did not return an iCalendar feed.");
	const rawEvents = parseEvents(text);
	const overrides = new Map<string, RawEvent>();
	for (const event of rawEvents) {
		const uid = first(event, "UID")?.value.trim();
		const recurrenceId = first(event, "RECURRENCE-ID");
		const parsed = recurrenceId ? parseDate(recurrenceId, fallbackTimeZone) : null;
		if (uid && parsed) overrides.set(`${uid}::${occurrenceIdentity(parsed)}`, event);
	}
	const results: GoogleEvent[] = [];
	const budget: ExpansionBudget = { periods: MAX_RECURRENCE_PERIODS };
	for (const raw of rawEvents) {
		if (first(raw, "RECURRENCE-ID")) continue;
		const uid = first(raw, "UID")?.value.trim();
		const startProperty = first(raw, "DTSTART");
		if (!uid || !startProperty) continue;
		const start = parseDate(startProperty, fallbackTimeZone);
		if (!start) continue;
		const end = first(raw, "DTEND") ? parseDate(first(raw, "DTEND") as Property, fallbackTimeZone) : null;
		const durationMs = durationMilliseconds(raw, start, end);
		const occurrences = recurrenceDates(
			raw,
			start,
			rangeStart,
			rangeEnd,
			durationMs,
			MAX_EXPANDED_EVENTS - results.length,
			budget
		);
		if (!occurrences) {
			const event = toGoogleEvent(raw, uid, start, start, durationMs, false);
			if (start.date.getTime() < rangeEnd.getTime() && start.date.getTime() + durationMs > rangeStart.getTime()) results.push(event);
			continue;
		}
		for (const candidate of occurrences) {
			const identity = occurrenceIdentity(candidate);
			const override = overrides.get(`${uid}::${identity}`);
			const actualStart = override && first(override, "DTSTART") ? parseDate(first(override, "DTSTART") as Property, fallbackTimeZone) ?? candidate : candidate;
			const actualEnd = override && first(override, "DTEND") ? parseDate(first(override, "DTEND") as Property, fallbackTimeZone) : null;
			const actualDuration = override && (actualEnd || first(override, "DURATION"))
				? durationMilliseconds(override, actualStart, actualEnd)
				: durationMs;
			if (actualStart.date.getTime() < rangeEnd.getTime() && actualStart.date.getTime() + actualDuration > rangeStart.getTime()) {
				results.push(toGoogleEvent(override ?? raw, uid, candidate, actualStart, actualDuration, true));
			}
		}
	}
	if (results.length > MAX_EXPANDED_EVENTS) throw new RecurrenceLimitError(EXPANSION_LIMIT_MESSAGE);
	return results;
}

export async function refreshICalCalendar(deps: AuthDeps, calendar: ICalCalendarConfig, rangeStart: Date, rangeEnd: Date, signal?: AbortSignal): Promise<GoogleEvent[]> {
	const url = getICalUrl(deps, calendar.id);
	if (!url) throw new Error(`Secret iCal URL is missing for "${calendar.summary}".`);
	const response = await iCalRequest({ url, method: "GET", throw: false }, { signal });
	if (response.text.length > MAX_FEED_BYTES) throw new Error("The iCalendar feed is larger than the 5 MB safety limit.");
	const events = parseICalendar(response.text, rangeStart, rangeEnd, deps.settings.timezone);
	deps.settings.iCalCaches[calendar.id] = {
		updatedAt: Date.now(),
		...(response.headers.etag ? { etag: response.headers.etag } : {}),
		...(response.headers["last-modified"] ? { lastModified: response.headers["last-modified"] } : {}),
		events: Object.fromEntries(events.map((event) => [`${event.id ?? "event"}::${event.originalStartTime?.dateTime ?? event.originalStartTime?.date ?? ""}`, event as unknown as Record<string, unknown>])),
	};
	return events;
}
