import { App, Modal, Setting } from "obsidian";
import type { MultiDayConfirmation } from "./sync";

class MultiDayCompletionModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly request: MultiDayConfirmation,
		private readonly resolveChoice: (propagate: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: "Multi-day event completed" });
		this.contentEl.createEl("p", {
			text: `“${this.request.title}” is checked on ${this.request.completedFrom}. Mark it done from that date through ${this.request.eventEnd}, including notes that have not been synced yet?`,
		});

		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Keep days separate").onClick(() => this.finish(false))
			)
			.addButton((button) =>
				button
					.setButtonText("Mark following done")
					.setCta()
					.onClick(() => this.finish(true))
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.resolveChoice(false);
		}
	}

	private finish(propagate: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveChoice(propagate);
		this.close();
	}
}

export function confirmMultiDayCompletion(
	app: App,
	request: MultiDayConfirmation
): Promise<boolean> {
	return new Promise((resolve) => new MultiDayCompletionModal(app, request, resolve).open());
}
