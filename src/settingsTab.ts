import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObcaldianPlugin from "./main";
import { connectGoogleAccount, disconnectGoogleAccount } from "./googleAuth";
import { listCalendars } from "./googleCalendar";
import { syncAll } from "./sync";

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

		new Setting(containerEl).setName("Client secret").addText((text) => {
			text.inputEl.type = "password";
			text.setValue(settings.googleClientSecret).onChange(async (value) => {
				settings.googleClientSecret = value.trim();
				await this.plugin.saveSettings();
			});
		});

		const status = settings.tokens ? "Connected" : "Not connected";
		new Setting(containerEl)
			.setName("Google account")
			.setDesc(status)
			.addButton((btn) =>
				btn
					.setButtonText(settings.tokens ? "Reconnect" : "Connect")
					.setCta()
					.onClick(async () => {
						try {
							await connectGoogleAccount(this.plugin.authDeps());
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
					.setDisabled(!settings.tokens)
					.onClick(async () => {
						await disconnectGoogleAccount(this.plugin.authDeps());
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
					.setDisabled(!settings.tokens)
					.onClick(async () => {
						await this.refreshCalendarList();
						this.display();
					})
			);

		if (settings.calendars.length === 0) {
			containerEl.createEl("p", {
				text: settings.tokens
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
			.setDesc("Pull events from all enabled calendars into today's and tomorrow's notes.")
			.addButton((btn) =>
				btn
					.setButtonText("Sync now")
					.setCta()
					.onClick(async () => {
						await syncAll(this.app.vault, this.plugin.authDeps());
					})
			);
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
