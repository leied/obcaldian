import moment from "moment";
import { describe, expect, it } from "vitest";
import {
	ensureDailyNote,
	extractPreservedEvents,
	fileNameFor,
	notePathFor,
	renderCalendarBlock,
	syncNoteCalendarSection,
} from "../src/dailyNote";
import type { GoogleEvent } from "../src/googleCalendar";
import { multiDayEventKey, multiDayEventMarker } from "../src/multiDay";
import { DEFAULT_SETTINGS } from "../src/settings";
import { FakeVault } from "./fakeVault";

const DATE = moment("2026-07-22");
const WORK_HEADING =
	'<span class="dailycalsync-calendar-label dailycalsync-calendar-pexppc"></span> **Work**';

describe("fileNameFor / notePathFor", () => {
	it("names the file YYYYMMDD.md", () => {
		expect(fileNameFor(DATE)).toBe("20260722.md");
	});

	it("puts it in the vault root when no folder is configured", () => {
		expect(notePathFor({ ...DEFAULT_SETTINGS, dailyNoteFolder: "" }, DATE)).toBe("20260722.md");
	});

	it("nests it under the configured folder", () => {
		expect(notePathFor({ ...DEFAULT_SETTINGS, dailyNoteFolder: "Daily" }, DATE)).toBe(
			"Daily/20260722.md"
		);
	});
});

describe("renderCalendarBlock", () => {
	const calendars = [
		{ id: "work", summary: "Work", enabled: true, addAs: "checkbox" as const },
		{ id: "personal", summary: "Personal", enabled: false, addAs: "bullet" as const },
	];

	it("renders '(no events)' when nothing is enabled or scheduled", () => {
		expect(renderCalendarBlock(calendars, new Map())).toBe("_(no events)_");
	});

	it("renders a checkbox line with a time for a timed event", () => {
		const events: GoogleEvent[] = [
			{ summary: "Standup", start: { dateTime: "2026-07-22T09:00:00Z" }, end: {} },
		];
		const block = renderCalendarBlock(calendars, new Map([["work", events]]));
		expect(block).toBe(`${WORK_HEADING}\n- [ ] 09:00 Standup`);
	});

	it("renders a start-end time range when both are known and differ", () => {
		const events: GoogleEvent[] = [
			{
				summary: "Standup",
				start: { dateTime: "2026-07-22T09:00:00Z" },
				end: { dateTime: "2026-07-22T09:30:00Z" },
			},
		];
		const block = renderCalendarBlock(calendars, new Map([["work", events]]));
		expect(block).toBe(`${WORK_HEADING}\n- [ ] 09:00-09:30 Standup`);
	});

	it("renders timed events in the configured timezone", () => {
		const events: GoogleEvent[] = [
			{
				summary: "Breakfast",
				start: { dateTime: "2026-07-22T09:00:00Z" },
				end: { dateTime: "2026-07-22T09:30:00Z" },
			},
		];
		const block = renderCalendarBlock(
			calendars,
			new Map([["work", events]]),
			"America/Los_Angeles"
		);
		expect(block).toBe(`${WORK_HEADING}\n- [ ] 02:00-02:30 Breakfast`);
	});

	it("collapses the range to a single time when start and end match", () => {
		const events: GoogleEvent[] = [
			{
				summary: "Instant",
				start: { dateTime: "2026-07-22T09:00:00Z" },
				end: { dateTime: "2026-07-22T09:00:00Z" },
			},
		];
		const block = renderCalendarBlock(calendars, new Map([["work", events]]));
		expect(block).toBe(`${WORK_HEADING}\n- [ ] 09:00 Instant`);
	});

	it("links the title to the event's htmlLink when present", () => {
		const events: GoogleEvent[] = [
			{
				summary: "Standup",
				htmlLink: "https://calendar.google.com/event?eid=abc123",
				start: { dateTime: "2026-07-22T09:00:00Z" },
				end: {},
			},
		];
		const block = renderCalendarBlock(calendars, new Map([["work", events]]));
		expect(block).toBe(
			`${WORK_HEADING}\n- [ ] 09:00 [Standup](https://calendar.google.com/event?eid=abc123)`
		);
	});

	it("skips disabled calendars even if events are present", () => {
		const events: GoogleEvent[] = [{ summary: "Yoga", start: {}, end: {} }];
		const block = renderCalendarBlock(calendars, new Map([["personal", events]]));
		expect(block).toBe("_(no events)_");
	});

	it("appends a footnote with the description when one is present", () => {
		const events: GoogleEvent[] = [
			{
				summary: "Planning",
				description: "Quarterly roadmap review.",
				start: { dateTime: "2026-07-22T14:00:00Z" },
				end: {},
			},
		];
		const block = renderCalendarBlock(calendars, new Map([["work", events]]));
		expect(block).toBe(
			`${WORK_HEADING}\n- [ ] 14:00 Planning[^dailycalsync-1]\n\n[^dailycalsync-1]: Quarterly roadmap review.`
		);
	});

	it("does not list participants when there are fewer than 3 attendees", () => {
		const events: GoogleEvent[] = [
			{
				summary: "1:1",
				attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
				start: {},
				end: {},
			},
		];
		const block = renderCalendarBlock(calendars, new Map([["work", events]]));
		expect(block).toBe(`${WORK_HEADING}\n- [ ] 1:1`);
	});

	it("lists participants by display name (falling back to email) once there are 3+", () => {
		const events: GoogleEvent[] = [
			{
				summary: "Sync",
				attendees: [
					{ email: "alice@example.com", displayName: "Alice" },
					{ email: "bob@example.com", displayName: "Bob" },
					{ email: "carol@example.com" },
				],
				start: {},
				end: {},
			},
		];
		const block = renderCalendarBlock(calendars, new Map([["work", events]]));
		expect(block).toBe(
			`${WORK_HEADING}\n- [ ] Sync[^dailycalsync-1]\n\n[^dailycalsync-1]: Participants: Alice, Bob, carol@example.com`
		);
	});

	it("combines description and a 3+ participant list in one footnote, numbering across events", () => {
		const events: GoogleEvent[] = [
			{
				summary: "Kickoff",
				description: "Project kickoff.",
				attendees: [
					{ email: "a@example.com" },
					{ email: "b@example.com" },
					{ email: "c@example.com" },
				],
				start: {},
				end: {},
			},
			{
				summary: "Retro",
				description: "Sprint retro.",
				start: {},
				end: {},
			},
		];
		const block = renderCalendarBlock(calendars, new Map([["work", events]]));
		expect(block).toBe(
			[
				WORK_HEADING,
				"- [ ] Kickoff[^dailycalsync-1]",
				"- [ ] Retro[^dailycalsync-2]",
				"",
				"[^dailycalsync-1]: Project kickoff.",
				"    Participants: a@example.com, b@example.com, c@example.com",
				"[^dailycalsync-2]: Sprint retro.",
			].join("\n")
		);
	});

	it("labels and preserves the checked state of a multi-day occurrence", () => {
		const event: GoogleEvent = {
			id: "conference-123",
			summary: "Conference",
			start: { date: "2026-07-21" },
			end: { date: "2026-07-24" },
		};
		const key = multiDayEventKey("work", event.id!);
		const block = renderCalendarBlock(
			calendars,
			new Map([["work", [event]]]),
			"UTC",
			"2026-07-22",
			new Set([key])
		);
		expect(block).toBe(
			`${WORK_HEADING}\n- [x] Conference (Day 2/3) ${multiDayEventMarker(key)}`
		);
	});

	it("preserves checkbox state and attached annotations for a single-day event", () => {
		const event: GoogleEvent = {
			id: "standup-1",
			summary: "Standup",
			start: { dateTime: "2026-07-22T09:00:00Z" },
			end: { dateTime: "2026-07-22T09:30:00Z" },
		};
		const key = multiDayEventKey("work", event.id!);
		const previous = [
			"<!-- dailycalsync:calendar:start -->",
			`- [x] 09:00 Standup ${multiDayEventMarker(key)} follow up with Alice`,
			"  - user-authored detail",
			"<!-- dailycalsync:calendar:end -->",
		].join("\n");
		const block = renderCalendarBlock(
			calendars,
			new Map([["work", [event]]]),
			"UTC",
			"2026-07-22",
			new Set(),
			DEFAULT_SETTINGS.rendering,
			extractPreservedEvents(previous)
		);
		expect(block).toContain(`- [x] 09:00-09:30 Standup ${multiDayEventMarker(key)} follow up with Alice`);
		expect(block).toContain("  - user-authored detail");
	});

	it("escapes event Markdown and rejects non-Google event links", () => {
		const event: GoogleEvent = {
			id: "unsafe-1",
			summary: "[Injected](javascript:alert(1)) <!-- dailycalsync:calendar:end -->",
			htmlLink: "javascript:alert(1)",
			start: {},
			end: {},
		};
		const block = renderCalendarBlock(calendars, new Map([["work", [event]]]));
		expect(block).not.toContain("](javascript:");
		expect(block).not.toContain("<!-- dailycalsync:calendar:end -->");
		expect(block).toContain(multiDayEventMarker(multiDayEventKey("work", event.id!)));
	});

	it("redacts private event details when configured", () => {
		const event: GoogleEvent = {
			id: "private-1",
			summary: "Medical appointment",
			description: "Sensitive details",
			visibility: "private",
			start: {},
			end: {},
		};
		const block = renderCalendarBlock(
			calendars,
			new Map([["work", [event]]]),
			"UTC",
			undefined,
			new Set(),
			{ ...DEFAULT_SETTINGS.rendering, redactPrivateEvents: true }
		);
		expect(block).toContain("Busy");
		expect(block).not.toContain("Medical appointment");
		expect(block).not.toContain("Sensitive details");
	});
});

describe("ensureDailyNote", () => {
	it("creates a note from the template, substituting {{date}} and the {calendar} marker block", async () => {
		const vault = new FakeVault();
		await vault.create("Templates/Daily.md", "# {{date}}\n\n{calendar}\n\n## Notes\n");
		const settings = {
			...DEFAULT_SETTINGS,
			templatePath: "Templates/Daily.md",
			dailyNoteFolder: "",
		};

		const file = await ensureDailyNote(vault as never, settings, DATE);

		expect(file.path).toBe("20260722.md");
		const content = vault.contentOf("20260722.md");
		expect(content).toContain("# 2026-07-22");
		expect(content).toContain("<!-- dailycalsync:calendar:start -->");
		expect(content).toContain('_(not yet synced');
	});

	it("returns the existing note without touching its content if it already exists", async () => {
		const vault = new FakeVault();
		await vault.create("Templates/Daily.md", "{{date}}\n{calendar}\n");
		await vault.create("20260722.md", "already here, user-edited");
		const settings = { ...DEFAULT_SETTINGS, templatePath: "Templates/Daily.md" };

		await ensureDailyNote(vault as never, settings, DATE);

		expect(vault.contentOf("20260722.md")).toBe("already here, user-edited");
	});

	it("throws if no template is configured", async () => {
		const vault = new FakeVault();
		await expect(ensureDailyNote(vault as never, DEFAULT_SETTINGS, DATE)).rejects.toThrow(
			/template/i
		);
	});

	it("does not create a note when the template has no calendar token", async () => {
		const vault = new FakeVault();
		await vault.create("Templates/Daily.md", "# {{date}}\n\n## Notes\n");
		const settings = { ...DEFAULT_SETTINGS, templatePath: "Templates/Daily.md" };

		await expect(ensureDailyNote(vault as never, settings, DATE)).rejects.toThrow(
			/template is missing \{calendar\}/i
		);
		expect(vault.contentOf("20260722.md")).toBeUndefined();
	});
});

describe("syncNoteCalendarSection", () => {
	it("upgrades legacy marker blocks without losing surrounding content", async () => {
		const vault = new FakeVault();
		await vault.create(
			"legacy.md",
			"before\n<!-- obcaldian:calendar:start -->\nold\n<!-- obcaldian:calendar:end -->\nafter"
		);
		const file = vault.getAbstractFileByPath("legacy.md");
		await syncNoteCalendarSection(vault as never, file as never, "new", false);
		expect(vault.contentOf("legacy.md")).toBe(
			"before\n<!-- dailycalsync:calendar:start -->\nnew\n<!-- dailycalsync:calendar:end -->\nafter"
		);
	});

	it("replaces only the content between the markers", async () => {
		const vault = new FakeVault();
		const file = await vault.create(
			"20260722.md",
			[
				"# Daily",
				"<!-- dailycalsync:calendar:start -->",
				"_(not yet synced)_",
				"<!-- dailycalsync:calendar:end -->",
				"## Notes",
				"user text here",
			].join("\n")
		);

		const ok = await syncNoteCalendarSection(vault as never, file, "**Work**\n- [ ] 09:00 Standup");

		expect(ok).toBe(true);
		expect(vault.contentOf("20260722.md")).toBe(
			[
				"# Daily",
				"<!-- dailycalsync:calendar:start -->",
				"**Work**",
				"- [ ] 09:00 Standup",
				"<!-- dailycalsync:calendar:end -->",
				"## Notes",
				"user text here",
			].join("\n")
		);
	});

	it("does nothing and returns false if the markers are missing", async () => {
		const vault = new FakeVault();
		const file = await vault.create("20260722.md", "no markers here");

		const ok = await syncNoteCalendarSection(vault as never, file, "new block");

		expect(ok).toBe(false);
		expect(vault.contentOf("20260722.md")).toBe("no markers here");
	});

	it("matches the end marker after the start marker when an orphan end marker appears earlier", async () => {
		const vault = new FakeVault();
		const file = await vault.create(
			"20260722.md",
			[
				"<!-- dailycalsync:calendar:end -->",
				"<!-- dailycalsync:calendar:start -->",
				"old block",
				"<!-- dailycalsync:calendar:end -->",
			].join("\n")
		);

		const ok = await syncNoteCalendarSection(vault as never, file, "new block");

		expect(ok).toBe(true);
		expect(vault.contentOf("20260722.md")).toContain(
			"<!-- dailycalsync:calendar:start -->\nnew block\n<!-- dailycalsync:calendar:end -->"
		);
	});
});
