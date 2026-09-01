import { App, Modal, Setting } from "obsidian";
import type { MultiDayConfirmation, MultiDayDecision } from "./sync";

class MultiDayCompletionModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly request: MultiDayConfirmation,
		private readonly resolveChoice: (decision: MultiDayDecision) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("dailycalsync-multi-day-modal");
		this.contentEl.createEl("h3", { text: "Multi-day event completed" });
		this.contentEl.createEl("p", {
			text: `\u201C${this.request.title}\u201D is checked on ${this.request.completedFrom}. Mark its other days done too, including notes that have not been synced yet?`,
		});

		new Setting(this.contentEl)
			.setClass("dailycalsync-multi-day-actions")
			.addButton((button) =>
				button.setButtonText("Cancel sync").onClick(() => this.finish("cancel"))
			)
			.addButton((button) =>
				button.setButtonText("Check this day only").onClick(() => this.finish("separate"))
			)
			.addButton((button) =>
				button
					.setButtonText(`Check through ${this.request.eventEnd}`)
					.onClick(() => this.finish("following"))
			)
			.addButton((button) =>
				button
					.setButtonText(`Whole event (${this.request.eventStart}\u2013${this.request.eventEnd})`)
					.setCta()
					.onClick(() => this.finish("whole"))
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.resolveChoice("cancel");
		}
	}

	private finish(decision: MultiDayDecision): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveChoice(decision);
		this.close();
	}
}

export function confirmMultiDayCompletion(
	app: App,
	request: MultiDayConfirmation
): Promise<MultiDayDecision> {
	return new Promise((resolve) => new MultiDayCompletionModal(app, request, resolve).open());
}
