import moment from "moment";
import { describe, expect, it } from "vitest";
import {
	ensureDailyNote,
	eventIsCheckedInNote,
	extractPreservedEvents,
	fileNameFor,
	notePathFor,
	renderCalendarBlock,
	syncNoteCalendarSection,
	templateFileFor,
} from "../src/dailyNote";
import type { GoogleEvent } from "../src/googleCalendar";
import { encodeEventKey, multiDayEventKey, multiDayEventMarker } from "../src/multiDay";
import { DEFAULT_SETTINGS } from "../src/settings";
import { FakeVault } from "./fakeVault";

const DATE = moment("2026-07-22");
/** The rendered event lines, dropping the identity index appended after them. */
const eventLines = (block: string): string => block.split("\n\n<!-- dailycalsync:index")[0];

const WORK_HEADING =
	'<span class="dailycalsync-calendar-heading"><span class="dailycalsync-calendar-label dailycalsync-calendar-pexppc"></span>**Work**</span>';

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
			`${WORK_HEADING}\n- [ ] Sync[^dailycalsync-1]\n\n[^dailycalsync-1]: **Participants:** Alice, Bob, carol@example.com`
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
				"    **Participants:** a@example.com, b@example.com, c@example.com",
				"[^dailycalsync-2]: Sprint retro.",
			].join("\n")
		);
	});

	it("separates calendars with a blank line so the next heading is not folded into the list", () => {
		const both = [
			{ id: "work", summary: "Work", enabled: true, addAs: "checkbox" as const },
			{ id: "personal", summary: "Personal", enabled: true, addAs: "bullet" as const },
		];
		const block = renderCalendarBlock(
			both,
			new Map([
				["work", [{ summary: "Standup", start: {}, end: {} }] as GoogleEvent[]],
				["personal", [{ summary: "Yoga", start: {}, end: {} }] as GoogleEvent[]],
			])
		);
		expect(block).toBe(
			[
				WORK_HEADING,
				"- [ ] Standup",
				"",
				'<span class="dailycalsync-calendar-heading"><span class="dailycalsync-calendar-label dailycalsync-calendar-3e4eq5"></span>**Personal**</span>',
				"- Yoga",
			].join("\n")
		);
	});

	it("turns HTML in a description into line breaks and decoded text", () => {
		const events: GoogleEvent[] = [
			{
				summary: "Quarter break",
				description:
					"Ongoing event<br>Year: 2026<br /><p>Break between summer &amp; autumn quarters.</p>",
				start: {},
				end: {},
			},
		];
		const block = renderCalendarBlock(calendars, new Map([["work", events]]));
		expect(block).toBe(
			[
				WORK_HEADING,
				"- [ ] Quarter break[^dailycalsync-1]",
				"",
				"[^dailycalsync-1]: Ongoing event",
				"    Year: 2026",
				"    Break between summer & autumn quarters.",
			].join("\n")
		);
	});

	it("omits the description entirely when it is nothing but markup", () => {
		const events: GoogleEvent[] = [
			{ summary: "Empty", description: "<div><br></div>", start: {}, end: {} },
		];
		const block = renderCalendarBlock(calendars, new Map([["work", events]]));
		expect(block).toBe(`${WORK_HEADING}\n- [ ] Empty`);
	});

	it("labels location and meeting lines in the footnote", () => {
		const events: GoogleEvent[] = [
			{
				summary: "Review",
				location: "Room&nbsp;4",
				hangoutLink: "https://meet.google.com/abc-defg-hij",
				start: {},
				end: {},
			},
		];
		const block = renderCalendarBlock(calendars, new Map([["work", events]]));
		expect(block).toBe(
			[
				WORK_HEADING,
				"- [ ] Review[^dailycalsync-1]",
				"",
				"[^dailycalsync-1]: **Location:** Room 4",
				"    **Meeting:** https://meet.google.com/abc-defg-hij",
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
		expect(eventLines(block)).toBe(`${WORK_HEADING}\n- [x] Conference (Day 2/3)`);
		expect(block).not.toContain("<!-- dailycalsync:event:");
		expect(eventIsCheckedInNote(block, key)).toBe(true);
		expect(eventIsCheckedInNote(block, multiDayEventKey("work", "other"))).toBe(false);
	});

	it("indexes identity once at the end of the block instead of on each event line", () => {
		const events: GoogleEvent[] = [
			{ id: "a-1", summary: "Standup", start: {}, end: {} },
			{ id: "b-1", summary: "Retro", start: {}, end: {} },
		];
		const block = renderCalendarBlock(calendars, new Map([["work", events]]), "UTC");
		expect(eventLines(block)).toBe(`${WORK_HEADING}\n- [ ] Standup\n- [ ] Retro`);
		expect(block.split("<!-- dailycalsync:index")).toHaveLength(2);
		expect([...extractPreservedEvents(block).keys()]).toEqual(["work::a-1", "work::b-1"]);
	});

	it("round-trips checkbox state and annotations through the index alone", () => {
		const events: GoogleEvent[] = [
			{ id: "a-1", summary: "Standup", start: {}, end: {} },
			{ id: "b-1", summary: "Retro", start: {}, end: {} },
		];
		const first = renderCalendarBlock(calendars, new Map([["work", events]]), "UTC");
		const edited = first
			.replace("- [ ] Standup", "- [x] Standup bring the report")
			.replace("- [ ] Retro", "- [ ] Retro\n  - user-authored detail");

		const preserved = extractPreservedEvents(edited);
		expect(preserved.get("work::a-1")).toMatchObject({
			checked: true,
			inlineAnnotation: "bring the report",
		});
		expect(preserved.get("work::b-1")?.nestedAnnotations).toEqual(["  - user-authored detail"]);

		const second = renderCalendarBlock(
			calendars,
			new Map([["work", events]]),
			"UTC",
			undefined,
			new Set(),
			DEFAULT_SETTINGS.rendering,
			preserved
		);
		expect(eventLines(second)).toBe(
			[
				WORK_HEADING,
				"- [x] Standup bring the report",
				"- [ ] Retro",
				"  - user-authored detail",
			].join("\n")
		);
	});

	it("rescues the checkbox of an edited line by pairing what is left over", () => {
		const events: GoogleEvent[] = [
			{ id: "a-1", summary: "Standup", start: {}, end: {} },
			{ id: "b-1", summary: "Retro", start: {}, end: {} },
		];
		const block = renderCalendarBlock(calendars, new Map([["work", events]]), "UTC");
		const edited = block.replace("- [ ] Retro", "- [x] Weekly retro\n  - ask Dana");

		const preserved = extractPreservedEvents(edited);
		expect(preserved.get("work::a-1")?.checked).toBe(false);
		expect(preserved.get("work::b-1")).toMatchObject({
			checked: true,
			inlineAnnotation: "",
			nestedAnnotations: ["  - ask Dana"],
		});
	});

	it("leaves everything unpaired when an edit is accompanied by a deletion", () => {
		const events: GoogleEvent[] = [
			{ id: "a-1", summary: "Standup", start: {}, end: {} },
			{ id: "b-1", summary: "Retro", start: {}, end: {} },
			{ id: "c-1", summary: "Demo", start: {}, end: {} },
		];
		const block = renderCalendarBlock(calendars, new Map([["work", events]]), "UTC");
		const edited = block.replace("- [ ] Retro\n", "").replace("- [ ] Demo", "- [x] Product demo");

		const preserved = extractPreservedEvents(edited);
		expect(preserved.get("work::a-1")?.checked).toBe(false);
		expect(preserved.has("work::b-1")).toBe(false);
		expect(preserved.has("work::c-1")).toBe(false);
	});

	it("keeps the orphan notice from stacking up on a preserved annotation", () => {
		const event: GoogleEvent = { id: "gone-1", summary: "Retro", start: {}, end: {} };
		const first = renderCalendarBlock(calendars, new Map([["work", [event]]]), "UTC");
		const annotated = first.replace("- [ ] Retro", "- [ ] Retro ask Dana");

		// The event stops coming back, so its annotation is replayed as unmatched.
		let block = renderCalendarBlock(
			calendars,
			new Map(),
			"UTC",
			undefined,
			new Set(),
			DEFAULT_SETTINGS.rendering,
			extractPreservedEvents(annotated)
		);
		const orphaned = block;
		block = renderCalendarBlock(
			calendars,
			new Map(),
			"UTC",
			undefined,
			new Set(),
			DEFAULT_SETTINGS.rendering,
			extractPreservedEvents(block)
		);
		expect(block).toBe(orphaned);
		expect(block.split("Event no longer returned")).toHaveLength(2);
		expect(block).toContain("- [ ] Retro ask Dana");
	});

	it("does not mistake one event's line for a repeated title on another calendar", () => {
		const both = [
			{ id: "x", summary: "Work", enabled: true, addAs: "checkbox" as const },
			{ id: "personal", summary: "Personal", enabled: true, addAs: "checkbox" as const },
		];
		const shared: GoogleEvent[] = [{ id: "dup", summary: "Quarter break", start: {}, end: {} }];
		const block = renderCalendarBlock(
			both,
			new Map([
				["x", shared],
				["personal", shared],
			]),
			"UTC"
		);
		const edited = block.replace("- [ ] Quarter break", "- [x] Quarter break");
		const preserved = extractPreservedEvents(edited);
		expect(preserved.get("x::dup")?.checked).toBe(true);
		expect(preserved.get("personal::dup")?.checked).toBe(false);
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
		expect(block).toContain("- [x] 09:00-09:30 Standup follow up with Alice");
		expect(block).toContain("  - user-authored detail");
		expect(block).toContain(`${encodeEventKey(key)} `);
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
		expect(block).toContain(
			encodeEventKey(multiDayEventKey("work", event.id!))
		);
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

	it("resolves an extensionless core Daily Notes template path containing spaces", async () => {
		const vault = new FakeVault();
		await vault.create("Y - Templates/Daily/DNT - Daily Notes Template.md", "# {{date}}\n\n{calendar}\n");
		const settings = {
			...DEFAULT_SETTINGS,
			templatePath: "Y - Templates/Daily/DNT - Daily Notes Template",
		};

		await ensureDailyNote(vault as never, settings, DATE);

		expect(vault.contentOf("20260722.md")).toContain("# 2026-07-22");
	});

	it("normalizes separators without escaping literal filename punctuation", async () => {
		const vault = new FakeVault();
		const path = "Y - Templates/Daily/DNT #1 [Main]'s Template.md";
		await vault.create(path, "{calendar}");

		const resolved = templateFileFor(
			vault as never,
			"  Y - Templates\\Daily\\DNT #1 [Main]'s Template  "
		);

		expect(resolved?.path).toBe(path);
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
