import { Notice, TFile, Vault } from "obsidian";
import type { Moment } from "moment";
import type { AuthDeps } from "./googleAuth";
import { listEventsForDay, type GoogleEvent } from "./googleCalendar";
import { ensureDailyNote, renderCalendarBlock, syncNoteCalendarSection } from "./dailyNote";

async function syncNoteForDate(vault: Vault, deps: AuthDeps, date: Moment, file?: TFile) {
	const settings = deps.settings;
	const enabled = settings.calendars.filter((c) => c.enabled);
	const eventsByCalendar = new Map<string, GoogleEvent[]>();

	for (const cal of enabled) {
		try {
			const events = await listEventsForDay(deps, cal.id, date);
			eventsByCalendar.set(cal.id, events);
		} catch (e) {
			new Notice(`Obcaldian: failed to fetch "${cal.summary}": ${(e as Error).message}`);
		}
	}

	const block = renderCalendarBlock(settings.calendars, eventsByCalendar);
	const noteFile = file ?? (await ensureDailyNote(vault, settings, date));
	await syncNoteCalendarSection(vault, noteFile, block);
}

/**
 * Syncs enabled Google calendars into today's and tomorrow's daily notes,
 * creating them from the template first if they don't exist yet.
 */
export async function syncAll(vault: Vault, deps: AuthDeps): Promise<void> {
	if (!deps.settings.tokens) {
		new Notice("Obcaldian: connect your Google account first.");
		return;
	}
	if (deps.settings.calendars.filter((c) => c.enabled).length === 0) {
		new Notice("Obcaldian: no calendars enabled — nothing to sync.");
		return;
	}

	const today = window.moment();
	const tomorrow = window.moment().add(1, "day");

	try {
		await syncNoteForDate(vault, deps, today);
		await syncNoteForDate(vault, deps, tomorrow);
		new Notice("Obcaldian: calendars synced.");
	} catch (e) {
		new Notice(`Obcaldian sync failed: ${(e as Error).message}`);
	}
}

/** Syncs a single, already-created note (used right after it's generated). */
export async function syncSingleNote(
	vault: Vault,
	deps: AuthDeps,
	date: Moment,
	file: TFile
): Promise<void> {
	if (!deps.settings.tokens) return;
	if (deps.settings.calendars.filter((c) => c.enabled).length === 0) return;
	try {
		await syncNoteForDate(vault, deps, date, file);
	} catch (e) {
		new Notice(`Obcaldian: initial calendar sync failed: ${(e as Error).message}`);
	}
}
