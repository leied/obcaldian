import { App, Modal, Setting } from "obsidian";

/** Prompts for how many days ahead of today to sync, pre-filled with a default. */
export class SyncDaysModal extends Modal {
	private days: number;
	private readonly onSubmit: (days: number) => void;

	constructor(app: App, defaultDays: number, onSubmit: (days: number) => void) {
		super(app);
		this.days = defaultDays;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Sync next N days" });

		new Setting(contentEl)
			.setName("Days ahead")
			.setDesc("Sync today plus this many days ahead.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.setValue(String(this.days)).onChange((value) => {
					const parsed = Number(value);
					if (Number.isFinite(parsed) && parsed >= 0) {
						this.days = Math.floor(parsed);
					}
				});
				text.inputEl.focus();
			});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Sync")
				.setCta()
				.onClick(() => {
					this.close();
					this.onSubmit(this.days);
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
