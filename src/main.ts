import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, type ObcaldianSettings } from "./settings";
import { ObcaldianSettingTab } from "./settingsTab";
import { ensureDailyNote } from "./dailyNote";
import { syncAll, syncSingleNote } from "./sync";
import type { AuthDeps } from "./googleAuth";

export default class ObcaldianPlugin extends Plugin {
	settings!: ObcaldianSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new ObcaldianSettingTab(this.app, this));

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
			callback: () => syncAll(this.app.vault, this.authDeps()),
		});

		this.addRibbonIcon("calendar-plus", "Open today's daily note", () => {
			this.openDailyNote(0);
		});
	}

	authDeps(): AuthDeps {
		return { settings: this.settings, saveSettings: () => this.saveSettings() };
	}

	private async openDailyNote(dayOffset: number) {
		const date = window.moment().add(dayOffset, "day");
		const file = await ensureDailyNote(this.app.vault, this.settings, date);
		const wasJustCreated = Date.now() - file.stat.ctime < 2000;
		if (wasJustCreated) {
			await syncSingleNote(this.app.vault, this.authDeps(), date, file);
		}
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
