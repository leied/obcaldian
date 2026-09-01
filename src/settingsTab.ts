import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type DailyCalSyncPlugin from "./main";
import {
	clearGoogleAccountSecrets,
	connectGoogleAccount,
	disconnectGoogleAccount,
	getClientSecret,
	importGoogleCredentials,
	isConnected,
	revokeGoogleToken,
	setClientSecret,
	type AuthDeps,
} from "./googleAuth";
import { listCalendars } from "./googleCalendar";
import { clearICalUrl, getICalUrl, setICalUrl } from "./ical";
import { createLocalId } from "./localId";
import { OnboardingModal } from "./onboardingModal";
import { PrivacyModal } from "./privacyModal";
import type { CalendarConfig, GoogleAccountProfile, RenderingSettings } from "./settings";
import { syncAll } from "./sync";
import { isValidTimeZone } from "./timezone";

type BooleanRenderingKey = {
	[Key in keyof RenderingSettings]: RenderingSettings[Key] extends boolean ? Key : never;
}[keyof RenderingSettings];

export class DailyCalSyncSettingTab extends PluginSettingTab {
	private connectionAbortController: AbortController | null = null;
	private pendingRemovalId: string | null = null;

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
		this.renderMaintenance();
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
		const unfinishedAccount = settings.googleAccounts.find((account) =>
			!account.clientId || !getClientSecret(this.plugin.authDeps(account.id))
		);
		const hasAccount = settings.googleAccounts.length > 0;
		new Setting(this.containerEl).setName("Google accounts").setHeading();
		new Setting(this.containerEl)
			.setName(hasAccount ? "Need another Google account?" : "Add your Google account")
			.setDesc(unfinishedAccount
				? `Finish importing credentials for ${unfinishedAccount.name} before adding another account.`
				: hasAccount
					? "Add another only if you sync calendars from a different Google login. Each account remains isolated."
					: "Start with one account. You can add more later if you need them.")
			.addButton((button) => button
				.setButtonText(hasAccount ? "Add another account" : "Add Google account")
				.setDisabled(unfinishedAccount !== undefined)
				.setCta()
				.onClick(async () => {
					const stillUnfinished = settings.googleAccounts.find((account) =>
						!account.clientId || !getClientSecret(this.plugin.authDeps(account.id))
					);
					if (stillUnfinished) {
						new Notice(`DailyCalSync: finish setting up ${stillUnfinished.name} before adding another account.`);
						this.display();
						return;
					}
					settings.googleAccounts.push({ id: createLocalId("google"), name: `Google account ${settings.googleAccounts.length + 1}`, clientId: "", projectId: "", calendars: [], calendarHealth: {}, calendarCaches: {} });
					this.display();
					await this.plugin.saveSettings();
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
		const removalId = `google:${account.id}`;
		const removal = new Setting(this.containerEl)
			.setName("Remove profile")
			.setDesc(this.pendingRemovalId === removalId
				? `Remove ${account.name}? Existing Markdown will not be deleted.`
				: "Revokes the token when possible, then clears this profile's local secrets and cache.");
		if (this.pendingRemovalId === removalId) {
			removal
				.addButton((button) => button.setButtonText("Cancel").onClick(() => {
					this.pendingRemovalId = null;
					this.display();
				}))
				.addButton((button) => button.setButtonText("Confirm remove").setWarning().onClick(() => {
					button.setButtonText("Removing…").setDisabled(true);
					void this.removeGoogleAccount(account, deps);
				}));
		} else {
			removal.addButton((button) => button
				.setButtonText("Remove")
				.setWarning()
				.setDisabled(this.connectionAbortController !== null)
				.onClick(() => {
					this.pendingRemovalId = removalId;
					this.display();
				}));
		}
	}

	private renderICalFeeds(): void {
		const settings = this.plugin.settings;
		new Setting(this.containerEl).setName("Secret iCalendar feeds").setHeading();
		new Setting(this.containerEl).setName("Add read-only feed").setDesc("The HTTPS URL is stored only in Obsidian SecretStorage. Treat it like a password.").addButton((button) => button.setButtonText("Add iCal feed").onClick(async () => {
		settings.iCalCalendars.push({ id: createLocalId("ical"), summary: `iCalendar ${settings.iCalCalendars.length + 1}`, enabled: true, addAs: "checkbox" });
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
			const removalId = `ical:${calendar.id}`;
			const removal = new Setting(this.containerEl)
				.setName("Remove feed")
				.setDesc(this.pendingRemovalId === removalId
					? `Remove ${calendar.summary}? Existing Markdown will not be deleted.`
					: "Clears the feed URL and cached events from this device.");
			if (this.pendingRemovalId === removalId) {
				removal
					.addButton((button) => button.setButtonText("Cancel").onClick(() => {
						this.pendingRemovalId = null;
						this.display();
					}))
					.addButton((button) => button.setButtonText("Confirm remove").setWarning().onClick(() => {
						button.setButtonText("Removing…").setDisabled(true);
						void this.removeICalFeed(calendar);
					}));
			} else {
				removal.addButton((button) => button.setButtonText("Remove").setWarning().onClick(() => {
					this.pendingRemovalId = removalId;
					this.display();
				}));
			}
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

	private async removeGoogleAccount(account: GoogleAccountProfile, deps: AuthDeps): Promise<void> {
		try {
			const refreshToken = clearGoogleAccountSecrets(deps);
			const index = this.plugin.settings.googleAccounts.indexOf(account);
			if (index < 0) throw new Error("This profile was already removed.");
			this.plugin.settings.googleAccounts.splice(index, 1);
			this.pendingRemovalId = null;
			await this.plugin.saveSettings();
			this.display();
			new Notice(`DailyCalSync: removed ${account.name}.`);
			void revokeGoogleToken(refreshToken);
		} catch (error) {
			new Notice(`DailyCalSync: could not remove ${account.name} — ${(error as Error).message}`);
			this.display();
		}
	}

	private async removeICalFeed(calendar: CalendarConfig): Promise<void> {
		try {
			clearICalUrl(this.plugin.authDeps(), calendar.id);
			delete this.plugin.settings.iCalCaches[calendar.id];
			const index = this.plugin.settings.iCalCalendars.indexOf(calendar);
			if (index < 0) throw new Error("This feed was already removed.");
			this.plugin.settings.iCalCalendars.splice(index, 1);
			this.pendingRemovalId = null;
			await this.plugin.saveSettings();
			this.display();
			new Notice(`DailyCalSync: removed ${calendar.summary}.`);
		} catch (error) {
			new Notice(`DailyCalSync: could not remove ${calendar.summary} — ${(error as Error).message}`);
			this.display();
		}
	}

	private renderRendering(): void {
		const settings = this.plugin.settings;
		const addToggle = (name: string, description: string, key: BooleanRenderingKey): void => {
			new Setting(this.containerEl).setName(name).setDesc(description).addToggle((toggle) => toggle.setValue(settings.rendering[key]).onChange(async (value) => {
				settings.rendering[key] = value;
				await this.plugin.saveSettings();
			}));
		};
		new Setting(this.containerEl).setName("Calendar display").setHeading();
		addToggle("All-day events first", "Group all-day events before timed events.", "allDayFirst");
		addToggle("Calendar colors", "Use stable theme-aware calendar color classes.", "useGoogleCalendarColors");
		new Setting(this.containerEl).setName("Clock").addDropdown((dropdown) => dropdown.addOption("system", "System default").addOption("12", "12-hour").addOption("24", "24-hour").setValue(settings.rendering.hourCycle).onChange(async (value) => {
			settings.rendering.hourCycle = value as typeof settings.rendering.hourCycle;
			await this.plugin.saveSettings();
		}));
		addToggle("End times", "Show event end times.", "showEndTime");

		new Setting(this.containerEl).setName("Event details and privacy").setHeading();
		addToggle("Descriptions", "Persist event descriptions in footnotes.", "showDescriptions");
		addToggle("Attendees", "Persist attendee lists for events with at least three attendees.", "showAttendees");
		addToggle("Attendee email addresses", "Use emails when display names are unavailable.", "includeAttendeeEmails");
		addToggle("Locations", "Persist event locations.", "showLocations");
		addToggle("Meeting links", "Persist HTTPS meeting links.", "showMeetingLinks");
		addToggle("Redact private events", "Render private events as Busy.", "redactPrivateEvents");

		new Setting(this.containerEl).setName("Event filters").setHeading();
		addToggle("Declined events", "Include declined events.", "includeDeclined");
		addToggle("Cancelled events", "Include cancelled occurrences.", "includeCancelled");
		addToggle("Free events", "Include transparent/free events.", "includeFreeEvents");
		addToggle("Focus time", "Include Google focus-time events.", "includeFocusTime");
		addToggle("Out of office", "Include Google out-of-office events.", "includeOutOfOffice");
		addToggle("Working location", "Include Google working-location events.", "includeWorkingLocation");
		addToggle("Birthdays", "Include Google birthday events.", "includeBirthdays");
	}

	private renderSync(): void {
		const settings = this.plugin.settings;
		new Setting(this.containerEl).setName("Sync behavior").setHeading();
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
		new Setting(this.containerEl).setName("Multi-day completion").addDropdown((dropdown) => dropdown.addOption("ask", "Ask every time").addOption("independent", "Always check this day only").addOption("following", "Always check this and following days").addOption("all", "Always check the whole event").setValue(settings.multiDayCompletionBehavior).onChange(async (value) => {
			settings.multiDayCompletionBehavior = value as typeof settings.multiDayCompletionBehavior;
			if (value === "independent") settings.multiDayCompletionRules = {};
			await this.plugin.saveSettings();
		}));
		new Setting(this.containerEl).setName("Automation and status").setHeading();
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
		new Setting(this.containerEl).setName("Sync now").setDesc("Sync every enabled Google and iCalendar source into the configured range.").addButton((button) => button.setButtonText("Sync now").setCta().onClick(async () => {
			await syncAll(this.app.vault, this.plugin.authDeps(), this.plugin.syncOptions());
		}));
		const failedCalendars = settings.googleAccounts.reduce((total, account) => total + account.calendars.filter((calendar) => account.calendarHealth[calendar.id]?.lastFailureAt).length, 0);
		new Setting(this.containerEl).setName("Sync health").setDesc(`Last success: ${settings.lastSuccessfulSyncAt ? window.moment(settings.lastSuccessfulSyncAt).fromNow() : "never"}. ${failedCalendars} Google calendar(s) have a recorded failure.`);
		new Setting(this.containerEl).setName("Diagnostics").setDesc("Copies redacted configuration and failures; URLs, IDs, credentials, and event content are excluded.").addButton((button) => button.setButtonText("Copy diagnostics").onClick(() => this.plugin.copyDiagnostics()));
	}

	private renderMaintenance(): void {
		const settings = this.plugin.settings;
		const confirmationId = "maintenance:cached-data";
		new Setting(this.containerEl).setName("Data and maintenance").setHeading();
		const cleanup = new Setting(this.containerEl)
			.setName("Clear cached calendar data")
			.setDesc(this.pendingRemovalId === confirmationId
				? "Clear downloaded event caches and sync history now? Account connections, settings, completion rules, and daily notes are preserved."
				: "Removes downloaded event caches and sync health/history. The next sync rebuilds them; accounts, secrets, settings, completion rules, and notes are not changed.");
		if (this.pendingRemovalId === confirmationId) {
			cleanup
				.addButton((button) => button.setButtonText("Cancel").onClick(() => {
					this.pendingRemovalId = null;
					this.display();
				}))
				.addButton((button) => button.setButtonText("Clear cached data").setWarning().onClick(async () => {
					for (const account of settings.googleAccounts) {
						account.calendarCaches = {};
						account.calendarHealth = {};
					}
					settings.iCalCaches = {};
					settings.recentFailures = [];
					settings.lastSuccessfulSyncAt = undefined;
					this.pendingRemovalId = null;
					await this.plugin.saveSettings();
					this.display();
					new Notice("DailyCalSync: cached calendar data and sync history cleared.");
				}));
		} else {
			cleanup.addButton((button) => button.setButtonText("Clear cached data").setWarning().onClick(() => {
				this.pendingRemovalId = confirmationId;
				this.display();
			}));
		}
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
