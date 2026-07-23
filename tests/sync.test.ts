import moment from "moment";
import { Notice, SecretStorage } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthDeps } from "../src/googleAuth";
import { DEFAULT_SETTINGS } from "../src/settings";
import { syncRange } from "../src/sync";
import { FakeVault } from "./fakeVault";

vi.mock("../src/googleCalendar", () => ({
	listEventsForDay: vi.fn(async () => []),
}));

function baseDeps(): AuthDeps {
	return {
		settings: { ...DEFAULT_SETTINGS },
		saveSettings: async () => {},
		secretStorage: new SecretStorage(),
	};
}

function connectedDeps(): AuthDeps {
	const deps = baseDeps();
	deps.settings.tokenExpiresAt = Date.now() + 3600_000;
	deps.settings.calendars = [{ id: "work", summary: "Work", enabled: true, addAs: "checkbox" }];
	deps.settings.templatePath = "Templates/Daily.md";
	deps.secretStorage.setSecret("obcaldian-google-refresh-token", "refresh-token");
	return deps;
}

beforeEach(() => {
	Notice.instances = [];
});

describe("syncRange notifications", () => {
	it("shows a Notice when not connected, by default", async () => {
		await syncRange(new FakeVault() as never, baseDeps(), 0);
		expect(Notice.instances.map((n) => n.message)).toEqual([
			"Obcaldian: connect your Google account first.",
		]);
	});

	it("suppresses the not-connected Notice when notify is false", async () => {
		await syncRange(new FakeVault() as never, baseDeps(), 0, { notify: false });
		expect(Notice.instances).toHaveLength(0);
	});

	it("shows a success Notice by default once synced", async () => {
		const vault = new FakeVault();
		await vault.create("Templates/Daily.md", "{{date}}\n{calendar}\n");
		await syncRange(vault as never, connectedDeps(), 0);
		expect(Notice.instances.map((n) => n.message)).toEqual(["Obcaldian: synced 1 day."]);
	});

	it("suppresses the success Notice when notify is false, but still writes the note", async () => {
		const vault = new FakeVault();
		await vault.create("Templates/Daily.md", "{{date}}\n{calendar}\n");
		await syncRange(vault as never, connectedDeps(), 0, { notify: false });
		expect(Notice.instances).toHaveLength(0);
		const todayPath = `${moment().format("YYYYMMDD")}.md`;
		expect(vault.contentOf(todayPath)).toContain("<!-- obcaldian:calendar:start -->");
	});
});

describe("syncRange status callbacks", () => {
	it("calls onError (not onStart) when not connected", async () => {
		const onStart = vi.fn();
		const onSuccess = vi.fn();
		const onError = vi.fn();
		await syncRange(new FakeVault() as never, baseDeps(), 0, { onStart, onSuccess, onError });
		expect(onStart).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith("connect your Google account first");
	});

	it("calls onError when no calendars are enabled", async () => {
		const onError = vi.fn();
		const deps = connectedDeps();
		deps.settings.calendars = [];
		await syncRange(new FakeVault() as never, deps, 0, { onError });
		expect(onError).toHaveBeenCalledWith("no calendars enabled");
	});

	it("calls onStart then onSuccess with the day count once synced", async () => {
		const vault = new FakeVault();
		await vault.create("Templates/Daily.md", "{{date}}\n{calendar}\n");
		const calls: string[] = [];
		const onStart = vi.fn(() => calls.push("start"));
		const onSuccess = vi.fn(() => calls.push("success"));
		await syncRange(vault as never, connectedDeps(), 2, { onStart, onSuccess });
		expect(calls).toEqual(["start", "success"]);
		expect(onSuccess).toHaveBeenCalledWith(3);
	});

	it("calls onError with the failure message when a sync attempt throws", async () => {
		const vault = new FakeVault();
		const deps = connectedDeps();
		deps.settings.templatePath = ""; // ensureDailyNote throws without a template configured
		const onError = vi.fn();
		await syncRange(vault as never, deps, 0, { notify: false, onError });
		expect(onError).toHaveBeenCalledWith("Set a template file in Obcaldian settings first.");
	});
});
