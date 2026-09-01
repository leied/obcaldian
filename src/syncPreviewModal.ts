import { App, Modal, Setting } from "obsidian";
import type { SyncPlan, SyncPlanEntry } from "./sync";

function sectionDiff(entry: SyncPlanEntry): string {
	if (entry.operation === "create") return entry.afterSection ?? "";
	const before = (entry.beforeSection ?? "").split("\n");
	const after = (entry.afterSection ?? "").split("\n");
	if (before.join("\n") === after.join("\n")) return "No managed-section changes.";
	return [
		...before.map((line) => `- ${line}`),
		...after.map((line) => `+ ${line}`),
	].join("\n");
}

class SyncPreviewModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly plan: SyncPlan,
		private readonly resolveChoice: (apply: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		const counts = { create: 0, change: 0, skip: 0 };
		for (const entry of this.plan.entries) counts[entry.operation] += 1;
		this.contentEl.createEl("h3", { text: "Calendar sync preview" });
		this.contentEl.createEl("p", {
			text: `${counts.create} to create, ${counts.change} to change, ${counts.skip} to skip. Only marker-delimited calendar sections will be updated.`,
		});
		const changes = this.contentEl.createDiv({ cls: "dailycalsync-sync-preview" });
		for (const entry of this.plan.entries) {
			const item = changes.createDiv({ cls: "dailycalsync-sync-preview-item" });
			item.createEl("strong", { text: `${entry.operation.toUpperCase()}: ${entry.path}` });
			if (entry.operation !== "skip") item.createEl("pre", { text: sectionDiff(entry) });
		}
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.finish(false)))
			.addButton((button) =>
				button.setButtonText("Apply sync").setCta().onClick(() => this.finish(true))
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.resolveChoice(false);
		}
	}

	private finish(apply: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveChoice(apply);
		this.close();
	}
}

export function confirmSyncPlan(app: App, plan: SyncPlan): Promise<boolean> {
	return new Promise((resolve) => new SyncPreviewModal(app, plan, resolve).open());
}
