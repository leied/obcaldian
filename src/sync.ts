import { Notice, TFile, Vault } from "obsidian";
import type { Moment } from "moment";
import type { AuthDeps } from "./googleAuth";
import { isConnected } from "./googleAuth";
import { listEventsForDay, type GoogleEvent } from "./googleCalendar";
import { ensureDailyNote, renderCalendarBlock, syncNoteCalendarSection } from "./dailyNote";

async function syncNoteForDate(
	vault: Vault,
	deps: AuthDeps,
	date: Moment,
	notify: boolean,
	file?: TFile
) {
	const settings = deps.settings;
	const enabled = settings.calendars.filter((c) => c.enabled);
	const eventsByCalendar = new Map<string, GoogleEvent[]>();

	for (const cal of enabled) {
		try {
			const events = await listEventsForDay(deps, cal.id, date);
			eventsByCalendar.set(cal.id, events);
		} catch (e) {
			if (notify) {
				new Notice(`Obcaldian: failed to fetch "${cal.summary}": ${(e as Error).message}`);
			} else {
				console.error(`Obcaldian: background sync failed to fetch "${cal.summary}"`, e);
			}
		}
	}

	const block = renderCalendarBlock(settings.calendars, eventsByCalendar);
	const noteFile = file ?? (await ensureDailyNote(vault, settings, date));
	await syncNoteCalendarSection(vault, noteFile, block);
}

export interface SyncOptions {
	/** Whether to surface progress/result as Notices. Defaults to true. Set false for silent background syncs. */
	notify?: boolean;
	/** Fired once the connected/enabled-calendars checks pass, before any fetching starts. */
	onStart?: () => void;
	/** Fired after every requested day synced successfully. */
	onSuccess?: (dayCount: number) => void;
	/** Fired on a hard failure, or when the connected/enabled-calendars precondition fails. */
	onError?: (message: string) => void;
}

/**
 * Syncs enabled Google calendars into today's daily note plus `daysAhead`
 * days beyond it, creating each note from the template first if needed.
 */
export async function syncRange(
	vault: Vault,
	deps: AuthDeps,
	daysAhead: number,
	opts: SyncOptions = {}
): Promise<void> {
	const notify = opts.notify ?? true;

	if (!isConnected(deps)) {
		const message = "connect your Google account first";
		if (notify) new Notice(`Obcaldian: ${message}.`);
		opts.onError?.(message);
		return;
	}
	if (deps.settings.calendars.filter((c) => c.enabled).length === 0) {
		const message = "no calendars enabled";
		if (notify) new Notice(`Obcaldian: ${message} — nothing to sync.`);
		opts.onError?.(message);
		return;
	}

	const days = Math.max(0, Math.floor(daysAhead));
	opts.onStart?.();

	try {
		for (let offset = 0; offset <= days; offset++) {
			await syncNoteForDate(vault, deps, window.moment().add(offset, "day"), notify);
		}
		const dayCount = days + 1;
		if (notify) {
			new Notice(`Obcaldian: synced ${dayCount} day${dayCount === 1 ? "" : "s"}.`);
		}
		opts.onSuccess?.(dayCount);
	} catch (e) {
		const message = (e as Error).message;
		if (notify) {
			new Notice(`Obcaldian sync failed: ${message}`);
		} else {
			console.error("Obcaldian: background sync failed", e);
		}
		opts.onError?.(message);
	}
}

/**
 * Syncs enabled Google calendars into today's daily note plus the number of
 * days configured in settings.
 */
export async function syncAll(vault: Vault, deps: AuthDeps, opts: SyncOptions = {}): Promise<void> {
	return syncRange(vault, deps, deps.settings.syncDaysAhead, opts);
}

/** Runs a settings-driven sync with no Notices, for the background auto-sync timer. */
export async function autoSyncTick(
	vault: Vault,
	deps: AuthDeps,
	opts: SyncOptions = {}
): Promise<void> {
	return syncRange(vault, deps, deps.settings.syncDaysAhead, { ...opts, notify: false });
}

/** Syncs a single, already-created note (used right after it's generated). */
export async function syncSingleNote(
	vault: Vault,
	deps: AuthDeps,
	date: Moment,
	file: TFile
): Promise<void> {
	if (!isConnected(deps)) return;
	if (deps.settings.calendars.filter((c) => c.enabled).length === 0) return;
	try {
		await syncNoteForDate(vault, deps, date, true, file);
	} catch (e) {
		new Notice(`Obcaldian: initial calendar sync failed: ${(e as Error).message}`);
	}
}
