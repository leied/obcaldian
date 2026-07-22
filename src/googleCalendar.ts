import { requestUrl } from "obsidian";
import type { Moment } from "moment";
import type { AuthDeps } from "./googleAuth";
import { getValidAccessToken } from "./googleAuth";

export interface GoogleCalendarListEntry {
	id: string;
	summary: string;
}

export interface GoogleEvent {
	summary: string;
	start: { date?: string; dateTime?: string };
	end: { date?: string; dateTime?: string };
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

/** Fetches all events on the given local calendar day for one Google calendar. */
export async function listEventsForDay(
	deps: AuthDeps,
	calendarId: string,
	date: Moment
): Promise<GoogleEvent[]> {
	const accessToken = await getValidAccessToken(deps);
	const timeMin = date.clone().startOf("day").toISOString();
	const timeMax = date.clone().endOf("day").toISOString();
	const params = new URLSearchParams({
		timeMin,
		timeMax,
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
