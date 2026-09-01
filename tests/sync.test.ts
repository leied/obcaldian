import moment from "moment";
import { Notice, SecretStorage } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthDeps } from "../src/googleAuth";
import {
	cachedEventsForDay,
	calendarCacheEvents,
	refreshCalendarCache,
	type GoogleEvent,
} from "../src/googleCalendar";
import { DEFAULT_SETTINGS } from "../src/settings";
import { multiDayEventKey, multiDayEventMarker } from "../src/multiDay";
import {
	autoSyncTick,
	syncDateRange,
	syncRange,
	undoSyncSnapshot,
	type SyncUndoSnapshot,
} from "../src/sync";
import { FakeVault } from "./fakeVault";

vi.mock("../src/googleCalendar", () => ({
	refreshCalendarCache: vi.fn(async () => []),
	cachedEventsForDay: vi.fn((events: GoogleEvent[]) => events),
	calendarCacheEvents: vi.fn(() => []),
}));

function baseDeps(): AuthDeps {
	return {
		settings: {
			...DEFAULT_SETTINGS,
			calendarHealth: {},
			calendarCaches: {},
			multiDayCompletionRules: {},
			rendering: { ...DEFAULT_SETTINGS.rendering },
		},
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
	vi.mocked(refreshCalendarCache).mockReset().mockResolvedValue([]);
	vi.mocked(cachedEventsForDay).mockImplementation((events) => [...events]);
	vi.mocked(calendarCacheEvents).mockReset().mockReturnValue([]);
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

	it("does not overwrite a note or report success when one calendar fetch fails", async () => {
		const vault = new FakeVault();
		const todayPath = `${moment().format("YYYYMMDD")}.md`;
		const original = [
			"<!-- obcaldian:calendar:start -->",
			"previous calendar content",
			"<!-- obcaldian:calendar:end -->",
		].join("\n");
		await vault.create(todayPath, original);
		const deps = connectedDeps();
		deps.settings.calendars.push({
			id: "personal",
			summary: "Personal",
			enabled: true,
			addAs: "bullet",
		});
		vi.mocked(refreshCalendarCache)
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(new Error("network unavailable"));
		const onSuccess = vi.fn();
		const onError = vi.fn();

		await syncRange(vault as never, deps, 0, { notify: false, onSuccess, onError });

		expect(vault.contentOf(todayPath)).toBe(original);
		expect(onSuccess).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith(
			expect.stringMatching(
				/^Failed to fetch "Personal" for range starting \d{4}-\d{2}-\d{2}: network unavailable$/
			)
		);
		expect(Notice.instances).toHaveLength(0);
	});

	it("treats missing calendar markers as an error without leaking a background Notice", async () => {
		const vault = new FakeVault();
		const todayPath = `${moment().format("YYYYMMDD")}.md`;
		await vault.create(todayPath, "user note without plugin markers");
		const onSuccess = vi.fn();
		const onError = vi.fn();

		await syncRange(vault as never, connectedDeps(), 0, {
			notify: false,
			onSuccess,
			onError,
		});

		expect(vault.contentOf(todayPath)).toBe("user note without plugin markers");
		expect(onSuccess).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith(
			`Calendar markers not found in ${todayPath}; note was not changed.`
		);
		expect(Notice.instances).toHaveLength(0);
	});
});

describe("sync planning, preview, and undo", () => {
	it("does not write when the manual preview is cancelled", async () => {
		const vault = new FakeVault();
		await vault.create("Templates/Daily.md", "{{date}}\n{calendar}\n");
		const preview = vi.fn(async () => false);
		const onCancelled = vi.fn();
		await syncRange(vault as never, connectedDeps(), 0, { preview, onCancelled });
		expect(preview).toHaveBeenCalledWith(
			expect.objectContaining({ entries: [expect.objectContaining({ operation: "create" })] })
		);
		expect(onCancelled).toHaveBeenCalledOnce();
		expect(vault.contentOf(`${moment().format("YYYYMMDD")}.md`)).toBeUndefined();
	});

	it("skips missing notes in update-existing-only mode", async () => {
		const vault = new FakeVault();
		await vault.create("Templates/Daily.md", "{{date}}\n{calendar}\n");
		await syncRange(vault as never, connectedDeps(), 0, {
			notify: false,
			existingOnly: true,
		});
		expect(vault.contentOf(`${moment().format("YYYYMMDD")}.md`)).toBeUndefined();
	});

	it("preflights every note before changing the first one", async () => {
		const vault = new FakeVault();
		const today = `${moment().format("YYYYMMDD")}.md`;
		const tomorrow = `${moment().add(1, "day").format("YYYYMMDD")}.md`;
		const original = [
			"outside",
			"<!-- obcaldian:calendar:start -->",
			"old calendar",
			"<!-- obcaldian:calendar:end -->",
		].join("\n");
		await vault.create(today, original);
		await vault.create(tomorrow, "missing markers");
		const onError = vi.fn();
		await syncRange(vault as never, connectedDeps(), 1, { notify: false, onError });
		expect(vault.contentOf(today)).toBe(original);
		expect(onError).toHaveBeenCalledWith(
			`Calendar markers not found in ${tomorrow}; note was not changed.`
		);
	});

	it("undoes only the managed section and preserves later outside edits", async () => {
		const vault = new FakeVault();
		const today = `${moment().format("YYYYMMDD")}.md`;
		await vault.create(
			today,
			[
				"outside before",
				"<!-- obcaldian:calendar:start -->",
				"old calendar",
				"<!-- obcaldian:calendar:end -->",
			].join("\n")
		);
		let snapshot: SyncUndoSnapshot | undefined;
		await syncRange(vault as never, connectedDeps(), 0, {
			notify: false,
			onApplied: (value) => {
				snapshot = value;
			},
		});
		const synced = vault.contentOf(today)!;
		const file = vault.getAbstractFileByPath(today);
		expect(file).toBeTruthy();
		await vault.modify(file as never, `${synced}\noutside after`);
		const result = await undoSyncSnapshot(vault as never, snapshot!);
		expect(result).toEqual({ restored: 1, skipped: 0 });
		expect(vault.contentOf(today)).toContain("old calendar");
		expect(vault.contentOf(today)).toContain("outside after");
	});

	it("reattaches a recurring event annotation after the occurrence moves dates", async () => {
		const vault = new FakeVault();
		await vault.create("Templates/Daily.md", "{{date}}\n{calendar}\n");
		const originalStartTime = { dateTime: moment().hour(9).toISOString() };
		const oldEvent: GoogleEvent = {
			id: "instance-1",
			recurringEventId: "series-1",
			originalStartTime,
			summary: "Standup",
			start: { dateTime: moment().hour(9).toISOString() },
			end: { dateTime: moment().hour(10).toISOString() },
		};
		const movedEvent: GoogleEvent = {
			...oldEvent,
			start: { dateTime: moment().add(1, "day").hour(12).toISOString() },
			end: { dateTime: moment().add(1, "day").hour(13).toISOString() },
		};
		const key = `${multiDayEventKey("work", "series-1")}::${originalStartTime.dateTime}`;
		await vault.create(
			`${moment().format("YYYYMMDD")}.md`,
			[
				"<!-- obcaldian:calendar:start -->",
				`- [x] Standup ${multiDayEventMarker(key)} bring the report`,
				"<!-- obcaldian:calendar:end -->",
			].join("\n")
		);
		vi.mocked(calendarCacheEvents).mockReturnValue([oldEvent]);
		vi.mocked(refreshCalendarCache).mockResolvedValue([movedEvent]);
		vi.mocked(cachedEventsForDay).mockImplementation((events, date) =>
			date.format("YYYY-MM-DD") === moment().add(1, "day").format("YYYY-MM-DD")
				? [...events]
				: []
		);
		const tomorrow = moment().add(1, "day");
		await syncDateRange(vault as never, connectedDeps(), tomorrow, tomorrow, {
			notify: false,
		});
		expect(vault.contentOf(`${tomorrow.format("YYYYMMDD")}.md`)).toContain(
			"bring the report"
		);
	});
});

describe("multi-day completion behavior", () => {
	function spanningEvent(): GoogleEvent {
		return {
			id: "trip-123",
			summary: "Conference",
			start: { date: moment().format("YYYY-MM-DD") },
			end: { date: moment().add(3, "days").format("YYYY-MM-DD") },
		};
	}

	async function vaultWithCheckedFirstDay(event: GoogleEvent): Promise<FakeVault> {
		const vault = new FakeVault();
		await vault.create("Templates/Daily.md", "{{date}}\n{calendar}\n");
		const key = multiDayEventKey("work", event.id!);
		await vault.create(
			`${moment().format("YYYYMMDD")}.md`,
			[
				"<!-- obcaldian:calendar:start -->",
				`- [x] Conference ${multiDayEventMarker(key)}`,
				"<!-- obcaldian:calendar:end -->",
			].join("\n")
		);
		return vault;
	}

	it("persists automatic following-day completion for a note synced later", async () => {
		const event = spanningEvent();
		const vault = await vaultWithCheckedFirstDay(event);
		const deps = connectedDeps();
		deps.settings.multiDayCompletionBehavior = "following";
		deps.saveSettings = vi.fn(async () => {});
		vi.mocked(refreshCalendarCache).mockResolvedValue([event]);

		await syncRange(vault as never, deps, 1, { notify: false });

		const key = multiDayEventKey("work", event.id!);
		expect(deps.settings.multiDayCompletionRules[key]).toEqual({
			completedFrom: moment().format("YYYY-MM-DD"),
			eventEnd: moment().add(2, "days").format("YYYY-MM-DD"),
		});
		expect(vault.contentOf(`${moment().add(1, "day").format("YYYYMMDD")}.md`)).toContain(
			"- [x] Conference (Day 2/3)"
		);

		// Day 3 did not exist during the first sync. The persisted rule applies when it is synced later.
		await syncRange(vault as never, deps, 2, { notify: false });
		expect(vault.contentOf(`${moment().add(2, "days").format("YYYYMMDD")}.md`)).toContain(
			"- [x] Conference (Day 3/3)"
		);
		expect(deps.saveSettings).toHaveBeenCalled();
	});

	it("asks during manual sync and keeps days separate when declined", async () => {
		const event = spanningEvent();
		const vault = await vaultWithCheckedFirstDay(event);
		const deps = connectedDeps();
		deps.settings.multiDayCompletionBehavior = "ask";
		vi.mocked(refreshCalendarCache).mockResolvedValue([event]);
		const confirmMultiDay = vi.fn(async () => false);

		await syncRange(vault as never, deps, 1, { confirmMultiDay });

		expect(confirmMultiDay).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Conference",
				completedFrom: moment().format("YYYY-MM-DD"),
			})
		);
		expect(vault.contentOf(`${moment().add(1, "day").format("YYYYMMDD")}.md`)).toContain(
			"- [ ] Conference (Day 2/3)"
		);
		expect(deps.settings.multiDayCompletionRules).toEqual({});

		await syncRange(vault as never, deps, 1, { confirmMultiDay });
		expect(confirmMultiDay).toHaveBeenCalledTimes(2);
	});

	it("remembers an accepted manual choice for following unsynced dates", async () => {
		const event = spanningEvent();
		const vault = await vaultWithCheckedFirstDay(event);
		const deps = connectedDeps();
		deps.settings.multiDayCompletionBehavior = "ask";
		deps.saveSettings = vi.fn(async () => {});
		vi.mocked(refreshCalendarCache).mockResolvedValue([event]);
		const confirmMultiDay = vi.fn(async () => true);

		await syncRange(vault as never, deps, 0, { confirmMultiDay });

		const key = multiDayEventKey("work", event.id!);
		expect(deps.settings.multiDayCompletionRules[key]?.completedFrom).toBe(
			moment().format("YYYY-MM-DD")
		);
		expect(deps.settings.multiDayCompletionRules[key]?.eventEnd).toBe(
			moment().add(2, "days").format("YYYY-MM-DD")
		);
		// Cache/health is persisted after preflight, then the accepted completion rule after apply.
		expect(deps.saveSettings).toHaveBeenCalledTimes(2);
	});

	it("never prompts or propagates an unconfirmed choice during background sync", async () => {
		const event = spanningEvent();
		const vault = await vaultWithCheckedFirstDay(event);
		const deps = connectedDeps();
		deps.settings.multiDayCompletionBehavior = "ask";
		deps.settings.syncDaysAhead = 1;
		vi.mocked(refreshCalendarCache).mockResolvedValue([event]);
		const confirmMultiDay = vi.fn(async () => true);

		await autoSyncTick(vault as never, deps, { confirmMultiDay });

		expect(confirmMultiDay).not.toHaveBeenCalled();
		expect(vault.contentOf(`${moment().add(1, "day").format("YYYYMMDD")}.md`)).toContain(
			"- [ ] Conference (Day 2/3)"
		);
		expect(deps.settings.multiDayCompletionRules).toEqual({});
	});
});
