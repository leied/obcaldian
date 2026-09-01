import { App, Modal, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type DailyCalSyncPlugin from "./main";
import {
	connectGoogleAccount,
	disconnectGoogleAccount,
	getClientSecret,
	importGoogleCredentials,
	isConnected,
	setClientSecret,
} from "./googleAuth";
import { listCalendars } from "./googleCalendar";
import { clearICalUrl, getICalUrl, setICalUrl } from "./ical";
import { OnboardingModal } from "./onboardingModal";
import { PrivacyModal } from "./privacyModal";
import type { CalendarConfig, GoogleAccountProfile, RenderingSettings } from "./settings";
import { syncAll } from "./sync";
import { isValidTimeZone } from "./timezone";

type BooleanRenderingKey = {
	[Key in keyof RenderingSettings]: RenderingSettings[Key] extends boolean ? Key : never;
}[keyof RenderingSettings];

function localId(prefix: string): string {
	const random = window.crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return `${prefix}-${random.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 48)}`;
}

class ConfirmRemovalModal extends Modal {
	constructor(
		app: App,
		private readonly label: string,
		private readonly confirm: () => Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Confirm removal");
		this.contentEl.createEl("p", { text: `Remove ${this.label}? Existing Markdown will not be deleted.` });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) => button.setButtonText("Remove").setWarning().onClick(async () => {
				this.close();
				await this.confirm();
			}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class DailyCalSyncSettingTab extends PluginSettingTab {
	private connectionAbortController: AbortController | null = null;

	constructor(app: App, public readonly plugin: DailyCalSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;

		new Setting(containerEl).setName("Setup").setHeading();
		const configuredSources = settings.googleAccounts.length + settings.iCalCalendars.length;
		const enabledCalendars = settings.googleAccounts.reduce(
			(total, account) => total + account.calendars.filter((calendar) => calendar.enabled).length,
			settings.iCalCalendars.filter((calendar) => calendar.enabled).length
		);
		new Setting(containerEl)
			.setName(settings.onboardingComplete ? "Setup overview" : "Finish setup")
			.setDesc(
				`Daily notes: ${settings.templatePath || settings.useDailyNotesSettings ? "configured" : "needs a template"} · Sources: ${configuredSources} · Enabled calendars: ${enabledCalendars}`
			)
			.addButton((button) =>
				button.setButtonText(settings.onboardingComplete ? "Run setup again" : "Start guided setup").setCta().onClick(() => {
					new OnboardingModal(this.app, this.plugin, () => this.display()).open();
				})
			);

		new Setting(containerEl)
			.setName("Privacy and data handling")
			.setDesc("Review local storage, calendar data, Secret iCal URLs, and permitted network traffic.")
			.addButton((button) => button.setButtonText("View policy").onClick(() => new PrivacyModal(this.app).open()));

		this.renderDailyNotes();
		this.renderGoogleAccounts();
		this.renderICalFeeds();
		this.renderRendering();
		this.renderSync();
	}

	private renderDailyNotes(): void {
		const settings = this.plugin.settings;
		new Setting(this.containerEl).setName("Daily notes").setHeading();
		new Setting(this.containerEl)
			.setName("Reuse core Daily Notes settings")
			.setDesc("Copy the core plugin's folder, template, and filename format.")
			.addToggle((toggle) => toggle.setValue(settings.useDailyNotesSettings).onChange(async (value) => {
				settings.useDailyNotesSettings = value;
				if (value && !(await this.plugin.syncDailyNotesSettings())) {
					new Notice("DailyCalSync: the core Daily Notes plugin is not enabled or configured.");
				} else await this.plugin.saveSettings();
				this.display();
			}))
			.addButton((button) => button.setButtonText("Refresh").setDisabled(!settings.useDailyNotesSettings).onClick(async () => {
				if (!(await this.plugin.syncDailyNotesSettings())) new Notice("DailyCalSync: the core Daily Notes plugin is not enabled or configured.");
				this.display();
			}));
		new Setting(this.containerEl).setName("Daily note folder").setDesc("Leave blank for the vault root.").addText((text) =>
			text.setValue(settings.dailyNoteFolder).onChange(async (value) => {
				settings.dailyNoteFolder = value;
				await this.plugin.saveSettings();
			})
		);
		new Setting(this.containerEl).setName("Template file").setDesc("Use {{date}} and put {calendar} where the managed section belongs.").addText((text) =>
			text.setPlaceholder("Templates/Daily.md").setValue(settings.templatePath).onChange(async (value) => {
				settings.templatePath = value;
				await this.plugin.saveSettings();
			})
		);
		new Setting(this.containerEl).setName("Filename format").setDesc("Moment-style format, for example YYYY-MM-DD.").addText((text) =>
			text.setValue(settings.dailyNoteFormat).onChange(async (value) => {
				settings.dailyNoteFormat = value.trim() || "YYYYMMDD";
				await this.plugin.saveSettings();
			})
		);
		new Setting(this.containerEl).setName("Missing notes").addDropdown((dropdown) => dropdown
			.addOption("create-missing", "Create missing notes")
			.addOption("existing-only", "Update existing notes only")
			.setValue(settings.noteCreationMode)
			.onChange(async (value) => {
				settings.noteCreationMode = value as typeof settings.noteCreationMode;
				await this.plugin.saveSettings();
			}));
		const timezoneSetting = new Setting(this.containerEl).setName("Timezone").setDesc("IANA time zone used for day boundaries.");
		timezoneSetting.addText((text) => text.setValue(settings.timezone).onChange(async (value) => {
			const trimmed = value.trim();
			if (!isValidTimeZone(trimmed)) {
				timezoneSetting.setDesc("Not a recognized IANA time zone, e.g. America/New_York.");
				timezoneSetting.descEl.addClass("dailycalsync-setting-error");
				return;
			}
			timezoneSetting.setDesc("IANA time zone used for day boundaries.");
			timezoneSetting.descEl.removeClass("dailycalsync-setting-error");
			settings.timezone = trimmed;
			await this.plugin.saveSettings();
		}));
	}

	private renderGoogleAccounts(): void {
		const settings = this.plugin.settings;
		new Setting(this.containerEl).setName("Google accounts").setHeading();
		new Setting(this.containerEl)
			.setName("Add account")
			.setDesc("Each profile has isolated credentials, tokens, calendars, cache, and health state.")
			.addButton((button) => button.setButtonText("Add Google account").setCta().onClick(async () => {
				settings.googleAccounts.push({ id: localId("google"), name: `Google account ${settings.googleAccounts.length + 1}`, clientId: "", projectId: "", calendars: [], calendarHealth: {}, calendarCaches: {} });
				await this.plugin.saveSettings();
				this.display();
			}));

		if (settings.googleAccounts.length === 0) this.containerEl.createEl("p", { text: "No Google accounts yet. Add one, import its Desktop OAuth JSON, then connect.", cls: "dailycalsync-status" });
		for (const account of settings.googleAccounts) this.renderGoogleAccount(account);
	}

	private renderGoogleAccount(account: GoogleAccountProfile): void {
		const deps = this.plugin.authDeps(account.id);
		new Setting(this.containerEl).setName(account.name).setHeading();
		new Setting(this.containerEl).setName("Profile name").addText((text) => text.setValue(account.name).onChange(async (value) => {
			account.name = value.trim() || "Google account";
			await this.plugin.saveSettings();
		}));
		const credentialsInput = this.containerEl.createEl("input", { type: "file", cls: "dailycalsync-file-input" });
		credentialsInput.setAttr("accept", "application/json,.json");
		credentialsInput.addEventListener("change", () => void (async () => {
			const file = credentialsInput.files?.[0];
			if (!file) return;
			try {
				const imported = await importGoogleCredentials(deps, await file.text());
				new Notice(`DailyCalSync: imported credentials for ${account.name} (${imported.projectId}).`);
			} catch (error) {
				new Notice(`DailyCalSync: credentials import failed — ${(error as Error).message}`);
			} finally {
				credentialsInput.value = "";
				this.display();
			}
		})());
		new Setting(this.containerEl).setName("Desktop OAuth credentials").setDesc(account.projectId ? `Project: ${account.projectId}` : "Import the JSON downloaded for an OAuth Desktop app.").addButton((button) =>
			button.setButtonText("Import JSON").onClick(() => credentialsInput.click())
		);
		new Setting(this.containerEl).setName("Client ID").addText((text) => text.setValue(account.clientId).onChange(async (value) => {
			account.clientId = value.trim();
			await this.plugin.saveSettings();
		}));
		new Setting(this.containerEl).setName("Client secret").setDesc("Stored in Obsidian SecretStorage.").addComponent((element) =>
			new SecretComponent(this.app, element).setValue(getClientSecret(deps)).onChange((value) => setClientSecret(deps, value.trim()))
		);
		const connected = isConnected(deps);
		const connection = new Setting(this.containerEl).setName("Connection").setDesc(connected ? "Connected" : "Not connected");
		connection.addButton((button) => button
			.setButtonText(this.connectionAbortController ? "Connecting…" : connected ? "Reconnect" : "Connect")
			.setDisabled(this.connectionAbortController !== null)
			.setCta()
			.onClick(async () => {
				const controller = new AbortController();
				this.connectionAbortController = controller;
				this.display();
				try {
					await connectGoogleAccount(deps, { signal: controller.signal });
					new Notice(`DailyCalSync: ${account.name} connected.`);
					await this.refreshCalendarList(account);
				} catch (error) {
					new Notice(`DailyCalSync: connection failed — ${(error as Error).message}`);
				} finally {
					if (this.connectionAbortController === controller) this.connectionAbortController = null;
					this.display();
				}
			}));
		connection.addButton((button) => button.setButtonText("Disconnect").setDisabled(!connected).onClick(async () => {
			await disconnectGoogleAccount(deps);
			new Notice(`DailyCalSync: ${account.name} disconnected.`);
			this.display();
		}));
		if (this.connectionAbortController) connection.addButton((button) => button.setButtonText("Cancel").onClick(() => this.connectionAbortController?.abort()));
		new Setting(this.containerEl).setName("Calendars").setDesc("Refresh after connecting, then enable the calendars to sync.").addButton((button) => button.setButtonText("Refresh list").setDisabled(!connected).onClick(async () => {
			await this.refreshCalendarList(account);
			this.display();
		}));
		this.renderCalendarRows(account.calendars, async () => this.plugin.saveSettings());
		new Setting(this.containerEl).setName("Remove profile").setDesc("Revokes the token when possible, then clears this profile's local secrets and cache.").addButton((button) => button.setButtonText("Remove").setWarning().onClick(() => {
			new ConfirmRemovalModal(this.app, account.name, async () => {
				await disconnectGoogleAccount(deps);
				setClientSecret(deps, "");
				const index = this.plugin.settings.googleAccounts.indexOf(account);
				if (index >= 0) this.plugin.settings.googleAccounts.splice(index, 1);
				await this.plugin.saveSettings();
				this.display();
			}).open();
		}));
	}

	private renderICalFeeds(): void {
		const settings = this.plugin.settings;
		new Setting(this.containerEl).setName("Secret iCalendar feeds").setHeading();
		new Setting(this.containerEl).setName("Add read-only feed").setDesc("The HTTPS URL is stored only in Obsidian SecretStorage. Treat it like a password.").addButton((button) => button.setButtonText("Add iCal feed").onClick(async () => {
			settings.iCalCalendars.push({ id: localId("ical"), summary: `iCalendar ${settings.iCalCalendars.length + 1}`, enabled: true, addAs: "checkbox" });
			await this.plugin.saveSettings();
			this.display();
		}));
		for (const calendar of settings.iCalCalendars) {
			new Setting(this.containerEl).setName(calendar.summary).setHeading();
			new Setting(this.containerEl).setName("Feed name").addText((text) => text.setValue(calendar.summary).onChange(async (value) => {
				calendar.summary = value.trim() || "iCalendar feed";
				await this.plugin.saveSettings();
			}));
			const urlSetting = new Setting(this.containerEl).setName("Secret HTTPS URL").setDesc("Saved in SecretStorage and redacted from diagnostics.");
			urlSetting.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(getICalUrl(this.plugin.authDeps(), calendar.id));
				text.setPlaceholder("https://…/calendar.ics");
				text.inputEl.addEventListener("change", () => {
					try {
						if (text.inputEl.value.trim()) setICalUrl(this.plugin.authDeps(), calendar.id, text.inputEl.value);
						else clearICalUrl(this.plugin.authDeps(), calendar.id);
						urlSetting.setDesc("Saved securely. The feed is fetched only during sync.");
						urlSetting.descEl.removeClass("dailycalsync-setting-error");
					} catch (error) {
						urlSetting.setDesc((error as Error).message);
						urlSetting.descEl.addClass("dailycalsync-setting-error");
					}
				});
			});
			this.renderCalendarRows([calendar], async () => this.plugin.saveSettings(), false);
			new Setting(this.containerEl).setName("Remove feed").addButton((button) => button.setButtonText("Remove").setWarning().onClick(() => {
				new ConfirmRemovalModal(this.app, calendar.summary, async () => {
					clearICalUrl(this.plugin.authDeps(), calendar.id);
					delete settings.iCalCaches[calendar.id];
					settings.iCalCalendars = settings.iCalCalendars.filter((candidate) => candidate !== calendar);
					await this.plugin.saveSettings();
					this.display();
				}).open();
			}));
		}
	}

	private renderCalendarRows(calendars: CalendarConfig[], save: () => Promise<void>, allowReorder = true): void {
		for (const calendar of calendars) {
			const row = new Setting(this.containerEl).setName(calendar.summary);
			row.addToggle((toggle) => toggle.setValue(calendar.enabled).onChange(async (value) => {
				calendar.enabled = value;
				await save();
			}));
			row.addDropdown((dropdown) => dropdown.addOption("checkbox", "Checkbox").addOption("bullet", "Bullet").setValue(calendar.addAs).onChange(async (value) => {
				calendar.addAs = value as typeof calendar.addAs;
				await save();
			}));
			if (allowReorder) {
				row.addExtraButton((button) => button.setIcon("arrow-up").setTooltip("Move earlier").onClick(async () => {
					const index = calendars.indexOf(calendar);
					if (index > 0) calendars.splice(index - 1, 0, calendars.splice(index, 1)[0]);
					await save();
					this.display();
				}));
				row.addExtraButton((button) => button.setIcon("arrow-down").setTooltip("Move later").onClick(async () => {
					const index = calendars.indexOf(calendar);
					if (index >= 0 && index < calendars.length - 1) calendars.splice(index + 1, 0, calendars.splice(index, 1)[0]);
					await save();
					this.display();
				}));
			}
		}
	}

	private renderRendering(): void {
		const settings = this.plugin.settings;
		new Setting(this.containerEl).setName("Rendering and privacy").setHeading();
		const addToggle = (name: string, description: string, key: BooleanRenderingKey): void => {
			new Setting(this.containerEl).setName(name).setDesc(description).addToggle((toggle) => toggle.setValue(settings.rendering[key]).onChange(async (value) => {
				settings.rendering[key] = value;
				await this.plugin.saveSettings();
			}));
		};
		addToggle("All-day events first", "Group all-day events before timed events.", "allDayFirst");
		addToggle("Descriptions", "Persist event descriptions in footnotes.", "showDescriptions");
		addToggle("Attendees", "Persist attendee lists for events with at least three attendees.", "showAttendees");
		addToggle("Attendee email addresses", "Use emails when display names are unavailable.", "includeAttendeeEmails");
		addToggle("Locations", "Persist event locations.", "showLocations");
		addToggle("Meeting links", "Persist HTTPS meeting links.", "showMeetingLinks");
		addToggle("Redact private events", "Render private events as Busy.", "redactPrivateEvents");
		addToggle("Declined events", "Include declined events.", "includeDeclined");
		addToggle("Cancelled events", "Include cancelled occurrences.", "includeCancelled");
		addToggle("Free events", "Include transparent/free events.", "includeFreeEvents");
		addToggle("Focus time", "Include Google focus-time events.", "includeFocusTime");
		addToggle("Out of office", "Include Google out-of-office events.", "includeOutOfOffice");
		addToggle("Working location", "Include Google working-location events.", "includeWorkingLocation");
		addToggle("Birthdays", "Include Google birthday events.", "includeBirthdays");
		addToggle("Calendar colors", "Use stable theme-aware calendar color classes.", "useGoogleCalendarColors");
		new Setting(this.containerEl).setName("Clock").addDropdown((dropdown) => dropdown.addOption("system", "System default").addOption("12", "12-hour").addOption("24", "24-hour").setValue(settings.rendering.hourCycle).onChange(async (value) => {
			settings.rendering.hourCycle = value as typeof settings.rendering.hourCycle;
			await this.plugin.saveSettings();
		}));
		addToggle("End times", "Show event end times.", "showEndTime");
	}

	private renderSync(): void {
		const settings = this.plugin.settings;
		new Setting(this.containerEl).setName("Sync").setHeading();
		new Setting(this.containerEl).setName("Days ahead").addText((text) => {
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
		new Setting(this.containerEl).setName("Multi-day completion").addDropdown((dropdown) => dropdown.addOption("independent", "Keep days independent").addOption("ask", "Ask during manual sync").addOption("following", "Mark following days done").setValue(settings.multiDayCompletionBehavior).onChange(async (value) => {
			settings.multiDayCompletionBehavior = value as typeof settings.multiDayCompletionBehavior;
			if (value === "independent") settings.multiDayCompletionRules = {};
			await this.plugin.saveSettings();
		}));
		new Setting(this.containerEl).setName("Sync now").setDesc("Sync every enabled Google and iCalendar source into the configured range.").addButton((button) => button.setButtonText("Sync now").setCta().onClick(async () => {
			await syncAll(this.app.vault, this.plugin.authDeps(), this.plugin.syncOptions());
		}));
		new Setting(this.containerEl).setName("Automatic check (minutes)").setDesc("0 disables background checks.").addText((text) => {
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
		const failedCalendars = settings.googleAccounts.reduce((total, account) => total + account.calendars.filter((calendar) => account.calendarHealth[calendar.id]?.lastFailureAt).length, 0);
		new Setting(this.containerEl).setName("Sync health").setDesc(`Last success: ${settings.lastSuccessfulSyncAt ? window.moment(settings.lastSuccessfulSyncAt).fromNow() : "never"}. ${failedCalendars} Google calendar(s) have a recorded failure.`);
		new Setting(this.containerEl).setName("Diagnostics").setDesc("Copies redacted configuration and failures; URLs, IDs, credentials, and event content are excluded.").addButton((button) => button.setButtonText("Copy diagnostics").onClick(() => this.plugin.copyDiagnostics()));
	}

	private async refreshCalendarList(account: GoogleAccountProfile): Promise<void> {
		try {
			const fetched = await listCalendars(this.plugin.authDeps(account.id));
			const existingById = new Map(account.calendars.map((calendar) => [calendar.id, calendar]));
			account.calendars = fetched.map((item) => {
				const existing = existingById.get(item.id);
				return { id: item.id, summary: item.summary, enabled: existing?.enabled ?? false, addAs: existing?.addAs ?? "checkbox", colorId: item.colorId ?? existing?.colorId, color: item.backgroundColor ?? existing?.color };
			});
			await this.plugin.saveSettings();
		} catch (error) {
			new Notice(`DailyCalSync: failed to list calendars for ${account.name} — ${(error as Error).message}`);
		}
	}
}
