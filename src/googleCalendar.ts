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

interface GoogleListResponse<T> {
	items?: T[];
	nextPageToken?: string;
}

async function getAllPages<T>(
	url: string,
	accessToken: string,
	params: URLSearchParams = new URLSearchParams()
): Promise<T[]> {
	const items: T[] = [];
	let pageToken: string | undefined;
	do {
		const pageParams = new URLSearchParams(params);
		if (pageToken) pageParams.set("pageToken", pageToken);
		const query = pageParams.toString();
		const resp = await requestUrl({
			url: query ? `${url}?${query}` : url,
			method: "GET",
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		const data = resp.json as GoogleListResponse<T>;
		items.push(...(data.items ?? []));
		pageToken = data.nextPageToken;
	} while (pageToken);
	return items;
}

export async function listCalendars(deps: AuthDeps): Promise<GoogleCalendarListEntry[]> {
	const accessToken = await getValidAccessToken(deps);
	const items = await getAllPages<{ id: string; summary: string }>(
		"https://www.googleapis.com/calendar/v3/users/me/calendarList",
		accessToken,
		new URLSearchParams({ maxResults: "250" })
	);
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
		maxResults: "2500",
	});
	return getAllPages<GoogleEvent>(
		`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
		accessToken,
		params
	);
}
