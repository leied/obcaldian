# Plan: Multi-day event handling

Status: implemented with the persisted-rule extension described below. Written 2026-07-22;
implemented 2026-08-30.

## Implemented policy options and unsynced dates

The settings UI now offers `independent`, `ask`, and `following` policies. The original plan only
resolved checkbox state for notes inside one sync run, which would lose the decision for a date
outside that range. The implementation therefore persists accepted/automatic propagation as an
event-keyed `{ completedFrom, eventEnd }` rule in plugin settings. A later occurrence renders
checked when that date is eventually synced; the plugin does not eagerly create out-of-range notes.
Rules expire 30 days after the event end and can be cleared from settings. Background sync never
prompts and never creates a new rule in `ask` mode.

## Scope decisions (confirmed with user)

- Checkbox-state preservation targets **multi-day events only** — single-day events are left
  as-is for now (they get fully regenerated on every sync, same as today).
- Multi-day events render on **every day they span**, annotated (e.g. `(Day 2/3)`) — not
  collapsed to a single line on the start day.
- The user chooses independent dates, an interactive prompt, or automatic forward propagation.
- Propagation starts on the earliest checked occurrence and affects following dates only; earlier
  dates are never retroactively completed.

## 1. Detecting a multi-day event

The pure helper is implemented in `multiDay.ts`:

```ts
function multiDaySpan(ev: GoogleEvent, timezone: string): MultiDaySpan | null
```

- All-day events: `start.date`/`end.date` are present; Google's `end.date` is exclusive, so
  `totalDays = end.date - start.date` (in days). Multi-day when `totalDays > 1`.
- Timed events: compare the *local calendar date* (in `settings.timezone`) of `start.dateTime` with
  the instant 1ms before `end.dateTime`. The subtraction prevents an exact-midnight end from
  incorrectly claiming the next day.
- Returns `null` for anything single-day — recurring daily events are naturally excluded since
  each instance's own start/end still spans one day.

## 2. Event identity

`GoogleEvent` includes Google's event-instance `id`. This ID is what lets the plugin recognize "this is the same
multi-day event" across different daily notes and across sync runs (a single non-recurring event
keeps one stable `id` no matter which day's window returns it).

The internal key also includes the calendar ID so the same shared event shown through two enabled
calendars does not accidentally share checkbox state.

## 3. Rendering changes

For a multi-day event, `renderCalendarBlock` renders it on every day it spans, annotated, e.g.:

```
- [ ] [Conference](link) (Day 2/3) <!-- dailycalsync:event:abc123 -->
```

The trailing HTML comment is invisible in Obsidian's reading view but present in the raw
markdown — it's how a future sync re-identifies "this line is event `abc123`" to read back its
checked state. Single-day events get no such marker (keeps the "multi-day only" scope — their
lines are byte-identical to today).

## 4. Sync flow restructuring (the real change)

`syncRange` now uses a pre-pass before any writes happen:

1. **Fetch phase:** gather every requested day/calendar. Any network failure aborts before writes.
2. **Group phase:** collect events into multi-day groups by `id`, computing which of the
   days-in-range each group touches.
3. **Scan phase:** for each multi-day group, read the *existing* content (if any) of every
   day in the event's full span—not just the requested range—and check whether its line (matched via the
   `<!-- dailycalsync:event:<id> -->` comment) is currently `- [x]`.
4. **Decide phase:** apply the selected policy:
   - `independent` → preserve only the dates already checked.
   - `ask` + interactive sync → ask whether to mark the earliest checked date and following dates
     done. Yes persists a rule; No preserves only existing states and asks again next manual sync.
   - `ask` + background sync → preserve existing states without prompting or creating a rule.
   - `following` → automatically persist a forward-propagation rule.
5. **Render + write phase:** proceed per-day as today, but feed each multi-day line's resolved
   checked state into `renderCalendarBlock`.

## 5. Avoiding repeat prompts

Before prompting, the implementation checks whether every date from the earliest checked day to
the end is already checked. If so, there is nothing to propagate. Once accepted, the persisted rule
prevents repeat prompts and covers dates beyond the current sync range.

## 6. New/changed files

- `src/googleCalendar.ts` — add `id` to `GoogleEvent`.
- `src/multiDay.ts` — span calculation, day-index helpers, invisible marker identity, and pure
  checkbox-state scanning.
- `src/dailyNote.ts` — day-index and resolved checkbox rendering.
- `src/multiDayCompletionModal.ts` — small `Modal` (same shape as `syncDaysModal.ts`), returns
  `Promise<boolean>`.
- `src/sync.ts` — restructure `syncNoteForDate`/`syncRange` into the group → scan → decide →
  render pipeline above; thread the modal call in only for `notify: true` paths.

## 7. Testing

The scan/decide logic is pure (string in, decisions out) so it's unit-testable per the project's
existing pattern (`dailyNote.test.ts`) without touching the untested Modal/network code — cases:
no prior state, one day checked, all days checked (no prompt needed), conflicting partial state,
range not covering full event span.

## Remaining limitation

An active persisted rule intentionally wins on the next sync, including over a manually unchecked
later occurrence. To undo remembered propagation, use the Clear control in settings (or switch to
independent mode, which clears all rules). A future per-event reset action could make this finer-grained.
