import { App, Modal, Setting } from "obsidian";
import type { TFile } from "obsidian";

export class RepairCalendarModal extends Modal {
	constructor(
		app: App,
		private readonly file: TFile,
		private readonly onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: "Repair calendar section" });
		this.contentEl.createEl("p", {
			text: `Append a new managed calendar section to ${this.file.path}? Existing note content will not be changed.`,
		});
		this.contentEl.createEl("pre", {
			text: "<!-- dailycalsync:calendar:start -->\n_(not yet synced)_\n<!-- dailycalsync:calendar:end -->",
		});
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Insert markers")
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
