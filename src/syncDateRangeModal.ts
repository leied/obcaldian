import { App, Modal, Setting } from "obsidian";
import type { Moment } from "moment";

export interface DateRangeChoice {
	start: Moment;
	end: Moment;
	existingOnly: boolean;
}

export class SyncDateRangeModal extends Modal {
	private start: string;
	private end: string;
	private existingOnly: boolean;

	constructor(
		app: App,
		defaultDaysAhead: number,
		defaultExistingOnly: boolean,
		private readonly onSubmit: (choice: DateRangeChoice) => void
	) {
		super(app);
		this.start = window.moment().format("YYYY-MM-DD");
		this.end = window.moment().add(defaultDaysAhead, "day").format("YYYY-MM-DD");
		this.existingOnly = defaultExistingOnly;
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: "Sync calendar date range" });
		new Setting(this.contentEl).setName("Start date").addText((text) => {
			text.inputEl.type = "date";
			text.setValue(this.start).onChange((value) => {
				this.start = value;
			});
		});
		new Setting(this.contentEl).setName("End date").addText((text) => {
			text.inputEl.type = "date";
			text.setValue(this.end).onChange((value) => {
				this.end = value;
			});
		});
		new Setting(this.contentEl)
			.setName("Update existing notes only")
			.setDesc("Skip dates whose daily note does not already exist.")
			.addToggle((toggle) =>
				toggle.setValue(this.existingOnly).onChange((value) => {
					this.existingOnly = value;
				})
			);
		new Setting(this.contentEl).addButton((button) =>
			button
				.setButtonText("Preview sync")
				.setCta()
				.onClick(() => {
					const start = window.moment(this.start, "YYYY-MM-DD", true);
					const end = window.moment(this.end, "YYYY-MM-DD", true);
					if (!start.isValid() || !end.isValid()) return;
					this.close();
					this.onSubmit({ start, end, existingOnly: this.existingOnly });
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
