import { Notice, TFile, Vault, normalizePath } from "obsidian";
import type { Moment } from "moment";
import type { CalendarConfig, ObcaldianSettings } from "./settings";
import type { GoogleEvent } from "./googleCalendar";

const CALENDAR_TOKEN = "{calendar}";
const MARKER_START = "<!-- obcaldian:calendar:start -->";
const MARKER_END = "<!-- obcaldian:calendar:end -->";
const PLACEHOLDER_BODY = "_(not yet synced — click \"Sync now\" in Obcaldian settings)_";

function markerBlock(body: string): string {
	return `${MARKER_START}\n${body}\n${MARKER_END}`;
}

export function fileNameFor(date: Moment): string {
	return `${date.format("YYYYMMDD")}.md`;
}

export function notePathFor(settings: ObcaldianSettings, date: Moment): string {
	const folder = settings.dailyNoteFolder?.trim();
	const fileName = fileNameFor(date);
	return normalizePath(folder ? `${folder}/${fileName}` : fileName);
}

/**
 * Creates the daily note from the user's template if it doesn't already
 * exist. Never rewrites an existing note's body.
 */
export async function ensureDailyNote(
	vault: Vault,
	settings: ObcaldianSettings,
	date: Moment
): Promise<TFile> {
	const path = notePathFor(settings, date);
	const existing = vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		return existing;
	}

	if (!settings.templatePath) {
		throw new Error("Set a template file in Obcaldian settings first.");
	}
	const templateFile = vault.getAbstractFileByPath(normalizePath(settings.templatePath));
	if (!(templateFile instanceof TFile)) {
		throw new Error(`Template file not found: ${settings.templatePath}`);
	}

	const templateContent = await vault.read(templateFile);
	if (!templateContent.includes(CALENDAR_TOKEN)) {
		throw new Error(`Template must contain ${CALENDAR_TOKEN}: ${settings.templatePath}`);
	}
	const rendered = templateContent
		.replace(/\{\{date\}\}/g, date.format("YYYY-MM-DD"))
		.replace(CALENDAR_TOKEN, markerBlock(PLACEHOLDER_BODY));

	const folder = settings.dailyNoteFolder?.trim();
	if (folder && !vault.getAbstractFileByPath(normalizePath(folder))) {
		await vault.createFolder(normalizePath(folder));
	}

	return vault.create(path, rendered);
}

const FOOTNOTE_CONTINUATION_INDENT = "    ";
const MIN_ATTENDEES_TO_LIST = 3;

/**
 * Builds a footnote's body for an event: its description (if any), plus a
 * participant list when there are enough attendees to be worth naming. Lines
 * after the first are indented so markdown treats them as part of the same
 * footnote definition. Returns null when there's nothing worth footnoting.
 */
function footnoteBody(ev: GoogleEvent): string | null {
	const parts: string[] = [];
	const description = ev.description?.trim();
	if (description) parts.push(description);

	const attendees = ev.attendees ?? [];
	if (attendees.length >= MIN_ATTENDEES_TO_LIST) {
		const names = attendees.map((a) => a.displayName?.trim() || a.email).join(", ");
		parts.push(`Participants: ${names}`);
	}

	if (parts.length === 0) return null;
	return parts.join(`\n${FOOTNOTE_CONTINUATION_INDENT}`);
}

/** Formats a timed event's start (and end, if distinct) as "HH:mm" or "HH:mm-HH:mm". Null for all-day events. */
function formatTime(dateTime: string, timeZone: string): string {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(new Date(dateTime));
}

function formatTimeRange(ev: GoogleEvent, timeZone: string): string | null {
	if (!ev.start.dateTime) return null;
	const start = formatTime(ev.start.dateTime, timeZone);
	const end = ev.end.dateTime ? formatTime(ev.end.dateTime, timeZone) : null;
	return end && end !== start ? `${start}-${end}` : start;
}

export function renderCalendarBlock(
	calendars: CalendarConfig[],
	eventsByCalendar: Map<string, GoogleEvent[]>,
	timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
): string {
	const lines: string[] = [];
	const footnotes: string[] = [];
	let footnoteCount = 0;

	for (const cal of calendars) {
		if (!cal.enabled) continue;
		const events = eventsByCalendar.get(cal.id) ?? [];
		if (events.length === 0) continue;
		lines.push(`**${cal.summary}**`);
		for (const ev of events) {
			const bullet = cal.addAs === "checkbox" ? "- [ ]" : "-";
			const time = formatTimeRange(ev, timeZone);
			const rawTitle = ev.summary || "(untitled event)";
			const title = ev.htmlLink ? `[${rawTitle}](${ev.htmlLink})` : rawTitle;

			let marker = "";
			const body = footnoteBody(ev);
			if (body) {
				footnoteCount += 1;
				marker = `[^${footnoteCount}]`;
				footnotes.push(`[^${footnoteCount}]: ${body}`);
			}

			lines.push(time ? `${bullet} ${time} ${title}${marker}` : `${bullet} ${title}${marker}`);
		}
	}
	if (lines.length === 0) {
		return "_(no events)_";
	}
	if (footnotes.length === 0) {
		return lines.join("\n");
	}
	return `${lines.join("\n")}\n\n${footnotes.join("\n")}`;
}

/**
 * Replaces only the content between the calendar markers, leaving the rest
 * of the note untouched. Skips (with a Notice) if markers aren't present.
 */
export async function syncNoteCalendarSection(
	vault: Vault,
	file: TFile,
	renderedBlock: string,
	notify = true
): Promise<boolean> {
	const content = await vault.read(file);
	const startIdx = content.indexOf(MARKER_START);
	const endIdx =
		startIdx === -1 ? -1 : content.indexOf(MARKER_END, startIdx + MARKER_START.length);
	if (startIdx === -1 || endIdx === -1) {
		if (notify) {
			new Notice(`Obcaldian: calendar markers not found in ${file.path}, skipping.`);
		}
		return false;
	}
	const before = content.slice(0, startIdx);
	const after = content.slice(endIdx + MARKER_END.length);
	const next = `${before}${markerBlock(renderedBlock)}${after}`;
	await vault.modify(file, next);
	return true;
}
