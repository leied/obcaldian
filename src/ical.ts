import type { AuthDeps } from "./googleAuth";
import type { GoogleEvent, GoogleEventAttendee } from "./googleCalendar";
import { iCalRequest, assertSafeICalUrl } from "./network";
import type { ICalCalendarConfig } from "./settings";
import { isValidTimeZone, zonedDateTime } from "./timezone";

const MAX_FEED_BYTES = 5_000_000;
const MAX_EXPANDED_EVENTS = 5_000;
const MAX_RECURRENCE_DAYS = 36_600;

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

interface RecurrenceRule {
	freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
	interval: number;
	count?: number;
	until?: Date;
	byDay: string[];
	byMonthDay: number[];
	byMonth: number[];
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

function dateOrdinal(key: string): number {
	return Math.floor(new Date(`${key}T00:00:00.000Z`).getTime() / 86_400_000);
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function localParts(key: string): { year: number; month: number; day: number; weekday: number } {
	const [year, month, day] = key.split("-").map(Number);
	return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRule(property: Property | undefined, fallbackTimeZone: string): RecurrenceRule | null {
	if (!property) return null;
	const values = new Map(property.value.split(";").flatMap((part) => {
		const index = part.indexOf("=");
		return index > 0 ? [[part.slice(0, index).toUpperCase(), part.slice(index + 1)]] : [];
	}));
	const freq = values.get("FREQ");
	if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
	const interval = Math.max(1, Number.parseInt(values.get("INTERVAL") ?? "1", 10) || 1);
	const countValue = Number.parseInt(values.get("COUNT") ?? "", 10);
	const untilValue = values.get("UNTIL");
	const untilParsed = untilValue ? parseDate({ value: untilValue, params: {} }, fallbackTimeZone) : null;
	const until = untilParsed
		? new Date(untilParsed.date.getTime() + (untilParsed.allDay ? 86_400_000 - 1 : 0))
		: undefined;
	return {
		freq,
		interval,
		...(countValue > 0 ? { count: countValue } : {}),
		...(until ? { until } : {}),
		byDay: (values.get("BYDAY") ?? "").split(",").filter(Boolean),
		byMonthDay: (values.get("BYMONTHDAY") ?? "").split(",").filter(Boolean).map(Number).filter((value) => Number.isFinite(value) && value !== 0),
		byMonth: (values.get("BYMONTH") ?? "").split(",").map(Number).filter((value) => value >= 1 && value <= 12),
	};
}

function matchesByDay(key: string, byDay: string[]): boolean {
	if (byDay.length === 0) return true;
	const { year, month, day, weekday } = localParts(key);
	return byDay.some((token) => {
		const match = token.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
		if (!match || WEEKDAYS[match[2]] !== weekday) return false;
		if (!match[1]) return true;
		const ordinal = Number(match[1]);
		if (ordinal > 0) return Math.ceil(day / 7) === ordinal;
		return Math.ceil((daysInMonth(year, month) - day + 1) / 7) === Math.abs(ordinal);
	});
}

function recurrenceMatches(key: string, startKey: string, rule: RecurrenceRule): boolean {
	const candidate = localParts(key);
	const start = localParts(startKey);
	const days = dateOrdinal(key) - dateOrdinal(startKey);
	if (days < 0) return false;
	if (rule.byMonth.length > 0 && !rule.byMonth.includes(candidate.month)) return false;
	if (rule.byMonthDay.length > 0 && !rule.byMonthDay.some((value) => value === candidate.day || (value < 0 && daysInMonth(candidate.year, candidate.month) + value + 1 === candidate.day))) return false;
	if (!matchesByDay(key, rule.byDay)) return false;
	if (rule.freq === "DAILY") return days % rule.interval === 0;
	if (rule.freq === "WEEKLY") {
		if (Math.floor(days / 7) % rule.interval !== 0) return false;
		return rule.byDay.length > 0 || candidate.weekday === start.weekday;
	}
	const months = (candidate.year - start.year) * 12 + candidate.month - start.month;
	if (rule.freq === "MONTHLY") {
		if (months < 0 || months % rule.interval !== 0) return false;
		return rule.byMonthDay.length > 0 || rule.byDay.length > 0 || candidate.day === start.day;
	}
	const years = candidate.year - start.year;
	if (years < 0 || years % rule.interval !== 0) return false;
	return rule.byMonth.length > 0 || rule.byMonthDay.length > 0 || rule.byDay.length > 0
		? true
		: candidate.month === start.month && candidate.day === start.day;
}

function durationMilliseconds(event: RawEvent, start: ParsedDate, end: ParsedDate | null): number {
	if (end) return Math.max(1, end.date.getTime() - start.date.getTime());
	const duration = first(event, "DURATION")?.value;
	const match = duration?.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
	if (match) return ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 60 * 60 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0)) * 1000;
	return start.allDay ? 86_400_000 : 3_600_000;
}

function occurrenceDate(start: ParsedDate, candidateKey: string): ParsedDate {
	if (start.allDay) return { ...start, dateKey: candidateKey, date: new Date(`${candidateKey}T00:00:00.000Z`) };
	const [year, month, day] = candidateKey.split("-").map(Number);
	const formatted = new Intl.DateTimeFormat("en-US", { timeZone: start.timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(start.date);
	const parts = Object.fromEntries(formatted.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
	return { ...start, dateKey: candidateKey, date: zonedDateTime(year, month, day, Number(parts.hour) % 24, Number(parts.minute), Number(parts.second), start.timeZone) };
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
	for (const raw of rawEvents) {
		if (first(raw, "RECURRENCE-ID")) continue;
		const uid = first(raw, "UID")?.value.trim();
		const startProperty = first(raw, "DTSTART");
		if (!uid || !startProperty) continue;
		const start = parseDate(startProperty, fallbackTimeZone);
		if (!start) continue;
		const end = first(raw, "DTEND") ? parseDate(first(raw, "DTEND") as Property, fallbackTimeZone) : null;
		const durationMs = durationMilliseconds(raw, start, end);
		const rule = parseRule(first(raw, "RRULE"), fallbackTimeZone);
		const exclusions = new Set((raw.properties.get("EXDATE") ?? []).flatMap((property) => property.value.split(",").flatMap((value) => {
			const parsed = parseDate({ ...property, value }, fallbackTimeZone);
			return parsed ? [occurrenceIdentity(parsed)] : [];
		})));
		if (!rule) {
			const event = toGoogleEvent(raw, uid, start, start, durationMs, false);
			if (start.date.getTime() < rangeEnd.getTime() && start.date.getTime() + durationMs > rangeStart.getTime()) results.push(event);
			continue;
		}
		let emitted = 0;
		const startOrdinal = dateOrdinal(start.dateKey);
		const scanEnd = Math.min(dateOrdinal(rangeEnd.toISOString().slice(0, 10)) + 2, startOrdinal + MAX_RECURRENCE_DAYS);
		for (let ordinal = startOrdinal; ordinal <= scanEnd && results.length < MAX_EXPANDED_EVENTS; ordinal += 1) {
			const candidateKey = new Date(ordinal * 86_400_000).toISOString().slice(0, 10);
			if (!recurrenceMatches(candidateKey, start.dateKey, rule)) continue;
			const candidate = occurrenceDate(start, candidateKey);
			if (rule.until && candidate.date.getTime() > rule.until.getTime()) break;
			emitted += 1;
			if (rule.count && emitted > rule.count) break;
			const identity = occurrenceIdentity(candidate);
			if (exclusions.has(identity)) continue;
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
	if (results.length >= MAX_EXPANDED_EVENTS) throw new Error(`The iCalendar feed expands beyond ${MAX_EXPANDED_EVENTS} events for this range.`);
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
