# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Obcaldian is an Obsidian plugin (desktop-only). It generates daily notes from a user-provided
template and keeps a plugin-managed section of those notes in sync with selected Google
Calendars. `main.js` is a bundled build artifact (esbuild output with a generated-file banner) —
never edit it directly; edit `src/*.ts`.

## Commands

- `npm run dev` — esbuild in watch mode, unminified with inline sourcemaps (writes `main.js`).
- `npm run build` — type-checks with `tsc -noEmit -skipLibCheck`, then produces a minified
  production `main.js` via esbuild.
- `npm test` — runs the vitest suite in `tests/`.
- `npm version <patch|minor|major>` — bumps `package.json`, then runs `version-bump.mjs`, which
  syncs `manifest.json`'s `version` and appends an entry to `versions.json` keyed by
  `minAppVersion`. Also stages `manifest.json`/`versions.json`.

There is no lint config. `npm run build` (`tsc -noEmit`) and `npm test` are both run in CI
(`.github/workflows/ci.yml`) on every push/PR to `main`. Pushing any tag triggers
`.github/workflows/release.yml`, which builds, tests, and publishes a GitHub Release with
`main.js`, `manifest.json`, `styles.css` attached (plus a zipped copy) via `gh release create`.

To manually exercise the plugin, symlink or copy this repo (built) into an Obsidian vault's
`.obsidian/plugins/obcaldian/` folder and enable it in Obsidian's Community Plugins settings.

### Tests

`tests/` is excluded from `tsconfig.json`'s project (`npm run build`'s `tsc -noEmit` never
type-checks it) so test fakes don't need to satisfy Obsidian's full interfaces exactly. The real
`obsidian` npm package ships types only, no runtime — `vitest.config.ts` aliases `"obsidian"` to
`tests/mocks/obsidian.ts`, a minimal runtime stand-in (`TFile`, `Notice`, `SecretStorage`,
`normalizePath`, a stub `requestUrl` that throws if actually called). `tests/setup.ts` pins
`process.env.TZ = "UTC"` and stubs `window.moment` — both `dailyNote.ts`'s time formatting and any
test fixture dates would otherwise depend on the machine's local timezone. `tests/fakeVault.ts` is
an in-memory `Vault` fake used by `dailyNote.test.ts`. Network-calling functions
(`connectGoogleAccount`, `listCalendars`, etc.) aren't unit tested — coverage focuses on the pure
logic (`timezone.ts`, `dailyNote.ts`'s rendering/marker logic, `googleAuth.ts`'s secret-storage
helpers and migration).

## Architecture

Module responsibilities in `src/`, in dependency order:

- **`settings.ts`** — pure types (`ObcaldianSettings`, `CalendarConfig`) and `DEFAULT_SETTINGS`.
  `timezone` defaults to the system's IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`)
  but is user-overridable. Notably absent: the Google client secret and OAuth tokens — those live in
  Obsidian's secret storage, not here (see `googleAuth.ts`), since this object is persisted to
  plugin `data.json` in plain text. Only the non-secret `tokenExpiresAt` timestamp stays here.
- **`googleAuth.ts`** — the Google OAuth "installed app" loopback flow: opens the system browser,
  spins up a local `http` server on `127.0.0.1:42813` to catch the redirect, exchanges the code for
  tokens, and refreshes access tokens on expiry (`getValidAccessToken`). Requires Node's `http`
  module directly (via `require`), which is why `manifest.json` sets `isDesktopOnly: true`. All
  auth-dependent functions take an `AuthDeps` (`{ settings, saveSettings, secretStorage }`) rather
  than the plugin instance, keeping this module decoupled from `main.ts`.
  - Client secret and access/refresh tokens are stored via `App.secretStorage` (Obsidian API
    `1.11.4+` — `setSecret`/`getSecret`/`listSecrets`, ids must be lowercase-alphanumeric-with-dashes,
    e.g. `obcaldian-google-refresh-token`). There is no delete API; "disconnect" overwrites with an
    empty string. `isConnected(deps)` is the source of truth for connected-state (a recorded
    `tokenExpiresAt` *and* a present refresh-token secret), replacing the old `settings.tokens`
    check.
  - `migrateLegacySecrets` is a one-time migration (called from `main.ts`'s `loadSettings`) that
    lifts a pre-secret-storage `data.json`'s plaintext `googleClientSecret`/`tokens.{accessToken,
    refreshToken,expiresAt}` into secret storage and strips them from the saved settings object.
- **`timezone.ts`** — pure, no Obsidian dependency. `zonedDayRange(year, month, day, timeZone)`
  resolves the UTC instants for midnight-to-midnight of a given calendar day in an arbitrary IANA
  zone, via `Intl.DateTimeFormat` offset reconstruction (no `moment-timezone` dependency). Used so
  Google Calendar day-boundary queries align with the user's configured `timezone` setting rather
  than assuming it matches the machine's local zone. `isValidTimeZone` backs the settings-tab inline
  validation (see below).
- **`googleCalendar.ts`** — thin wrappers around the Google Calendar v3 REST API
  (`listCalendars`, `listEventsForDay`) using Obsidian's `requestUrl` (not `fetch`, to avoid CORS).
  `listEventsForDay` builds its `timeMin`/`timeMax` from `zonedDayRange` and also passes `timeZone`
  to the API. `GoogleEvent` includes `description`, `attendees`, and `htmlLink` (used for footnotes
  and the event link) — all returned by the API by default, no extra `fields` param needed.
- **`dailyNote.ts`** — note file logic with no network calls:
  - `ensureDailyNote` creates `YYYYMMDD.md` from the user's template if it doesn't exist yet
    (never rewrites an existing note's body).
  - The template supports a `{{date}}` placeholder and a literal `{calendar}` token, which gets
    replaced by an HTML-comment-delimited marker block
    (`<!-- obcaldian:calendar:start -->` / `...:end -->`).
  - `syncNoteCalendarSection` finds those markers in an existing note and replaces only the content
    between them, leaving the rest of the note (including user edits) untouched. If the markers are
    missing, it no-ops and shows a `Notice` rather than guessing where to insert.
  - `renderCalendarBlock` turns fetched events into markdown lines, respecting each calendar's
    `addAs` style (`"checkbox"` → `- [ ]`, `"bullet"` → `-`). The title becomes a markdown link when
    `htmlLink` is present, and a time range (`formatTimeRange`) shows `HH:mm-HH:mm` when start and
    end differ, collapsing to one `HH:mm` otherwise. Events with a description and/or 3+ attendees
    get a `[^n]` marker with a markdown footnote definition appended at the end of the *same*
    rendered block (footnotes must live inside the marker-delimited section, since sync never
    touches anything outside it) — description first, then a `Participants:` line only once
    attendees reach `MIN_ATTENDEES_TO_LIST` (3). Footnote numbering is a single counter threaded
    across all calendars in one render call.
- **`sync.ts`** — orchestrates the above. `syncRange(vault, deps, daysAhead, opts?)` syncs today plus
  `daysAhead` additional days; `opts.notify` (default `true`) gates every `Notice` it and
  `syncNoteForDate` would otherwise show — set `false` for a silent run (errors go to
  `console.error` instead). `SyncOptions.onStart`/`onSuccess`/`onError` fire regardless of `notify`
  (used by `main.ts` to drive the status bar, independent of whether Notices are shown) — `onError`
  also fires for the "not connected"/"no calendars enabled" preconditions, with the same message
  text used to build the Notice. `syncAll` is `syncRange` using `settings.syncDaysAhead`, notifying;
  `autoSyncTick` is the same but silent, used by the background timer. `syncSingleNote` does one
  already-created note (used right after it's generated), always notifies, and does *not* take
  `SyncOptions` (it doesn't drive the status bar). All sync entry points gate on `isConnected(deps)`.
- **`syncDaysModal.ts`** — a small `Modal` prompting for a day count, pre-filled from
  `settings.syncDaysAhead`, used by the "Sync next N days..." command for one-off ranges without
  touching the persisted default.
- **`settingsTab.ts`** — the Obsidian settings UI. Reads/writes `plugin.settings` directly and
  calls `plugin.saveSettings()` after each change; calendar list refresh reconciles freshly fetched
  calendars against existing ones by `id` so user toggles/`addAs` choices survive a refresh. The
  client secret field is a `SecretComponent` (mounted via `Setting.addComponent`, since `Setting`
  has no `addSecret` shortcut) reading/writing through `getClientSecret`/`setClientSecret`, not
  `settings`. The Timezone field validates via `isValidTimeZone` on every change and uses
  `Setting.setErrorMessage()` (Obsidian API 1.13+) to show an inline error instead of persisting a
  bad value. Changing "Auto-sync interval (minutes)" calls `plugin.applyAutoSyncInterval()`
  immediately so the new interval takes effect without a plugin reload.
- **`main.ts`** — the `Plugin` entry point. Registers commands (open today/tomorrow, sync now, sync
  next N days) and a ribbon icon. Owns `authDeps()`, the single place that builds the `AuthDeps`
  object (including `this.app.secretStorage`) passed into the auth/sync modules. `loadSettings` runs
  `migrateLegacySecrets` against the raw loaded data before merging with `DEFAULT_SETTINGS`.
  `applyAutoSyncInterval()` clears any existing background-sync `window.setInterval` and, if
  `settings.autoSyncIntervalMinutes > 0`, starts a new one calling `autoSyncTick` (registered via
  `this.registerInterval` for unload cleanup); called once from `onload` and again whenever the
  settings tab changes that value.
  - A status bar item (`addStatusBarItem()`, next to Obsidian's built-in word/char count) shows
    live sync state — idle (blank), "syncing…", "synced Xm ago", or "sync failed" — driven by
    `statusBarSyncOptions()`, a `SyncOptions` object passed to every `syncAll`/`syncRange`/
    `autoSyncTick` call site so all of them (explicit commands, the days modal, the background
    timer) update the same `syncBarState`. Clicking the item triggers `syncAll`. A separate
    30-second interval only re-renders the "Xm ago" text against the already-stored timestamp; it
    doesn't trigger a resync.

### Key invariants to preserve

- Daily notes are addressed by date via `notePathFor`/`fileNameFor` (`YYYYMMDD.md` under the
  configured `dailyNoteFolder`) — don't introduce a second naming scheme.
- The calendar section of a note (including its footnotes) is only ever touched between the marker
  comments; general note content is never rewritten by sync.
- Network/auth code (`googleAuth.ts`, `googleCalendar.ts`) takes `AuthDeps`, not the plugin or
  `App`, so it stays testable/usable independent of `main.ts`.
- Secrets (client secret, access/refresh tokens) never go into `ObcaldianSettings` /
  `data.json` — they go through `AuthDeps.secretStorage`. Only non-secret metadata
  (`tokenExpiresAt`) lives in settings.
