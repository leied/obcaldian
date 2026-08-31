# Plan: Multi-day event handling

Status: proposed, not yet implemented. Written 2026-07-22.

## Scope decisions (confirmed with user)

- Checkbox-state preservation targets **multi-day events only** — single-day events are left
  as-is for now (they get fully regenerated on every sync, same as today).
- Multi-day events render on **every day they span**, annotated (e.g. `(Day 2/3)`) — not
  collapsed to a single line on the start day.
- When a multi-day event's checkbox is checked on one day, sync **always prompts** (interactive
  syncs only — see below) asking whether to mark it done across all the days it spans.

## 1. Detecting a multi-day event

New helper in `dailyNote.ts` (or a new `multiDayEvent.ts`), pure and testable:

```ts
function multiDaySpan(ev: GoogleEvent, timezone: string): { startDate: Moment; endDate: Moment; totalDays: number } | null
```

- All-day events: `start.date`/`end.date` are present; Google's `end.date` is exclusive, so
  `totalDays = end.date - start.date` (in days). Multi-day when `totalDays > 1`.
- Timed events: compare the *local calendar date* (in `settings.timezone`) of `start.dateTime` vs
  `end.dateTime`. Different dates → multi-day (covers rare overnight events).
- Returns `null` for anything single-day — recurring daily events are naturally excluded since
  each instance's own start/end still spans one day.

## 2. Event identity

`GoogleEvent` (`googleCalendar.ts:17`) needs an `id: string` field — Google already returns it,
it's just not typed/used today. This `id` is what lets the plugin recognize "this is the same
multi-day event" across different daily notes and across sync runs (a single non-recurring event
keeps one stable `id` no matter which day's window returns it).

## 3. Rendering changes

For a multi-day event, `renderCalendarBlock` renders it on every day it spans, annotated, e.g.:

```
- [ ] [Conference](link) (Day 2/3) <!-- obcaldian:event:abc123 -->
```

The trailing HTML comment is invisible in Obsidian's reading view but present in the raw
markdown — it's how a future sync re-identifies "this line is event `abc123`" to read back its
checked state. Single-day events get no such marker (keeps the "multi-day only" scope — their
lines are byte-identical to today).

## 4. Sync flow restructuring (the real change)

Today, `syncRange` (`sync.ts:52`) syncs one day at a time, independently, immediately overwriting
each note's marker block. That can't support "check on Day 2 → propagate to Days 1/3," so
multi-day handling needs a pre-pass before any writes happen:

1. **Fetch phase (unchanged shape):** gather events per day/calendar as today.
2. **Group phase:** collect events into multi-day groups by `id`, computing which of the
   days-in-range each group touches.
3. **Scan phase:** for each multi-day group, read the *existing* content (if any) of every
   touched day's note and check whether its rendered line (matched via the
   `<!-- obcaldian:event:<id> -->` comment) is currently `- [x]`.
4. **Decide phase:** if any day is checked and the group hasn't been resolved yet this run:
   - **Interactive syncs only** (`notify: true` — manual "Sync now" / "Sync next N days"): show a
     confirmation Modal, *"Mark '\<title\>' done on all 3 days?"* Yes/No.
   - **Silent syncs** (`autoSyncTick`, `notify: false`): never block on a Modal with no one
     watching — auto-preserve whatever's already checked, don't propagate, don't ask.
   - Yes → every day-instance of that event renders checked this run.
   - No → only the day(s) already checked stay checked; others render fresh/unchecked.
5. **Render + write phase:** proceed per-day as today, but feed each multi-day line's resolved
   checked state into `renderCalendarBlock`.

## 5. Avoiding repeat prompts

Before prompting, check whether the group is already "fully resolved" — i.e., every existing
touched-day note already shows the same checked state. If so, skip the modal and just keep
re-emitting that state. Only prompt when the existing notes disagree (some checked, some not) and
no decision has been recorded yet this run. If a sync's date range doesn't cover the whole event
(e.g. `daysAhead` cuts off before the event ends), later days get resolved/prompted when a future
sync reaches them.

## 6. New/changed files

- `src/googleCalendar.ts` — add `id` to `GoogleEvent`.
- `src/dailyNote.ts` — multi-day detection helper, day-index rendering, invisible id-comment
  marker, and a pure `scanExistingCheckedState(content, eventIds)` function (unit-testable, no
  Obsidian Modal dependency).
- `src/multiDayConfirmModal.ts` — new, small `Modal` (same shape as `syncDaysModal.ts`), returns
  `Promise<boolean>`.
- `src/sync.ts` — restructure `syncNoteForDate`/`syncRange` into the group → scan → decide →
  render pipeline above; thread the modal call in only for `notify: true` paths.

## 7. Testing

The scan/decide logic is pure (string in, decisions out) so it's unit-testable per the project's
existing pattern (`dailyNote.test.ts`) without touching the untested Modal/network code — cases:
no prior state, one day checked, all days checked (no prompt needed), conflicting partial state,
range not covering full event span.

## Open questions for next time

- Exact modal wording/UX.
- Whether "No" should preserve just the single day that was checked, or reset everything back to
  unchecked.
