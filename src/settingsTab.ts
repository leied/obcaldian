import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type ObcaldianPlugin from "./main";
import {
	connectGoogleAccount,
	disconnectGoogleAccount,
	getClientSecret,
	isConnected,
	setClientSecret,
} from "./googleAuth";
import { listCalendars } from "./googleCalendar";
import { syncAll } from "./sync";
import { isValidTimeZone } from "./timezone";

export class ObcaldianSettingTab extends PluginSettingTab {
	plugin: ObcaldianPlugin;

	constructor(app: App, plugin: ObcaldianPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;
		const deps = this.plugin.authDeps();

		containerEl.createEl("h2", { text: "Obcaldian" });

		containerEl.createEl("h3", { text: "Daily notes" });

		new Setting(containerEl)
			.setName("Daily note folder")
			.setDesc("Vault folder for generated daily notes. Leave blank for the vault root.")
			.addText((text) =>
				text.setValue(settings.dailyNoteFolder).onChange(async (value) => {
					settings.dailyNoteFolder = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Template file")
			.setDesc(
				'Vault path to your template note. Use {{date}} for the date and a literal {calendar} on its own line to mark the plugin-managed section.'
			)
			.addText((text) =>
				text
					.setPlaceholder("Templates/Daily.md")
					.setValue(settings.templatePath)
					.onChange(async (value) => {
						settings.templatePath = value;
						await this.plugin.saveSettings();
					})
			);

		const timezoneDescription =
			"IANA time zone (e.g. America/New_York) used to align each day's sync window with Google Calendar. Defaults to your system timezone.";
		const timezoneSetting = new Setting(containerEl)
			.setName("Timezone")
			.setDesc(timezoneDescription)
			.addText((text) =>
				text.setValue(settings.timezone).onChange(async (value) => {
					const trimmed = value.trim();
					if (!isValidTimeZone(trimmed)) {
						timezoneSetting.setDesc(
							"Not a recognized IANA time zone, e.g. America/New_York."
						);
						timezoneSetting.descEl.addClass("obcaldian-setting-error");
						return;
					}
					timezoneSetting.setDesc(timezoneDescription);
					timezoneSetting.descEl.removeClass("obcaldian-setting-error");
					settings.timezone = trimmed;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Days ahead to sync")
			.setDesc(
				'Default number of days beyond today that "Sync now" covers. The "Sync next N days..." command can override this per run.'
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.setValue(String(settings.syncDaysAhead)).onChange(async (value) => {
					const parsed = Number(value);
					if (Number.isFinite(parsed) && parsed >= 0) {
						settings.syncDaysAhead = Math.floor(parsed);
						await this.plugin.saveSettings();
					}
				});
			});

		containerEl.createEl("h3", { text: "Google account" });

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("From an OAuth 'Desktop app' client in your own Google Cloud project.")
			.addText((text) =>
				text.setValue(settings.googleClientId).onChange(async (value) => {
					settings.googleClientId = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("Stored in Obsidian's secret storage, not in plain text in your vault.")
			.addComponent((el) =>
				new SecretComponent(this.app, el).setValue(getClientSecret(deps)).onChange((value) => {
					setClientSecret(deps, value.trim());
				})
			);

		const connected = isConnected(deps);
		new Setting(containerEl)
			.setName("Google account")
			.setDesc(connected ? "Connected" : "Not connected")
			.addButton((btn) =>
				btn
					.setButtonText(connected ? "Reconnect" : "Connect")
					.setCta()
					.onClick(async () => {
						try {
							await connectGoogleAccount(deps);
							new Notice("Obcaldian: Google account connected.");
							await this.refreshCalendarList();
							this.display();
						} catch (e) {
							new Notice(`Obcaldian: connection failed — ${(e as Error).message}`);
						}
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Disconnect")
					.setDisabled(!connected)
					.onClick(async () => {
						await disconnectGoogleAccount(deps);
						new Notice("Obcaldian: Google account disconnected.");
						this.display();
					})
			);

		containerEl.createEl("h3", { text: "Calendars" });

		new Setting(containerEl)
			.setName("Refresh calendar list")
			.setDesc("Fetch the list of calendars from your connected Google account.")
			.addButton((btn) =>
				btn
					.setButtonText("Refresh")
					.setDisabled(!connected)
					.onClick(async () => {
						await this.refreshCalendarList();
						this.display();
					})
			);

		if (settings.calendars.length === 0) {
			containerEl.createEl("p", {
				text: connected
					? "No calendars loaded yet — click Refresh."
					: "Connect your Google account, then refresh to list your calendars.",
				cls: "obcaldian-status",
			});
		}

		for (const cal of settings.calendars) {
			const row = new Setting(containerEl).setName(cal.summary);
			row.addToggle((toggle) =>
				toggle.setValue(cal.enabled).onChange(async (value) => {
					cal.enabled = value;
					await this.plugin.saveSettings();
				})
			);
			row.addDropdown((dropdown) =>
				dropdown
					.addOption("checkbox", "Add as - [ ]")
					.addOption("bullet", "Add as -")
					.setValue(cal.addAs)
					.onChange(async (value) => {
						cal.addAs = value as typeof cal.addAs;
						await this.plugin.saveSettings();
					})
			);
		}

		containerEl.createEl("h3", { text: "Sync" });
		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Pull events from all enabled calendars into today's note and the configured days ahead.")
			.addButton((btn) =>
				btn
					.setButtonText("Sync now")
					.setCta()
					.onClick(async () => {
						await syncAll(this.app.vault, this.plugin.authDeps());
					})
			);

		new Setting(containerEl)
			.setName("Auto-sync interval (minutes)")
			.setDesc("Automatically sync in the background this often, with no notifications. 0 disables it.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.setValue(String(settings.autoSyncIntervalMinutes)).onChange(async (value) => {
					const parsed = Number(value);
					if (Number.isFinite(parsed) && parsed >= 0) {
						settings.autoSyncIntervalMinutes = Math.floor(parsed);
						await this.plugin.saveSettings();
						this.plugin.applyAutoSyncInterval();
					}
				});
			});
	}

	private async refreshCalendarList(): Promise<void> {
		const settings = this.plugin.settings;
		try {
			const fetched = await listCalendars(this.plugin.authDeps());
			const existingById = new Map(settings.calendars.map((c) => [c.id, c]));
			settings.calendars = fetched.map((f) => {
				const existing = existingById.get(f.id);
				return {
					id: f.id,
					summary: f.summary,
					enabled: existing?.enabled ?? false,
					addAs: existing?.addAs ?? "checkbox",
				};
			});
			await this.plugin.saveSettings();
		} catch (e) {
			new Notice(`Obcaldian: failed to list calendars — ${(e as Error).message}`);
		}
	}
}
