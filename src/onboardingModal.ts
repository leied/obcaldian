import { App, Modal, Notice, Setting } from "obsidian";
import type DailyCalSyncPlugin from "./main";
import { setICalUrl } from "./ical";

function localId(prefix: string): string {
	const random = window.crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return `${prefix}-${random.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 48)}`;
}

export class OnboardingModal extends Modal {
	private step = 0;
	private iCalName = "My calendar";
	private iCalUrl = "";

	constructor(
		app: App,
		private readonly plugin: DailyCalSyncPlugin,
		private readonly changed: () => void = () => undefined
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("dailycalsync-onboarding");
		this.render();
	}

	onClose(): void {
		this.changed();
		this.contentEl.empty();
	}

	private render(): void {
		this.contentEl.empty();
		this.titleEl.setText(`DailyCalSync setup · ${this.step + 1} of 4`);
		if (this.step === 0) this.renderWelcome();
		if (this.step === 1) this.renderDailyNotes();
		if (this.step === 2) this.renderSources();
		if (this.step === 3) this.renderFinish();
		const navigation = new Setting(this.contentEl);
		if (this.step > 0) navigation.addButton((button) => button.setButtonText("Back").onClick(() => {
			this.step -= 1;
			this.render();
		}));
		if (this.step < 3) navigation.addButton((button) => button.setButtonText("Continue").setCta().onClick(() => {
			this.step += 1;
			this.render();
		}));
	}

	private renderWelcome(): void {
		this.contentEl.createEl("h2", { text: "Calendar sync that respects your notes" });
		this.contentEl.createEl("p", { text: "DailyCalSync writes only inside its managed calendar markers. Existing prose stays untouched, and manual syncs show a preview before writing." });
		this.contentEl.createEl("p", { text: "Start with one Google account, a read-only Secret iCalendar feed, or both. You can add more Google accounts later if you need them." });
		this.contentEl.createEl("p", { text: "Credentials, refresh tokens, and Secret iCal URLs are stored in Obsidian SecretStorage. There is no analytics or publisher service." });
	}

	private renderDailyNotes(): void {
		const settings = this.plugin.settings;
		this.contentEl.createEl("h2", { text: "Choose your daily-note setup" });
		new Setting(this.contentEl).setName("Use core Daily Notes settings").setDesc("Copies its folder, template, and filename format now.").addButton((button) => button.setButtonText("Use Daily Notes").setCta().onClick(async () => {
			settings.useDailyNotesSettings = true;
			if (await this.plugin.syncDailyNotesSettings()) new Notice("DailyCalSync: Daily Notes settings imported.");
			else new Notice("DailyCalSync: enable and configure the core Daily Notes plugin first.");
			this.render();
		}));
		new Setting(this.contentEl).setName("Template path").setDesc("The template must contain {calendar}.").addText((text) => text.setPlaceholder("Templates/Daily.md").setValue(settings.templatePath).onChange(async (value) => {
			settings.useDailyNotesSettings = false;
			settings.templatePath = value;
			await this.plugin.saveSettings();
		}));
		new Setting(this.contentEl).setName("Daily note folder").setDesc("Leave blank for the vault root.").addText((text) => text.setValue(settings.dailyNoteFolder).onChange(async (value) => {
			settings.useDailyNotesSettings = false;
			settings.dailyNoteFolder = value;
			await this.plugin.saveSettings();
		}));
		new Setting(this.contentEl).setName("Filename format").addText((text) => text.setValue(settings.dailyNoteFormat).onChange(async (value) => {
			settings.useDailyNotesSettings = false;
			settings.dailyNoteFormat = value.trim() || "YYYYMMDD";
			await this.plugin.saveSettings();
		}));
	}

	private renderSources(): void {
		const settings = this.plugin.settings;
		this.contentEl.createEl("h2", { text: "Add calendar sources" });
		const hasGoogleProfile = settings.googleAccounts.length > 0;
		new Setting(this.contentEl)
			.setName("Google account")
			.setDesc(hasGoogleProfile
				? "Your first Google profile is ready to configure. Add more later from DailyCalSync settings if needed."
				: "Creates one isolated profile. Import its Desktop OAuth JSON and connect from the settings page after this wizard.")
			.addButton((button) => button
				.setButtonText(hasGoogleProfile ? "Profile added" : "Add Google profile")
				.setDisabled(hasGoogleProfile)
				.onClick(async () => {
					if (settings.googleAccounts.length > 0) return;
					settings.googleAccounts.push({ id: localId("google"), name: "Google account", clientId: "", projectId: "", calendars: [], calendarHealth: {}, calendarCaches: {} });
					this.render();
					await this.plugin.saveSettings();
					new Notice("DailyCalSync: Google profile added. You can add more later from settings.");
				}));
		new Setting(this.contentEl).setName("iCalendar feed name").addText((text) => text.setValue(this.iCalName).onChange((value) => {
			this.iCalName = value;
		}));
		new Setting(this.contentEl).setName("Secret iCal URL").setDesc("HTTPS only. The complete URL is stored in SecretStorage.").addText((text) => {
			text.inputEl.type = "password";
			text.setPlaceholder("https://…/calendar.ics").setValue(this.iCalUrl).onChange((value) => {
				this.iCalUrl = value;
			});
		});
		new Setting(this.contentEl).setName("Add read-only iCalendar feed").addButton((button) => button.setButtonText("Add feed").onClick(async () => {
			try {
				const id = localId("ical");
				setICalUrl(this.plugin.authDeps(), id, this.iCalUrl);
				settings.iCalCalendars.push({ id, summary: this.iCalName.trim() || "iCalendar feed", enabled: true, addAs: "checkbox" });
				await this.plugin.saveSettings();
				this.iCalUrl = "";
				new Notice("DailyCalSync: iCalendar feed added.");
				this.render();
			} catch (error) {
				new Notice(`DailyCalSync: ${(error as Error).message}`);
			}
		}));
		this.contentEl.createEl("p", { text: `${settings.googleAccounts.length} Google profile(s) and ${settings.iCalCalendars.length} iCalendar feed(s) configured.` });
	}

	private renderFinish(): void {
		const settings = this.plugin.settings;
		const dailyReady = Boolean(settings.templatePath || settings.useDailyNotesSettings);
		const sourceReady = settings.googleAccounts.length + settings.iCalCalendars.length > 0;
		const enabled = settings.googleAccounts.some((account) => account.calendars.some((calendar) => calendar.enabled)) || settings.iCalCalendars.some((calendar) => calendar.enabled);
		this.contentEl.createEl("h2", { text: "Review" });
		const list = this.contentEl.createEl("ul");
		list.createEl("li", { text: `${dailyReady ? "✓" : "○"} Daily-note template` });
		list.createEl("li", { text: `${sourceReady ? "✓" : "○"} Calendar source` });
		list.createEl("li", { text: `${enabled ? "✓" : "○"} At least one enabled calendar` });
		this.contentEl.createEl("p", { text: enabled ? "Setup is ready for a preview sync." : "Finish connecting Google and enable calendars from DailyCalSync settings. iCalendar feeds are enabled when added." });
		new Setting(this.contentEl).addButton((button) => button.setButtonText("Finish setup").setCta().onClick(async () => {
			settings.onboardingComplete = true;
			await this.plugin.saveSettings();
			this.close();
		}));
	}
}
