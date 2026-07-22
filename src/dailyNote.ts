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
	const rendered = templateContent
		.replace(/\{\{date\}\}/g, date.format("YYYY-MM-DD"))
		.replace(CALENDAR_TOKEN, markerBlock(PLACEHOLDER_BODY));

	const folder = settings.dailyNoteFolder?.trim();
	if (folder && !vault.getAbstractFileByPath(normalizePath(folder))) {
		await vault.createFolder(normalizePath(folder));
	}

	return vault.create(path, rendered);
}

export function renderCalendarBlock(
	calendars: CalendarConfig[],
	eventsByCalendar: Map<string, GoogleEvent[]>
): string {
	const lines: string[] = [];
	for (const cal of calendars) {
		if (!cal.enabled) continue;
		const events = eventsByCalendar.get(cal.id) ?? [];
		if (events.length === 0) continue;
		lines.push(`**${cal.summary}**`);
		for (const ev of events) {
			const bullet = cal.addAs === "checkbox" ? "- [ ]" : "-";
			const time = ev.start.dateTime
				? window.moment(ev.start.dateTime).format("HH:mm")
				: null;
			const title = ev.summary || "(untitled event)";
			lines.push(time ? `${bullet} ${time} ${title}` : `${bullet} ${title}`);
		}
	}
	if (lines.length === 0) {
		return "_(no events)_";
	}
	return lines.join("\n");
}

/**
 * Replaces only the content between the calendar markers, leaving the rest
 * of the note untouched. Skips (with a Notice) if markers aren't present.
 */
export async function syncNoteCalendarSection(
	vault: Vault,
	file: TFile,
	renderedBlock: string
): Promise<boolean> {
	const content = await vault.read(file);
	const startIdx = content.indexOf(MARKER_START);
	const endIdx = content.indexOf(MARKER_END);
	if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
		new Notice(`Obcaldian: calendar markers not found in ${file.path}, skipping.`);
		return false;
	}
	const before = content.slice(0, startIdx);
	const after = content.slice(endIdx + MARKER_END.length);
	const next = `${before}${markerBlock(renderedBlock)}${after}`;
	await vault.modify(file, next);
	return true;
}
