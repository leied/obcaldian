import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type ObcaldianPlugin from "./main";
import {
	connectGoogleAccount,
	disconnectGoogleAccount,
	getClientSecret,
	importGoogleCredentials,
	isConnected,
	setClientSecret,
} from "./googleAuth";
import { listCalendars } from "./googleCalendar";
import { syncAll } from "./sync";
import { isValidTimeZone } from "./timezone";
import type { RenderingSettings } from "./settings";
import { PrivacyModal } from "./privacyModal";

type BooleanRenderingKey = {
	[Key in keyof RenderingSettings]: RenderingSettings[Key] extends boolean ? Key : never;
}[keyof RenderingSettings];

export class ObcaldianSettingTab extends PluginSettingTab {
	plugin: ObcaldianPlugin;
	private connectionAbortController: AbortController | null = null;

	constructor(app: App, plugin: ObcaldianPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;
		const deps = this.plugin.authDeps();

		new Setting(containerEl).setName("Daily notes").setHeading();
		new Setting(containerEl)
			.setName("Reuse core Daily Notes settings")
			.setDesc("Copy the enabled core plugin's folder, template, and filename format.")
			.addToggle((toggle) =>
				toggle.setValue(settings.useDailyNotesSettings).onChange(async (value) => {
					settings.useDailyNotesSettings = value;
					await this.plugin.saveSettings();
					if (value && !(await this.plugin.syncDailyNotesSettings())) {
						new Notice("Obcaldian: the core Daily Notes plugin is not enabled or configured.");
					}
					this.display();
				})
			)
			.addButton((button) =>
				button
					.setButtonText("Refresh")
					.setDisabled(!settings.useDailyNotesSettings)
					.onClick(async () => {
						if (!(await this.plugin.syncDailyNotesSettings())) {
							new Notice("Obcaldian: the core Daily Notes plugin is not enabled or configured.");
						}
						this.display();
					})
			);

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

		new Setting(containerEl)
			.setName("Filename format")
			.setDesc("Moment-style daily note filename format, for example YYYY-MM-DD.")
			.addText((text) =>
				text.setValue(settings.dailyNoteFormat).onChange(async (value) => {
					settings.dailyNoteFormat = value.trim() || "YYYYMMDD";
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Missing notes")
			.setDesc("Choose whether range sync may create notes or only update notes already present.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("create-missing", "Create missing notes")
					.addOption("existing-only", "Update existing notes only")
					.setValue(settings.noteCreationMode)
					.onChange(async (value) => {
						settings.noteCreationMode = value as typeof settings.noteCreationMode;
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

		new Setting(containerEl).setName("Google account").setHeading();
		new Setting(containerEl)
			.setName("Privacy and data handling")
			.setDesc("Review what is read from Google, written locally, and sent over the network.")
			.addButton((button) =>
				button.setButtonText("View policy").onClick(() => new PrivacyModal(this.app).open())
			);

		const credentialsInput = containerEl.createEl("input", {
			type: "file",
			cls: "obcaldian-file-input",
		});
		credentialsInput.setAttr("accept", "application/json,.json");
		credentialsInput.addEventListener("change", () => {
			void (async () => {
				const file = credentialsInput.files?.[0];
				if (!file) return;
				try {
					const imported = await importGoogleCredentials(deps, await file.text());
					new Notice(`Obcaldian: imported credentials for project ${imported.projectId}.`);
					this.display();
				} catch (error) {
					new Notice(`Obcaldian: credentials import failed — ${(error as Error).message}`);
				} finally {
					credentialsInput.value = "";
				}
			})();
		});

		new Setting(containerEl)
			.setName("Import Google credentials JSON")
			.setDesc(
				"Recommended: select the downloaded credentials for an OAuth Desktop app. The file and its path are not retained."
			)
			.addButton((button) =>
				button.setButtonText("Import JSON").setCta().onClick(() => credentialsInput.click())
			);

		if (settings.googleProjectId) {
			new Setting(containerEl)
				.setName("Imported Google project")
				.setDesc(settings.googleProjectId);
		}

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
		const accountSetting = new Setting(containerEl)
			.setName("Google account")
			.setDesc(connected ? "Connected" : "Not connected")
			.addButton((btn) =>
				btn
					.setButtonText(
						this.connectionAbortController
							? "Connecting..."
							: connected
								? "Reconnect"
								: "Connect"
					)
					.setDisabled(this.connectionAbortController !== null)
					.setCta()
					.onClick(async () => {
						const controller = new AbortController();
						this.connectionAbortController = controller;
						this.display();
						try {
							await connectGoogleAccount(deps, { signal: controller.signal });
							new Notice("Obcaldian: Google account connected.");
							await this.refreshCalendarList();
						} catch (e) {
							new Notice(`Obcaldian: connection failed — ${(e as Error).message}`);
						} finally {
							if (this.connectionAbortController === controller) {
								this.connectionAbortController = null;
							}
							this.display();
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
		if (this.connectionAbortController) {
			accountSetting.addButton((button) =>
				button.setButtonText("Cancel connection").onClick(() => {
					this.connectionAbortController?.abort();
				})
			);
		}

		new Setting(containerEl).setName("Calendars").setHeading();

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
			row.addExtraButton((button) =>
				button
					.setIcon("arrow-up")
					.setTooltip("Move calendar earlier")
					.onClick(async () => {
						const index = settings.calendars.indexOf(cal);
						if (index <= 0) return;
						settings.calendars.splice(index - 1, 0, settings.calendars.splice(index, 1)[0]);
						await this.plugin.saveSettings();
						this.display();
					})
			);
			row.addExtraButton((button) =>
				button
					.setIcon("arrow-down")
					.setTooltip("Move calendar later")
					.onClick(async () => {
						const index = settings.calendars.indexOf(cal);
						if (index === -1 || index >= settings.calendars.length - 1) return;
						settings.calendars.splice(index + 1, 0, settings.calendars.splice(index, 1)[0]);
						await this.plugin.saveSettings();
						this.display();
					})
			);
		}

		new Setting(containerEl).setName("Rendering and privacy").setHeading();
		const addRenderingToggle = (
			name: string,
			description: string,
			key: BooleanRenderingKey
		): void => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(description)
				.addToggle((toggle) =>
					toggle.setValue(settings.rendering[key]).onChange(async (value) => {
						settings.rendering[key] = value;
						await this.plugin.saveSettings();
					})
				);
		};
		addRenderingToggle("All-day events first", "Group all-day events before timed events.", "allDayFirst");
		addRenderingToggle("Descriptions", "Persist event descriptions in footnotes.", "showDescriptions");
		addRenderingToggle("Attendees", "Persist attendee lists for events with at least three attendees.", "showAttendees");
		addRenderingToggle("Attendee email addresses", "Use email addresses when an attendee has no display name.", "includeAttendeeEmails");
		addRenderingToggle("Locations", "Persist event locations in footnotes.", "showLocations");
		addRenderingToggle("Meeting links", "Persist HTTPS meeting links in footnotes.", "showMeetingLinks");
		addRenderingToggle("Redact private events", "Render private and confidential events as Busy without details.", "redactPrivateEvents");
		addRenderingToggle("Declined events", "Include events that you declined.", "includeDeclined");
		addRenderingToggle("Cancelled events", "Include cancelled occurrences.", "includeCancelled");
		addRenderingToggle("Free events", "Include events marked transparent/free.", "includeFreeEvents");
		addRenderingToggle("Focus time", "Include Google focus-time events.", "includeFocusTime");
		addRenderingToggle("Out of office", "Include Google out-of-office events.", "includeOutOfOffice");
		addRenderingToggle("Working location", "Include Google working-location events.", "includeWorkingLocation");
		addRenderingToggle("Birthdays", "Include Google birthday events.", "includeBirthdays");
		addRenderingToggle("Calendar colors", "Show Google calendar colors using theme-aware CSS classes.", "useGoogleCalendarColors");
		new Setting(containerEl)
			.setName("Time locale")
			.setDesc("BCP 47 locale, or system to use the operating-system locale.")
			.addText((text) =>
				text.setValue(settings.rendering.locale).onChange(async (value) => {
					settings.rendering.locale = value.trim() || "system";
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Clock")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("system", "System default")
					.addOption("12", "12-hour")
					.addOption("24", "24-hour")
					.setValue(settings.rendering.hourCycle)
					.onChange(async (value) => {
						settings.rendering.hourCycle = value as typeof settings.rendering.hourCycle;
						await this.plugin.saveSettings();
					})
			);
		addRenderingToggle("End times", "Show an event's end time when available.", "showEndTime");
		new Setting(containerEl)
			.setName("Time range separator")
			.setDesc("Text placed between start and end times.")
			.addText((text) =>
				text.setValue(settings.rendering.timeSeparator).onChange(async (value) => {
					settings.rendering.timeSeparator = value.slice(0, 8) || "-";
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Sync").setHeading();
		new Setting(containerEl)
			.setName("When a multi-day event is checked")
			.setDesc(
				"Choose whether each day stays independent or completion carries into following days. Remembered choices also apply when a later note is first synced."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("independent", "Keep each day independent")
					.addOption("ask", "Ask during manual sync")
					.addOption("following", "Mark following days done")
					.setValue(settings.multiDayCompletionBehavior)
					.onChange(async (value) => {
						settings.multiDayCompletionBehavior =
							value as typeof settings.multiDayCompletionBehavior;
						if (value === "independent") settings.multiDayCompletionRules = {};
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Remembered multi-day completions")
			.setDesc(
				`${Object.keys(settings.multiDayCompletionRules).length} active rule(s). Clear these to stop applying prior “mark following” choices to notes synced later.`
			)
			.addButton((button) =>
				button
					.setButtonText("Clear")
					.setDisabled(Object.keys(settings.multiDayCompletionRules).length === 0)
					.onClick(async () => {
						settings.multiDayCompletionRules = {};
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Pull events from all enabled calendars into today's note and the configured days ahead.")
			.addButton((btn) =>
				btn
					.setButtonText("Sync now")
					.setCta()
					.onClick(async () => {
						await syncAll(
							this.app.vault,
							this.plugin.authDeps(),
							this.plugin.syncOptions()
						);
					})
			);

		new Setting(containerEl)
			.setName("Automatic calendar check (minutes)")
			.setDesc(
				"Quietly check and sync enabled calendars this often. Defaults to every 3 hours; 0 disables it."
			)
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

		const failedCalendars = settings.calendars.filter(
			(calendar) => settings.calendarHealth[calendar.id]?.lastFailureAt
		).length;
		new Setting(containerEl)
			.setName("Sync health")
			.setDesc(
				`Last successful sync: ${settings.lastSuccessfulSyncAt ? window.moment(settings.lastSuccessfulSyncAt).fromNow() : "never"}. ${failedCalendars} calendar(s) have a recorded failure.`
			);
		new Setting(containerEl)
			.setName("Diagnostics")
			.setDesc(
				"Copy versions, platform, timezone, note configuration, network hosts, and categorized failures. Credentials and calendar content are excluded."
			)
			.addButton((button) =>
				button.setButtonText("Copy diagnostics").onClick(async () => {
					await this.plugin.copyDiagnostics();
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
					colorId: f.colorId ?? existing?.colorId,
					color: f.backgroundColor ?? existing?.color,
				};
			});
			await this.plugin.saveSettings();
		} catch (e) {
			new Notice(`Obcaldian: failed to list calendars — ${(e as Error).message}`);
		}
	}
}
