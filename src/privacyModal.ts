import { App, Modal, Setting } from "obsidian";

export class PrivacyModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: "Privacy and data handling" });
		this.contentEl.createEl("p", {
			text: "Calendar data and OAuth tokens travel only between this device and Google. The plugin has no analytics, telemetry, publisher proxy, or hosted backend.",
		});
		this.contentEl.createEl("p", {
			text: "Rendered events are copied into daily notes. A local plugin-data cache can contain event metadata. OAuth secrets and tokens use Obsidian SecretStorage. Imported credentials files and their paths are not retained.",
		});
		this.contentEl.createEl("p", {
			text: "HTTPS requests are restricted to Google authorization, token, revocation, and Calendar API hosts. The temporary OAuth callback binds only to 127.0.0.1.",
		});
		this.contentEl.createEl("p", {
			text: "Disconnecting clears local OAuth tokens but does not remove Markdown already written to the vault. The complete policy is in PRIVACY.md in the plugin repository.",
		});
		new Setting(this.contentEl).addButton((button) =>
			button.setButtonText("Close").setCta().onClick(() => this.close())
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
