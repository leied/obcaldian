import { requestUrl } from "obsidian";
import type { Moment } from "moment";
import type { AuthDeps } from "./googleAuth";
import { getValidAccessToken } from "./googleAuth";
import { zonedDayRange } from "./timezone";

export interface GoogleCalendarListEntry {
	id: string;
	summary: string;
}

export interface GoogleEventAttendee {
	email: string;
	displayName?: string;
}

export interface GoogleEvent {
	summary: string;
	description?: string;
	htmlLink?: string;
	start: { date?: string; dateTime?: string };
	end: { date?: string; dateTime?: string };
	attendees?: GoogleEventAttendee[];
}

export async function listCalendars(deps: AuthDeps): Promise<GoogleCalendarListEntry[]> {
	const accessToken = await getValidAccessToken(deps);
	const resp = await requestUrl({
		url: "https://www.googleapis.com/calendar/v3/users/me/calendarList",
		method: "GET",
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	const items = (resp.json.items ?? []) as Array<{ id: string; summary: string }>;
	return items.map((i) => ({ id: i.id, summary: i.summary }));
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
		orderBy: "startTime",
	});
	const resp = await requestUrl({
		url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
			calendarId
		)}/events?${params.toString()}`,
		method: "GET",
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	return (resp.json.items ?? []) as GoogleEvent[];
}
