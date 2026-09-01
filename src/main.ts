import { Notice, Plugin, TFile } from "obsidian";
import { loadSettingsData, type DailyCalSyncSettings } from "./settings";
import { DailyCalSyncSettingTab } from "./settingsTab";
import {
	MARKER_END,
	MARKER_START,
	calendarSectionFromContent,
	ensureDailyNoteResult,
	notePathFor,
} from "./dailyNote";
import {
	autoSyncTick,
	syncAll,
	syncRange,
	syncDateRange,
	syncSingleNote,
	undoSyncSnapshot,
	type SyncOptions,
	type SyncUndoSnapshot,
} from "./sync";
import { migrateLegacySecrets, type AuthDeps } from "./googleAuth";
import { SyncDaysModal } from "./syncDaysModal";
import { confirmMultiDayCompletion } from "./multiDayCompletionModal";
import { confirmSyncPlan } from "./syncPreviewModal";
import { SyncDateRangeModal } from "./syncDateRangeModal";
import { RepairCalendarModal } from "./repairCalendarModal";
import { copyRedactedDiagnostics } from "./diagnostics";
import { OnboardingModal } from "./onboardingModal";

type SyncBarState =
	| { kind: "idle" }
	| { kind: "syncing" }
	| { kind: "success"; at: number; dayCount: number }
	| { kind: "error"; message: string };

export default class DailyCalSyncPlugin extends Plugin {
	settings!: DailyCalSyncSettings;
	private autoSyncIntervalId: number | null = null;
	private statusBarItem!: HTMLElement;
	private syncBarState: SyncBarState = { kind: "idle" };
	private lastSyncSnapshot: SyncUndoSnapshot | null = null;

	async onload() {
		await this.loadSettings();
		if (this.settings.useDailyNotesSettings) await this.syncDailyNotesSettings();
		this.addSettingTab(new DailyCalSyncSettingTab(this.app, this));
		if (!this.settings.onboardingComplete) {
			this.app.workspace.onLayoutReady(() => new OnboardingModal(this.app, this).open());
		}
		this.applyAutoSyncInterval();

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass("dailycalsync-status-bar-item");
		this.statusBarItem.onClickEvent(() => {
			void syncAll(this.app.vault, this.authDeps(), this.syncOptions());
		});
		this.renderStatusBar();
		// "synced Xm ago" goes stale as time passes without a resync; refresh its text periodically.
		this.registerInterval(window.setInterval(() => this.renderStatusBar(), 30_000));
		this.registerDomEvent(window, "online", () => this.quietCatchUp());
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible") this.quietCatchUp();
		});
		this.registerInterval(window.setTimeout(() => this.quietCatchUp(), 5_000));

		this.addCommand({
			id: "open-today",
			name: "Open today's daily note",
			callback: () => this.openDailyNote(0),
		});

		this.addCommand({
			id: "undo-last-calendar-sync",
			name: "Undo last calendar sync",
			callback: () => this.undoLastSync(),
		});

		this.addCommand({
			id: "open-tomorrow",
			name: "Open tomorrow's daily note",
			callback: () => this.openDailyNote(1),
		});

		this.addCommand({
			id: "sync-calendars",
			name: "Sync calendars now",
			callback: () => syncAll(this.app.vault, this.authDeps(), this.syncOptions()),
		});

		this.addCommand({
			id: "sync-next-days",
			name: "Sync upcoming days...",
			callback: () => this.openSyncDaysModal(),
		});

		this.addCommand({
			id: "sync-date-range",
			name: "Sync calendar date range...",
			callback: () => this.openDateRangeModal(),
		});

		this.addCommand({
			id: "sync-current-note",
			name: "Sync calendar for this note",
			callback: () => this.syncCurrentNote(),
		});

		this.addCommand({
			id: "repair-calendar-section",
			name: "Repair calendar section",
			callback: () => this.repairActiveCalendarSection(),
		});

		this.addCommand({
			id: "copy-diagnostics",
			name: "Copy redacted diagnostics",
			callback: () => this.copyDiagnostics(),
		});

		this.addRibbonIcon("calendar-plus", "Open today's daily note", () => {
			void this.openDailyNote(0);
		});
		this.addRibbonIcon("calendar-days", "Open tomorrow's daily note", () => {
			void this.openDailyNote(1);
		});
		this.addRibbonIcon("refresh-cw", "Sync calendars now", () => {
			void syncAll(this.app.vault, this.authDeps(), this.syncOptions());
		});
		this.addRibbonIcon("calendar-range", "Sync upcoming days...", () => {
			this.openSyncDaysModal();
		});
	}

	/** Copies the core Daily Notes configuration through a guarded optional integration. */
	async syncDailyNotesSettings(): Promise<boolean> {
		type DailyNotesOptions = { folder?: string; format?: string; template?: string };
		type InternalPlugin = { instance?: { options?: DailyNotesOptions } };
		type InternalPlugins = {
			getPluginById?: (id: string) => InternalPlugin | undefined;
			plugins?: Record<string, InternalPlugin>;
		};
		const internalPlugins = (
			this.app as unknown as { internalPlugins?: InternalPlugins }
		).internalPlugins;
		const dailyNotes =
			internalPlugins?.getPluginById?.("daily-notes") ??
			internalPlugins?.plugins?.["daily-notes"];
		const options = dailyNotes?.instance?.options;
		if (!options) return false;
		this.settings.dailyNoteFolder = options.folder?.trim() ?? "";
		this.settings.templatePath = options.template?.trim() ?? "";
		this.settings.dailyNoteFormat = options.format?.trim() || "YYYYMMDD";
		await this.saveSettings();
		return true;
	}

	private openSyncDaysModal(): void {
		new SyncDaysModal(this.app, this.settings.syncDaysAhead, (days) => {
			void syncRange(this.app.vault, this.authDeps(), days, this.syncOptions());
		}).open();
	}

	private openDateRangeModal(): void {
		new SyncDateRangeModal(
			this.app,
			this.settings.syncDaysAhead,
			this.settings.noteCreationMode === "existing-only",
			(choice) => {
				void syncDateRange(this.app.vault, this.authDeps(), choice.start, choice.end, {
					...this.syncOptions(),
					existingOnly: choice.existingOnly,
				});
			}
		).open();
	}

	private async syncCurrentNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile)) {
			new Notice("DailyCalSync: open a daily note first.");
			return;
		}
		const date = window.moment(file.basename, this.settings.dailyNoteFormat, true);
		if (!date.isValid() || notePathFor(this.settings, date) !== file.path) {
			new Notice("DailyCalSync: the active file does not match the configured daily note format.");
			return;
		}
		await syncDateRange(this.app.vault, this.authDeps(), date, date, {
			...this.syncOptions(),
			existingOnly: true,
		});
	}

	private async repairActiveCalendarSection(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile)) {
			new Notice("DailyCalSync: open the note that needs repair first.");
			return;
		}
		const original = await this.app.vault.read(file);
		if (calendarSectionFromContent(original) !== null) {
			new Notice("DailyCalSync: this note already has a managed calendar section.");
			return;
		}
		new RepairCalendarModal(this.app, file, () => {
			void (async () => {
				const current = await this.app.vault.read(file);
				if (current !== original) {
					new Notice("DailyCalSync: the note changed during preview; repair was cancelled.");
					return;
				}
				const separator = current.endsWith("\n") ? "\n" : "\n\n";
				await this.app.vault.modify(
					file,
					`${current}${separator}${MARKER_START}\n_(not yet synced)_\n${MARKER_END}\n`
				);
				new Notice("DailyCalSync: calendar section markers inserted.");
			})();
		}).open();
	}

	async copyDiagnostics(): Promise<void> {
		try {
			await copyRedactedDiagnostics(this.manifest.version, this.settings);
			new Notice("DailyCalSync: redacted diagnostics copied.");
		} catch (error) {
			new Notice(`DailyCalSync: could not copy diagnostics — ${(error as Error).message}`);
		}
	}

	private quietCatchUp(): void {
		const hasEnabledSource =
			this.settings.googleAccounts.some((account) => account.calendars.some((calendar) => calendar.enabled)) ||
			this.settings.iCalCalendars.some((calendar) => calendar.enabled);
		if (!hasEnabledSource) {
			return;
		}
		const staleAfterMinutes = this.settings.autoSyncIntervalMinutes || 180;
		const lastSuccess = this.settings.lastSuccessfulSyncAt ?? 0;
		if (Date.now() - lastSuccess < staleAfterMinutes * 60_000) return;
		void autoSyncTick(this.app.vault, this.authDeps(), this.syncOptions());
	}

	authDeps(accountId?: string): AuthDeps {
		return {
			settings: this.settings,
			saveSettings: () => this.saveSettings(),
			secretStorage: this.app.secretStorage,
			accountId,
			rollbackCreatedFile: (file) => this.app.fileManager.trashFile(file),
		};
	}

	/** Re-reads settings.autoSyncIntervalMinutes and (re)starts the background timer accordingly. */
	applyAutoSyncInterval(): void {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
		const minutes = this.settings.autoSyncIntervalMinutes;
		if (minutes > 0) {
			const id = window.setInterval(() => {
				void autoSyncTick(this.app.vault, this.authDeps(), this.syncOptions());
			}, minutes * 60_000);
			this.autoSyncIntervalId = id;
			this.registerInterval(id);
		}
	}

	/** Callbacks that drive the status bar item from any sync call site (commands, modal, auto-sync). */
	syncOptions(): SyncOptions {
		return {
			confirmMultiDay: (request) => confirmMultiDayCompletion(this.app, request),
			preview: (plan) => confirmSyncPlan(this.app, plan),
			onApplied: (snapshot) => {
				this.lastSyncSnapshot = snapshot;
			},
			onStart: () => {
				this.syncBarState = { kind: "syncing" };
				this.renderStatusBar();
			},
			onSuccess: (dayCount) => {
				this.syncBarState = { kind: "success", at: Date.now(), dayCount };
				this.renderStatusBar();
			},
			onCancelled: () => {
				this.syncBarState = { kind: "idle" };
				this.renderStatusBar();
			},
			onError: (message) => {
				this.syncBarState = { kind: "error", message };
				this.renderStatusBar();
			},
		};
	}

	private async undoLastSync(): Promise<void> {
		if (!this.lastSyncSnapshot) {
			new Notice("DailyCalSync: there is no calendar sync to undo in this session.");
			return;
		}
		const result = await undoSyncSnapshot(this.app.vault, this.lastSyncSnapshot);
		this.lastSyncSnapshot = null;
		new Notice(
			`DailyCalSync: restored ${result.restored} calendar section${result.restored === 1 ? "" : "s"}${result.skipped ? `; skipped ${result.skipped} changed note${result.skipped === 1 ? "" : "s"}` : ""}.`
		);
	}

	private renderStatusBar(): void {
		const state = this.syncBarState;
		if (state.kind === "idle") {
			this.statusBarItem.setText("");
			this.statusBarItem.setAttr("aria-label", "");
			return;
		}
		if (state.kind === "syncing") {
			this.statusBarItem.setText("DailyCalSync: syncing…");
			this.statusBarItem.setAttr("aria-label", "Syncing calendars…");
			return;
		}
		if (state.kind === "success") {
			this.statusBarItem.setText(`DailyCalSync: synced ${window.moment(state.at).fromNow()}`);
			this.statusBarItem.setAttr(
				"aria-label",
				`Synced ${state.dayCount} day${state.dayCount === 1 ? "" : "s"} ahead. Click to sync now.`
			);
			return;
		}
		this.statusBarItem.setText("DailyCalSync: sync failed");
		this.statusBarItem.setAttr("aria-label", `${state.message}. Click to retry.`);
	}

	private async openDailyNote(dayOffset: number) {
		try {
			const date = window.moment().add(dayOffset, "day");
			const { file, created } = await ensureDailyNoteResult(
				this.app.vault,
				this.settings,
				date
			);
			if (created) {
				await syncSingleNote(this.app.vault, this.authDeps(), date, file);
			}
			await this.app.workspace.getLeaf(false).openFile(file);
		} catch (error) {
			new Notice(`DailyCalSync: ${(error as Error).message}`);
		}
	}

	async loadSettings() {
		const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		const secretsMigrated = migrateLegacySecrets(this.app.secretStorage, raw);
		const loaded = loadSettingsData(raw);
		this.settings = loaded.settings;
		if (secretsMigrated || loaded.changed) {
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
