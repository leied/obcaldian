import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, type ObcaldianSettings } from "./settings";
import { ObcaldianSettingTab } from "./settingsTab";
import { ensureDailyNote } from "./dailyNote";
import { autoSyncTick, syncAll, syncRange, syncSingleNote, type SyncOptions } from "./sync";
import { migrateLegacySecrets, type AuthDeps } from "./googleAuth";
import { SyncDaysModal } from "./syncDaysModal";

type SyncBarState =
	| { kind: "idle" }
	| { kind: "syncing" }
	| { kind: "success"; at: number; dayCount: number }
	| { kind: "error"; message: string };

export default class ObcaldianPlugin extends Plugin {
	settings!: ObcaldianSettings;
	private autoSyncIntervalId: number | null = null;
	private statusBarItem!: HTMLElement;
	private syncBarState: SyncBarState = { kind: "idle" };

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new ObcaldianSettingTab(this.app, this));
		this.applyAutoSyncInterval();

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass("obcaldian-status-bar-item");
		this.statusBarItem.onClickEvent(() => {
			void syncAll(this.app.vault, this.authDeps(), this.statusBarSyncOptions());
		});
		this.renderStatusBar();
		// "synced Xm ago" goes stale as time passes without a resync; refresh its text periodically.
		this.registerInterval(window.setInterval(() => this.renderStatusBar(), 30_000));

		this.addCommand({
			id: "open-today",
			name: "Open today's daily note",
			callback: () => this.openDailyNote(0),
		});

		this.addCommand({
			id: "open-tomorrow",
			name: "Open tomorrow's daily note",
			callback: () => this.openDailyNote(1),
		});

		this.addCommand({
			id: "sync-calendars",
			name: "Sync Google calendars now",
			callback: () => syncAll(this.app.vault, this.authDeps(), this.statusBarSyncOptions()),
		});

		this.addCommand({
			id: "sync-next-days",
			name: "Sync next N days...",
			callback: () => this.openSyncDaysModal(),
		});

		this.addRibbonIcon("calendar-plus", "Open today's daily note", () => {
			void this.openDailyNote(0);
		});
		this.addRibbonIcon("calendar-days", "Open tomorrow's daily note", () => {
			void this.openDailyNote(1);
		});
		this.addRibbonIcon("refresh-cw", "Sync Google calendars now", () => {
			void syncAll(this.app.vault, this.authDeps(), this.statusBarSyncOptions());
		});
		this.addRibbonIcon("calendar-range", "Sync next N days...", () => {
			this.openSyncDaysModal();
		});
	}

	private openSyncDaysModal(): void {
		new SyncDaysModal(this.app, this.settings.syncDaysAhead, (days) => {
			void syncRange(this.app.vault, this.authDeps(), days, this.statusBarSyncOptions());
		}).open();
	}

	authDeps(): AuthDeps {
		return {
			settings: this.settings,
			saveSettings: () => this.saveSettings(),
			secretStorage: this.app.secretStorage,
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
				void autoSyncTick(this.app.vault, this.authDeps(), this.statusBarSyncOptions());
			}, minutes * 60_000);
			this.autoSyncIntervalId = id;
			this.registerInterval(id);
		}
	}

	/** Callbacks that drive the status bar item from any sync call site (commands, modal, auto-sync). */
	private statusBarSyncOptions(): SyncOptions {
		return {
			onStart: () => {
				this.syncBarState = { kind: "syncing" };
				this.renderStatusBar();
			},
			onSuccess: (dayCount) => {
				this.syncBarState = { kind: "success", at: Date.now(), dayCount };
				this.renderStatusBar();
			},
			onError: (message) => {
				this.syncBarState = { kind: "error", message };
				this.renderStatusBar();
			},
		};
	}

	private renderStatusBar(): void {
		const state = this.syncBarState;
		if (state.kind === "idle") {
			this.statusBarItem.setText("");
			this.statusBarItem.setAttr("aria-label", "");
			return;
		}
		if (state.kind === "syncing") {
			this.statusBarItem.setText("Obcaldian: syncing…");
			this.statusBarItem.setAttr("aria-label", "Syncing Google calendars…");
			return;
		}
		if (state.kind === "success") {
			this.statusBarItem.setText(`Obcaldian: synced ${window.moment(state.at).fromNow()}`);
			this.statusBarItem.setAttr(
				"aria-label",
				`Synced ${state.dayCount} day${state.dayCount === 1 ? "" : "s"} ahead. Click to sync now.`
			);
			return;
		}
		this.statusBarItem.setText("Obcaldian: sync failed");
		this.statusBarItem.setAttr("aria-label", `${state.message}. Click to retry.`);
	}

	private async openDailyNote(dayOffset: number) {
		try {
			const date = window.moment().add(dayOffset, "day");
			const file = await ensureDailyNote(this.app.vault, this.settings, date);
			const wasJustCreated = Date.now() - file.stat.ctime < 2000;
			if (wasJustCreated) {
				await syncSingleNote(this.app.vault, this.authDeps(), date, file);
			}
			await this.app.workspace.getLeaf(false).openFile(file);
		} catch (error) {
			new Notice(`Obcaldian: ${(error as Error).message}`);
		}
	}

	async loadSettings() {
		const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		const migrated = migrateLegacySecrets(this.app.secretStorage, raw);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
		if (migrated) {
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
