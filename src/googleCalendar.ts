import type { Moment } from "moment";
import type { AuthDeps } from "./googleAuth";
import { getValidAccessToken, googleAccount } from "./googleAuth";
import { googleRequest } from "./network";
import { GoogleHttpError } from "./network";
import { zonedDayRange } from "./timezone";
import type { CalendarEventCache } from "./settings";

export interface GoogleCalendarListEntry {
	id: string;
	summary: string;
	colorId?: string;
	backgroundColor?: string;
}

export interface GoogleEventAttendee {
	email: string;
	displayName?: string;
	self?: boolean;
	responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
}

export interface GoogleEvent {
	/** Stable Google event-instance ID. Present in API responses; optional for defensive rendering. */
	id?: string;
	summary: string;
	description?: string;
	location?: string;
	htmlLink?: string;
	hangoutLink?: string;
	status?: "confirmed" | "tentative" | "cancelled";
	visibility?: "default" | "public" | "private" | "confidential";
	transparency?: "opaque" | "transparent";
	eventType?: "default" | "birthday" | "focusTime" | "fromGmail" | "outOfOffice" | "workingLocation";
	recurringEventId?: string;
	originalStartTime?: { date?: string; dateTime?: string; timeZone?: string };
	start: { date?: string; dateTime?: string };
	end: { date?: string; dateTime?: string };
	attendees?: GoogleEventAttendee[];
}

interface GoogleListResponse<T> {
	items?: T[];
	nextPageToken?: string;
	nextSyncToken?: string;
}

interface GooglePageResult<T> {
	items: T[];
	nextSyncToken?: string;
}

const SUPPORTED_EVENT_TYPES = [
	"default",
	"birthday",
	"focusTime",
	"fromGmail",
	"outOfOffice",
	"workingLocation",
];

function appendSupportedEventTypes(params: URLSearchParams): void {
	for (const eventType of SUPPORTED_EVENT_TYPES) params.append("eventTypes", eventType);
}

async function getAllPages<T>(
	url: string,
	accessToken: string,
	params: URLSearchParams = new URLSearchParams()
): Promise<GooglePageResult<T>> {
	const items: T[] = [];
	let pageToken: string | undefined;
	let nextSyncToken: string | undefined;
	do {
		const pageParams = new URLSearchParams(params);
		if (pageToken) pageParams.set("pageToken", pageToken);
		const query = pageParams.toString();
		const resp = await googleRequest({
			url: query ? `${url}?${query}` : url,
			method: "GET",
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		const data = resp.json as GoogleListResponse<T>;
		items.push(...(data.items ?? []));
		pageToken = data.nextPageToken;
		nextSyncToken = data.nextSyncToken ?? nextSyncToken;
	} while (pageToken);
	return { items, nextSyncToken };
}

export async function listCalendars(deps: AuthDeps): Promise<GoogleCalendarListEntry[]> {
	const accessToken = await getValidAccessToken(deps);
	const result = await getAllPages<{
		id: string;
		summary: string;
		colorId?: string;
		backgroundColor?: string;
	}>(
		"https://www.googleapis.com/calendar/v3/users/me/calendarList",
		accessToken,
		new URLSearchParams({ maxResults: "250" })
	);
	return result.items.map((item) => ({
		id: item.id,
		summary: item.summary,
		...(item.colorId ? { colorId: item.colorId } : {}),
		...(item.backgroundColor ? { backgroundColor: item.backgroundColor } : {}),
	}));
}

/** Fetches all events on the given calendar day (in the configured time zone) for one Google calendar. */
export async function listEventsForDay(
	deps: AuthDeps,
	calendarId: string,
	date: Moment
): Promise<GoogleEvent[]> {
	const accessToken = await getValidAccessToken(deps);
	const { start, end } = zonedDayRange(
		date.year(),
		date.month() + 1,
		date.date(),
		deps.settings.timezone
	);
	const params = new URLSearchParams({
		timeMin: start.toISOString(),
		timeMax: end.toISOString(),
		timeZone: deps.settings.timezone,
		singleEvents: "true",
		showDeleted: "true",
		orderBy: "startTime",
		maxResults: "2500",
	});
	appendSupportedEventTypes(params);
	return (
		await getAllPages<GoogleEvent>(
		`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
		accessToken,
		params
		)
	).items;
}

function cacheEventKey(event: GoogleEvent): string | null {
	if (!event.id) return null;
	const originalStart = event.originalStartTime?.dateTime ?? event.originalStartTime?.date ?? "";
	return `${event.id}::${originalStart}`;
}

function storedEvent(value: Record<string, unknown>): GoogleEvent | null {
	const candidate = value as unknown as GoogleEvent;
	if (
		typeof candidate.id !== "string" ||
		!candidate.id ||
		typeof candidate.summary !== "string" ||
		typeof candidate.start !== "object" ||
		candidate.start === null ||
		typeof candidate.end !== "object" ||
		candidate.end === null
	) {
		return null;
	}
	return candidate;
}

export function calendarCacheEvents(deps: AuthDeps, calendarId: string): GoogleEvent[] {
	const cache = googleAccount(deps).calendarCaches[calendarId];
	if (!cache) return [];
	return Object.values(cache.events).flatMap((value) => {
		const event = storedEvent(value);
		return event ? [event] : [];
	});
}

/**
 * Only these are ever read back. A Google event resource also carries
 * `conferenceData`, `reminders`, `creator`, `organizer`, `extendedProperties`,
 * `etag` and more, none of which this plugin renders — and the cache lives in
 * plaintext `data.json`, so keeping them costs disk and needlessly parks other
 * people's data at rest.
 */
const CACHED_EVENT_FIELDS = [
	"id",
	"summary",
	"description",
	"location",
	"htmlLink",
	"hangoutLink",
	"status",
	"visibility",
	"transparency",
	"eventType",
	"recurringEventId",
	"originalStartTime",
	"start",
	"end",
] as const;

const CACHED_ATTENDEE_FIELDS = ["email", "displayName", "self", "responseStatus"] as const;

function project<T extends object>(source: T, fields: readonly string[]): Record<string, unknown> {
	const record: Record<string, unknown> = {};
	for (const field of fields) {
		const value = (source as Record<string, unknown>)[field];
		if (value !== undefined) record[field] = value;
	}
	return record;
}

function eventRecord(event: GoogleEvent): Record<string, unknown> {
	const record = project(event, CACHED_EVENT_FIELDS);
	if (event.attendees) {
		record.attendees = event.attendees.map((attendee) =>
			project(attendee, CACHED_ATTENDEE_FIELDS)
		);
	}
	return record;
}

/** Days of already-finished events kept so moved annotations can still be found. */
const CACHE_RETENTION_DAYS = 30;

function endedBefore(event: GoogleEvent, cutoff: number): boolean {
	// All-day ends are exclusive, so `end.date` is already the morning after.
	const end = event.end.dateTime ?? (event.end.date ? `${event.end.date}T00:00:00Z` : null);
	const parsed = end ? Date.parse(end) : Number.NaN;
	return Number.isFinite(parsed) && parsed < cutoff;
}

/**
 * Incremental syncs only ever merge events in — without this the cache keeps
 * every event and every deletion tombstone the calendar has ever had. Anything
 * that ended before the retention window is dropped, and `coverageStart` moves
 * up with it so a later request for those days rebuilds from Google instead of
 * trusting a cache that no longer holds them.
 */
export function pruneCalendarCache(
	cache: CalendarEventCache,
	requiredStart: Date,
	now = Date.now()
): void {
	const cutoff = Math.min(now - CACHE_RETENTION_DAYS * 86_400_000, requiredStart.getTime());
	for (const [key, value] of Object.entries(cache.events)) {
		const event = storedEvent(value);
		if (!event || endedBefore(event, cutoff)) delete cache.events[key];
	}
	if (Date.parse(cache.coverageStart) < cutoff) {
		cache.coverageStart = new Date(cutoff).toISOString();
	}
}

function mergeEventChange(
	events: Record<string, Record<string, unknown>>,
	change: GoogleEvent
): void {
	const key = cacheEventKey(change);
	if (!key) return;
	const previous = events[key] ? storedEvent(events[key]) : null;
	let merged = previous ? { ...previous, ...change } : change;
	if ((!merged.start || !merged.end) && change.originalStartTime) {
		const fallback = {
			...(change.originalStartTime.date ? { date: change.originalStartTime.date } : {}),
			...(change.originalStartTime.dateTime
				? { dateTime: change.originalStartTime.dateTime }
				: {}),
		};
		merged = {
			...merged,
			summary: merged.summary || "Cancelled event",
			start: merged.start ?? fallback,
			end: merged.end ?? fallback,
		};
	}
	if (merged.start && merged.end) events[key] = eventRecord(merged);
}

async function fullCalendarSync(
	deps: AuthDeps,
	calendarId: string,
	coverageStart: Date
): Promise<GoogleEvent[]> {
	const accessToken = await getValidAccessToken(deps);
	const params = new URLSearchParams({
		timeMin: coverageStart.toISOString(),
		timeZone: deps.settings.timezone,
		singleEvents: "true",
		showDeleted: "true",
		maxResults: "2500",
	});
	appendSupportedEventTypes(params);
	const result = await getAllPages<GoogleEvent>(
		`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
		accessToken,
		params
	);
	if (!result.nextSyncToken) throw new Error("Google did not return an incremental sync token.");
	const events: Record<string, Record<string, unknown>> = {};
	for (const event of result.items) mergeEventChange(events, event);
	googleAccount(deps).calendarCaches[calendarId] = {
		syncToken: result.nextSyncToken,
		coverageStart: coverageStart.toISOString(),
		updatedAt: Date.now(),
		events,
	};
	return calendarCacheEvents(deps, calendarId);
}

/** Refreshes one calendar cache with an incremental token, rebuilding it after HTTP 410. */
export async function refreshCalendarCache(
	deps: AuthDeps,
	calendarId: string,
	requiredStart: Date
): Promise<GoogleEvent[]> {
	const account = googleAccount(deps);
	const cache = account.calendarCaches[calendarId];
	if (!cache || Date.parse(cache.coverageStart) > requiredStart.getTime()) {
		return fullCalendarSync(deps, calendarId, requiredStart);
	}
	const accessToken = await getValidAccessToken(deps);
	const params = new URLSearchParams({
		syncToken: cache.syncToken,
		singleEvents: "true",
		showDeleted: "true",
		maxResults: "2500",
	});
	appendSupportedEventTypes(params);
	try {
		const result = await getAllPages<GoogleEvent>(
			`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
			accessToken,
			params
		);
		if (!result.nextSyncToken) {
			throw new Error("Google did not return the next incremental sync token.");
		}
		for (const event of result.items) mergeEventChange(cache.events, event);
		cache.syncToken = result.nextSyncToken;
		cache.updatedAt = Date.now();
		pruneCalendarCache(cache, requiredStart);
		return calendarCacheEvents(deps, calendarId);
	} catch (error) {
		if (error instanceof GoogleHttpError && error.status === 410) {
			delete account.calendarCaches[calendarId];
			return fullCalendarSync(deps, calendarId, requiredStart);
		}
		throw error;
	}
}

/** Filters the local collection cache to events overlapping one configured-timezone day. */
export function cachedEventsForDay(
	events: readonly GoogleEvent[],
	date: Moment,
	timeZone: string
): GoogleEvent[] {
	const dateKey = date.format("YYYY-MM-DD");
	const { start, end } = zonedDayRange(date.year(), date.month() + 1, date.date(), timeZone);
	return events.filter((event) => {
		const eventStartDate = event.start.date ?? event.originalStartTime?.date;
		const eventEndDate = event.end.date;
		if (eventStartDate) {
			return eventEndDate
				? eventStartDate <= dateKey && eventEndDate > dateKey
				: eventStartDate === dateKey;
		}
		const startValue = event.start.dateTime ?? event.originalStartTime?.dateTime;
		if (!startValue) return false;
		const startInstant = new Date(startValue).getTime();
		const endInstant = event.end.dateTime
			? new Date(event.end.dateTime).getTime()
			: startInstant + 1;
		return startInstant < end.getTime() && endInstant > start.getTime();
	});
}
