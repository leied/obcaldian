import { Notice, TFile, Vault, normalizePath } from "obsidian";
import type { Moment } from "moment";
import {
	DEFAULT_RENDERING_SETTINGS,
	type CalendarConfig,
	type DailyCalSyncSettings,
	type RenderingSettings,
} from "./settings";
import type { GoogleEvent } from "./googleCalendar";
import {
	dayNumberInSpan,
	decodeEventKey,
	encodeEventKey,
	eventKeyFromMarkerLine,
	eventOccurrenceKey,
	multiDaySpan,
} from "./multiDay";

const CALENDAR_TOKEN = "{calendar}";
export const MARKER_START = "<!-- dailycalsync:calendar:start -->";
export const MARKER_END = "<!-- dailycalsync:calendar:end -->";
const LEGACY_MARKER_START = "<!-- obcaldian:calendar:start -->";
const LEGACY_MARKER_END = "<!-- obcaldian:calendar:end -->";
const PLACEHOLDER_BODY = "_(not yet synced — click \"Sync now\" in DailyCalSync settings)_";

export interface EnsuredDailyNote {
	file: TFile;
	created: boolean;
}

export interface PreservedEventState {
	checked: boolean;
	inlineAnnotation: string;
	nestedAnnotations: string[];
	originalLine: string;
}

function markerBlock(body: string): string {
	return `${MARKER_START}\n${body}\n${MARKER_END}`;
}

export function fileNameFor(date: Moment, format = "YYYYMMDD"): string {
	return `${date.format(format)}.md`;
}

export function notePathFor(settings: DailyCalSyncSettings, date: Moment): string {
	const folder = settings.dailyNoteFolder?.trim();
	const fileName = fileNameFor(date, settings.dailyNoteFormat);
	return normalizePath(folder ? `${folder}/${fileName}` : fileName);
}

/** Resolves both full vault paths and the extensionless paths used by Obsidian's core Daily Notes plugin. */
export function templateFileFor(vault: Vault, configuredPath: string): TFile | null {
	const normalized = normalizePath(configuredPath.trim());
	if (!normalized) return null;
	for (const candidate of [normalized, normalized.toLowerCase().endsWith(".md") ? null : `${normalized}.md`]) {
		if (!candidate) continue;
		const file = vault.getAbstractFileByPath(candidate);
		if (file instanceof TFile) return file;
	}
	return null;
}

/**
 * Creates the daily note from the user's template if it doesn't already
 * exist. Never rewrites an existing note's body.
 */
export async function ensureDailyNote(
	vault: Vault,
	settings: DailyCalSyncSettings,
	date: Moment
): Promise<TFile> {
	const path = notePathFor(settings, date);
	const existing = vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		return existing;
	}

	const rendered = await renderNewDailyNoteContent(vault, settings, date);

	const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	if (parentPath && !vault.getAbstractFileByPath(normalizePath(parentPath))) {
		await vault.createFolder(normalizePath(parentPath));
	}

	return vault.create(path, rendered);
}

export async function renderNewDailyNoteContent(
	vault: Vault,
	settings: DailyCalSyncSettings,
	date: Moment
): Promise<string> {
	if (!settings.templatePath) throw new Error("Set a template file in DailyCalSync settings first.");
	const templateFile = templateFileFor(vault, settings.templatePath);
	if (!templateFile) throw new Error(`Template file not found: ${settings.templatePath}. Choose an existing Markdown file in your vault.`);
	const templateContent = await vault.read(templateFile);
	if (!templateContent.includes(CALENDAR_TOKEN)) {
		throw new Error(
			`Your template is missing ${CALENDAR_TOKEN}. Add it where the synced calendar should appear; no note was created.`
		);
	}
	return templateContent
		.replace(/\{\{date\}\}/g, date.format("YYYY-MM-DD"))
		.replace(CALENDAR_TOKEN, markerBlock(PLACEHOLDER_BODY));
}

/** Explicit creation result for callers that need to distinguish an existing note safely. */
export async function ensureDailyNoteResult(
	vault: Vault,
	settings: DailyCalSyncSettings,
	date: Moment
): Promise<EnsuredDailyNote> {
	const path = notePathFor(settings, date);
	const existing = vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) return { file: existing, created: false };
	return { file: await ensureDailyNote(vault, settings, date), created: true };
}

export function calendarSectionFromContent(content: string): string | null {
	const range = markerRange(content);
	if (!range) return null;
	return content.slice(range.bodyStart, range.endIndex).replace(/^\n|\n$/g, "");
}

export function replaceCalendarSectionContent(content: string, renderedBlock: string): string | null {
	const range = markerRange(content);
	if (!range) return null;
	const before = content.slice(0, range.startIndex);
	const after = content.slice(range.endIndex + range.endMarker.length);
	return `${before}${markerBlock(renderedBlock)}${after}`;
}

function markerRange(content: string): {
	startIndex: number;
	bodyStart: number;
	endIndex: number;
	endMarker: string;
} | null {
	for (const [startMarker, endMarker] of [
		[MARKER_START, MARKER_END],
		[LEGACY_MARKER_START, LEGACY_MARKER_END],
	] as const) {
		const startIndex = content.indexOf(startMarker);
		const endIndex = startIndex === -1 ? -1 : content.indexOf(endMarker, startIndex + startMarker.length);
		if (startIndex !== -1 && endIndex !== -1) {
			return { startIndex, bodyStart: startIndex + startMarker.length, endIndex, endMarker };
		}
	}
	return null;
}

const INDEX_OPEN = "<!-- dailycalsync:index";
const INDEX_CLOSE = "-->";
const LIST_PREFIX = /^\s*- (?:\[[ xX]\] )?/;
const ORPHAN_NOTE = "  > Event no longer returned by Google; annotation preserved.";

interface EventIndexEntry {
	key: string;
	/** How many characters of the line, after its list prefix, this plugin wrote. */
	length: number;
	digest: string;
}

interface EventIndex {
	entries: EventIndexEntry[];
	/** Line numbers occupied by the index block itself, which carry no note content. */
	blockLines: Set<number>;
}

function fnv1a(text: string): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(36);
}

/**
 * The index records identity for every rendered event in one comment at the end
 * of the block, so no event line has to carry a marker of its own. Each row is
 * `<encoded key> <generated length> <digest>`: the length says where this
 * plugin's text stops and a user's inline annotation begins, and the digest
 * confirms the line really is that event before its state is reused.
 */
function renderEventIndex(entries: EventIndexEntry[]): string {
	const rows = entries.map((entry) => `${encodeEventKey(entry.key)} ${entry.length} ${entry.digest}`);
	return [INDEX_OPEN, ...rows, INDEX_CLOSE].join("\n");
}

function parseEventIndex(lines: string[]): EventIndex {
	const entries: EventIndexEntry[] = [];
	const blockLines = new Set<number>();
	const openIndex = lines.findIndex((line) => line.trimStart().startsWith(INDEX_OPEN));
	if (openIndex === -1) return { entries, blockLines };
	for (let index = openIndex; index < lines.length; index += 1) {
		blockLines.add(index);
		const line = lines[index].trim();
		if (index === openIndex) continue;
		// A missing close means the note was mangled; stop at the blank line that
		// always precedes the index rather than swallowing the rest of the block.
		if (line === INDEX_CLOSE || line === "") break;
		const [encodedKey, rawLength, digest] = line.split(" ");
		const key = encodedKey ? decodeEventKey(encodedKey) : null;
		const length = Number(rawLength);
		if (!key || !digest || !Number.isInteger(length) || length < 0) continue;
		entries.push({ key, length, digest });
	}
	return { entries, blockLines };
}

/**
 * Finds the longest indexed entry whose digest matches the head of this line,
 * ignoring entries already claimed by an earlier line so repeated events (the
 * same meeting shared across two calendars) resolve in render order.
 */
function matchIndexedLine(
	body: string,
	entries: EventIndexEntry[],
	claimed: Set<EventIndexEntry>
): EventIndexEntry | null {
	let best: EventIndexEntry | null = null;
	for (const entry of entries) {
		if (claimed.has(entry) || entry.length > body.length) continue;
		if (fnv1a(body.slice(0, entry.length)) !== entry.digest) continue;
		if (!best || entry.length > best.length) best = entry;
	}
	return best;
}

/** Indented lines directly below an event line are the user's own notes on it. */
function collectNestedAnnotations(
	lines: string[],
	start: number,
	blockLines: Set<number>
): { nestedAnnotations: string[]; lastLine: number } {
	const nestedAnnotations: string[] = [];
	let lastLine = start;
	for (let next = start + 1; next < lines.length; next += 1) {
		const candidate = lines[next];
		if (blockLines.has(next)) break;
		if (!/^(?: {2,}|\t)\S/.test(candidate) || /^\s*\[\^/.test(candidate)) break;
		lastLine = next;
		// The orphan notice is this plugin's own text; re-capturing it would stack
		// another copy onto the line at every sync.
		if (candidate === ORPHAN_NOTE) continue;
		nestedAnnotations.push(candidate);
	}
	return { nestedAnnotations, lastLine };
}

/** Reads checkbox state and explicitly attached inline/indented user annotations. */
export function extractPreservedEvents(content: string): Map<string, PreservedEventState> {
	const section = calendarSectionFromContent(content) ?? content;
	const lines = section.split("\n");
	const { entries, blockLines } = parseEventIndex(lines);
	const claimed = new Set<EventIndexEntry>();
	const preserved = new Map<string, PreservedEventState>();
	const unidentified: Array<{ line: string; nestedAnnotations: string[] }> = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (blockLines.has(index)) continue;
		const line = lines[index];
		const legacyKey = eventKeyFromMarkerLine(line);
		const prefix = line.match(LIST_PREFIX);
		if (!legacyKey && !prefix) continue;
		const { nestedAnnotations, lastLine } = collectNestedAnnotations(lines, index, blockLines);
		index = lastLine;
		const state = (eventKey: string, inlineAnnotation: string): void => {
			preserved.set(eventKey, {
				checked: /^\s*- \[[xX]\]/.test(line),
				inlineAnnotation,
				nestedAnnotations,
				originalLine: line,
			});
		};
		if (legacyKey) {
			// Notes written before the index carry a marker on the event line itself.
			const markerStart = line.search(/<!-- (?:dailycalsync|obcaldian):event:/);
			const markerEnd = markerStart === -1 ? -1 : line.indexOf(" -->", markerStart);
			state(legacyKey, markerEnd === -1 ? "" : line.slice(markerEnd + 4).trim());
			continue;
		}
		const body = line.slice(prefix![0].length);
		const entry = matchIndexedLine(body, entries, claimed);
		if (entry) {
			claimed.add(entry);
			state(entry.key, body.slice(entry.length).trim());
		} else {
			unidentified.push({ line, nestedAnnotations });
		}
	}
	// Editing an event's own text breaks its digest. When exactly as many lines
	// went unrecognized as entries went unclaimed, order still pairs them, which
	// rescues the checkbox and any sub-notes; the edited line's own text is not
	// preserved, since there is no longer a boundary between it and this
	// plugin's. Mismatched counts stay unpaired rather than risk misattribution.
	const unclaimed = entries.filter((entry) => !claimed.has(entry));
	if (unclaimed.length > 0 && unclaimed.length === unidentified.length) {
		unclaimed.forEach((entry, position) => {
			const { line, nestedAnnotations } = unidentified[position];
			preserved.set(entry.key, {
				checked: /^\s*- \[[xX]\]/.test(line),
				inlineAnnotation: "",
				nestedAnnotations,
				originalLine: line,
			});
		});
	}
	return preserved;
}

/** Whether the note shows this event as done, reading either identity scheme. */
export function eventIsCheckedInNote(content: string, eventKey: string): boolean {
	return Boolean(extractPreservedEvents(content).get(eventKey)?.checked);
}

const FOOTNOTE_CONTINUATION_INDENT = "    ";
const MIN_ATTENDEES_TO_LIST = 3;

function safeInlineText(value: string): string {
	return value
		.replace(/\r?\n/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\\/g, "\\\\")
		.replace(/([`*_{}[\]()#+!|<>])/g, "\\$1");
}

function safeMultilineText(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => safeInlineText(line))
		.filter(Boolean)
		.join(`\n${FOOTNOTE_CONTINUATION_INDENT}`);
}

const HTML_NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: "\"",
	apos: "'",
	nbsp: " ",
};

function decodeHtmlEntities(value: string): string {
	return value.replace(
		/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
		(match, reference: string) => {
			if (!reference.startsWith("#")) {
				return HTML_NAMED_ENTITIES[reference.toLowerCase()] ?? match;
			}
			const hex = reference[1] === "x" || reference[1] === "X";
			const codePoint = Number.parseInt(reference.slice(hex ? 2 : 1), hex ? 16 : 10);
			if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10_ff_ff) return match;
			try {
				return String.fromCodePoint(codePoint);
			} catch {
				return match;
			}
		}
	);
}

/**
 * Google's descriptions are HTML, and iCalendar feeds routinely smuggle tags
 * into nominally plain-text ones, so both arrive littered with `<br>` that
 * Markdown escaping would otherwise render literally. Block-ish tags become
 * line breaks, the rest are dropped, and entities decode last so a decoded "<"
 * is never mistaken for the start of a tag.
 */
function htmlToPlainText(value: string): string {
	const withBreaks = value
		.replace(/<\s*br\s*\/?\s*>/gi, "\n")
		.replace(/<\s*li\b[^>]*>/gi, "\n")
		.replace(/<\s*\/\s*(?:p|div|li|tr|h[1-6]|blockquote|ul|ol)\s*>/gi, "\n")
		.replace(/<\s*\/?\s*[a-zA-Z][^>]*>/g, "");
	return decodeHtmlEntities(withBreaks);
}

function safeGoogleEventUrl(rawUrl: string | undefined): string | null {
	if (!rawUrl) return null;
	try {
		const url = new URL(rawUrl);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			!["calendar.google.com", "www.google.com"].includes(url.hostname)
		) {
			return null;
		}
		return url.toString();
	} catch {
		return null;
	}
}

function safeMeetingUrl(rawUrl: string | undefined): string | null {
	if (!rawUrl) return null;
	try {
		const url = new URL(rawUrl);
		return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
	} catch {
		return null;
	}
}

function calendarClass(calendarId: string): string {
	return `dailycalsync-calendar-${fnv1a(calendarId)}`;
}

export function eventIsIncluded(event: GoogleEvent, rendering: RenderingSettings): boolean {
	if (event.status === "cancelled" && !rendering.includeCancelled) return false;
	if (event.transparency === "transparent" && !rendering.includeFreeEvents) return false;
	if (
		!rendering.includeDeclined &&
		event.attendees?.some(
			(attendee) => attendee.self && attendee.responseStatus === "declined"
		)
	) {
		return false;
	}
	const enabledEventTypes: Record<string, boolean> = {
		focusTime: rendering.includeFocusTime,
		outOfOffice: rendering.includeOutOfOffice,
		workingLocation: rendering.includeWorkingLocation,
		birthday: rendering.includeBirthdays,
	};
	return event.eventType === undefined || enabledEventTypes[event.eventType] !== false;
}

/**
 * Builds a footnote's body for an event: its description (if any), plus a
 * participant list when there are enough attendees to be worth naming. Lines
 * after the first are indented so markdown treats them as part of the same
 * footnote definition. Returns null when there's nothing worth footnoting.
 */
function footnoteBody(ev: GoogleEvent, rendering: RenderingSettings): string | null {
	const parts: string[] = [];
	const description = ev.description?.trim();
	if (description && rendering.showDescriptions) {
		const text = safeMultilineText(htmlToPlainText(description));
		if (text) parts.push(text);
	}
	const location = ev.location?.trim();
	if (location && rendering.showLocations) {
		const text = safeInlineText(htmlToPlainText(location));
		if (text) parts.push(`**Location:** ${text}`);
	}
	const meetingUrl = rendering.showMeetingLinks ? safeMeetingUrl(ev.hangoutLink) : null;
	if (meetingUrl) parts.push(`**Meeting:** ${meetingUrl}`);

	const attendees = ev.attendees ?? [];
	if (rendering.showAttendees && attendees.length >= MIN_ATTENDEES_TO_LIST) {
		const names = attendees
			.map((attendee) => {
				const displayName = attendee.displayName?.trim();
				if (displayName) return safeInlineText(displayName);
				return rendering.includeAttendeeEmails ? safeInlineText(attendee.email) : "Attendee";
			})
			.join(", ");
		parts.push(`**Participants:** ${names}`);
	}

	if (parts.length === 0) return null;
	return parts.join(`\n${FOOTNOTE_CONTINUATION_INDENT}`);
}

/** Formats a timed event's start (and end, if distinct) as "HH:mm" or "HH:mm-HH:mm". Null for all-day events. */
function formatTime(
	dateTime: string,
	timeZone: string,
	rendering: RenderingSettings
): string {
	const locale = rendering.locale === "system" ? undefined : rendering.locale;
	const options: Intl.DateTimeFormatOptions = {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		...(rendering.hourCycle === "12" ? { hour12: true } : {}),
		...(rendering.hourCycle === "24" ? { hourCycle: "h23" as const } : {}),
	};
	try {
		return new Intl.DateTimeFormat(locale, options).format(new Date(dateTime));
	} catch {
		return new Intl.DateTimeFormat(undefined, options).format(new Date(dateTime));
	}
}

function formatTimeRange(
	ev: GoogleEvent,
	timeZone: string,
	rendering: RenderingSettings
): string | null {
	if (!ev.start.dateTime) return null;
	const start = formatTime(ev.start.dateTime, timeZone, rendering);
	const end =
		rendering.showEndTime && ev.end.dateTime
			? formatTime(ev.end.dateTime, timeZone, rendering)
			: null;
	const separator = safeInlineText(rendering.timeSeparator) || "-";
	return end && end !== start ? `${start}${separator}${end}` : start;
}

export function renderCalendarBlock(
	calendars: CalendarConfig[],
	eventsByCalendar: Map<string, GoogleEvent[]>,
	timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
	renderDate?: string,
	checkedEventKeys: ReadonlySet<string> = new Set(),
	rendering: RenderingSettings = DEFAULT_RENDERING_SETTINGS,
	preservedEvents: ReadonlyMap<string, PreservedEventState> = new Map(),
	suppressOrphanKeys: ReadonlySet<string> = new Set()
): string {
	const lines: string[] = [];
	const footnotes: string[] = [];
	const indexEntries: EventIndexEntry[] = [];
	const renderedEventKeys = new Set<string>();
	let footnoteCount = 0;

	for (const cal of calendars) {
		if (!cal.enabled) continue;
		const events = (eventsByCalendar.get(cal.id) ?? [])
			.filter((event) => eventIsIncluded(event, rendering))
			.sort((left, right) => {
				if (rendering.allDayFirst) {
					const allDayOrder = Number(Boolean(right.start.date)) - Number(Boolean(left.start.date));
					if (allDayOrder) return allDayOrder;
				}
				return (left.start.dateTime ?? left.start.date ?? "").localeCompare(
					right.start.dateTime ?? right.start.date ?? ""
				);
			});
		if (events.length === 0) continue;
		const dotClasses = ["dailycalsync-calendar-label", calendarClass(cal.id)];
		if (rendering.useGoogleCalendarColors && cal.colorId && /^\d{1,2}$/.test(cal.colorId)) {
			dotClasses.push(`dailycalsync-calendar-color-${cal.colorId}`);
		}
		// A blank line ends the previous calendar's list; without it Markdown folds
		// this heading (and everything under it) into that list as a continuation.
		if (lines.length > 0) lines.push("");
		lines.push(
			`<span class="dailycalsync-calendar-heading"><span class="${dotClasses.join(" ")}"></span>**${safeInlineText(cal.summary)}**</span>`
		);
		for (const ev of events) {
			const span = multiDaySpan(ev, timeZone);
			const eventKey = eventOccurrenceKey(cal.id, ev);
			const previous = eventKey ? preservedEvents.get(eventKey) : undefined;
			const checked = eventKey
				? checkedEventKeys.has(eventKey) || Boolean(previous?.checked)
				: false;
			const bullet = cal.addAs === "checkbox" ? (checked ? "- [x]" : "- [ ]") : "-";
			const time = formatTimeRange(ev, timeZone, rendering);
			const isPrivate = ev.visibility === "private" || ev.visibility === "confidential";
			const rawTitle =
				rendering.redactPrivateEvents && isPrivate
					? "Busy"
					: ev.summary || "(untitled event)";
			const safeTitle = safeInlineText(rawTitle);
			const htmlLink = safeGoogleEventUrl(ev.htmlLink);
			const title = htmlLink ? `[${safeTitle}](${htmlLink})` : safeTitle;
			const dayNumber = span && renderDate ? dayNumberInSpan(renderDate, span) : null;
			const dayLabel = dayNumber ? ` (Day ${dayNumber}/${span?.totalDays})` : "";

			let footnoteMarker = "";
			const body = rendering.redactPrivateEvents && isPrivate ? null : footnoteBody(ev, rendering);
			if (body) {
				footnoteCount += 1;
				footnoteMarker = `[^dailycalsync-${footnoteCount}]`;
				footnotes.push(`[^dailycalsync-${footnoteCount}]: ${body}`);
			}

			const annotation = previous?.inlineAnnotation
				? ` ${previous.inlineAnnotation}`
				: "";
			const generated = `${time ? `${time} ` : ""}${title}${dayLabel}${footnoteMarker}`;
			lines.push(`${bullet} ${generated}${annotation}`);
			if (previous?.nestedAnnotations.length) lines.push(...previous.nestedAnnotations);
			if (eventKey) {
				renderedEventKeys.add(eventKey);
				indexEntries.push({ key: eventKey, length: generated.length, digest: fnv1a(generated) });
			}
		}
	}
	const orphanedAnnotations = [...preservedEvents.entries()].filter(
		([eventKey, state]) =>
			!renderedEventKeys.has(eventKey) &&
			!suppressOrphanKeys.has(eventKey) &&
			(Boolean(state.inlineAnnotation) || state.nestedAnnotations.length > 0)
	);
	if (orphanedAnnotations.length > 0) {
		lines.push("", "**Unmatched calendar annotations**");
		for (const [eventKey, state] of orphanedAnnotations) {
			lines.push(state.originalLine, ...state.nestedAnnotations, ORPHAN_NOTE);
			// A replayed line keeps whatever split it already had, so the annotation
			// that made it an orphan is still read back as one on the next sync. A
			// line from an older note identifies itself by its own marker and must
			// not also be indexed, or the leftover entry could pair with some other
			// unrecognized line.
			if (eventKeyFromMarkerLine(state.originalLine)) continue;
			const body = state.originalLine.replace(LIST_PREFIX, "");
			const generatedLength = body.endsWith(state.inlineAnnotation)
				? body.length - state.inlineAnnotation.length
				: body.length;
			indexEntries.push({
				key: eventKey,
				length: generatedLength,
				digest: fnv1a(body.slice(0, generatedLength)),
			});
		}
	}
	if (lines.length === 0) {
		return "_(no events)_";
	}
	const blocks = [lines.join("\n")];
	if (footnotes.length > 0) blocks.push(footnotes.join("\n"));
	// Last, and only once: the identity index every event line would otherwise
	// have to carry inline, where Obsidian puts it in the reader's way.
	if (indexEntries.length > 0) blocks.push(renderEventIndex(indexEntries));
	return blocks.join("\n\n");
}

/**
 * Replaces only the content between the calendar markers, leaving the rest
 * of the note untouched. Skips (with a Notice) if markers aren't present.
 */
export async function syncNoteCalendarSection(
	vault: Vault,
	file: TFile,
	renderedBlock: string,
	notify = true
): Promise<boolean> {
	const content = await vault.read(file);
	const next = replaceCalendarSectionContent(content, renderedBlock);
	if (next === null) {
		if (notify) {
			new Notice(`DailyCalSync: calendar markers not found in ${file.path}, skipping.`);
		}
		return false;
	}
	await vault.modify(file, next);
	return true;
}
