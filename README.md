# DailyCalSync

An Obsidian plugin (desktop only) that generates daily notes from your own template and keeps a
plugin-managed section synced with multiple Google accounts and read-only Secret iCalendar feeds.

The plugin runs locally without analytics, telemetry, a publisher proxy, or a hosted backend. See
[Privacy and data handling](PRIVACY.md) and the [security policy](SECURITY.md).

## Features

- Creates a daily note from a template you write, on demand or via ribbon icon/commands.
- Keeps a single marker-delimited section of that note in sync with calendar events —
  the rest of the note is never touched, so your own edits are safe.
- Each event can carry a footnote with its description and, once there are three or more attendees,
  a participant list.
- Event times are computed against a configurable IANA timezone (defaults to your system's), so
  sync stays correct even if your calendar and machine disagree.
- Sync today plus a configurable number of days ahead, or run a past/future date range from the
  command palette.
- Quiet background calendar checks, every three hours by default on new installations and fully
  configurable (including off).
- Google client secret and OAuth tokens are stored in Obsidian's own secret storage, never in plain
  text in your vault's `data.json`.
- Manual sync preview, managed-section diffs, and one-session undo that never replaces content
  outside the calendar markers.
- Stable event identity preserves single- and multi-day checkboxes and attached annotations,
  including when a recurring occurrence moves.
- Privacy-aware filters and rendering controls for event details, visibility, availability, event
  types, time format, ordering, and calendar colors.
- Incremental Google sync tokens and a local event cache reduce background API traffic.
- Multiple Google profiles with isolated OAuth credentials, tokens, calendar selections, caches,
  health state, disconnect, and revocation boundaries.
- Read-only Secret iCalendar feeds whose complete HTTPS URLs stay in Obsidian SecretStorage.
- A first-run guided setup and a persistent setup overview showing which pieces still need work.

## Setup

### 1. Install and enable

Copy (or build, see below) `main.js`, `manifest.json`, and `styles.css` into your vault's
`.obsidian/plugins/dailycalsync/` folder, then enable **DailyCalSync** in Settings → Community plugins.

On first launch, DailyCalSync opens a four-step setup guide covering privacy, daily-note settings,
calendar sources, and readiness. You can run it again from the top of the settings page.

### 2. Write a template

Create a template note anywhere in your vault. Two placeholders are recognized:

- `{{date}}` — replaced with the note's date (`YYYY-MM-DD`).
- `{calendar}` — on its own line, marks where the plugin-managed calendar section goes. Everything
  between the markers this creates is rewritten on every sync; everything else in the note is left
  alone.

Example template:

```markdown
# {{date}}

## Calendar

{calendar}

## Notes
```

If `{calendar}` is missing, DailyCalSync shows a warning and does not create the note. This avoids
creating a daily note that the plugin can never safely synchronize.

### 3. Configure the plugin

In Settings → DailyCalSync:

- **Daily note folder** / **Template file** — where notes go and which template to use.
- **Timezone** — defaults to your system timezone; only change it if your calendar should be
  queried in a different zone than the machine you're running Obsidian on.
- **Days ahead to sync** — how far past today "Sync now" reaches.
- **Reuse core Daily Notes settings** — optionally copy its folder, template, and filename format.
- **Missing notes** — choose whether range sync creates notes or updates existing notes only.

### 4. Connect one or more Google accounts

Google requires your own OAuth client — this plugin doesn't ship a shared one, so you create a
small, free "app" in Google Cloud that only you use.

#### 4a. Create a Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and sign in with the Google
   account whose calendars you want to sync.
2. Click the project dropdown (top left, next to "Google Cloud") → **New Project**.
3. Give it any name (e.g. "DailyCalSync") and click **Create**. No billing account is required for
   this API.
4. Make sure the new project is selected in the project dropdown before continuing.

#### 4b. Enable the Calendar API

1. Go to **APIs & Services → Library** (or use the search bar at the top).
2. Search for **Google Calendar API** and open it.
3. Click **Enable**.

#### 4c. Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** (unless you have a Google Workspace org and want Internal) and click
   **Create**.
3. Fill in the required fields (app name, your email as support/developer contact) — the rest can
   be left blank.
4. On the **Scopes** step you can skip adding scopes here; the plugin requests
   `.../auth/calendar.readonly` directly when you connect.
5. On the **Test users** step, add the Google account you'll actually use with the plugin. This is
   required while the app is in "Testing" status.
6. Save through to the summary page. **Leave the publishing status as "Testing"** — don't click
   Publish App. `calendar.readonly` is a "sensitive" scope, so Google requires a formal
   verification review (privacy policy, app homepage, scope justification) before it'll let you
   move to "In production." That's not worth it for a personal, single-user app.

   > **Trade-off of staying in Testing:** Google expires refresh tokens after 7 days for apps in
   > this status, so DailyCalSync's sync will eventually fail with a "not connected"-style error and
   > you'll need to click **Connect** again in the plugin settings — a few seconds' work. If you
   > have a Google Workspace account (a work/school domain, not `@gmail.com`), you can instead set
   > the user type to **Internal** in step 2 above; internal apps skip verification and the 7-day
   > expiry entirely, but are restricted to accounts in your Workspace org.

#### 4d. Create and download the OAuth client

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Desktop app**. Give it any name.
3. Click **Create**, then use **Download JSON** from the credentials list. Keep this file private.

   Desktop-app clients don't need a redirect URI configured in the console — Google allows any
   loopback address automatically. DailyCalSync's local callback server listens on
   `http://127.0.0.1:42813/callback` and requests only the read-only Calendar scope.

#### 4e. Connect in Obsidian

1. In Settings → DailyCalSync, click **Add Google account**. Give the profile a useful name, then
   click **Import JSON** and select the downloaded desktop credentials.
   DailyCalSync extracts the client/project identity and secret, then discards the source file and
   path. Manual Client ID/secret fields remain available as a fallback.
2. Click **Connect**. This opens your system browser to Google's consent screen; approve access
   (you'll hit the "unverified app" warning here if you published the app per 4c, or you'll just
   sign in directly if it's still in Testing and you're the test user).
3. Google redirects back to the local callback server, which shows a plain "DailyCalSync connected"
   page — you can close that browser tab and return to Obsidian.
4. Click **Refresh** under Calendars, then toggle on the calendars you want synced and choose how
   each one's events should be added (`- [ ]` checkbox or `-` bullet).

The client secret and resulting OAuth tokens are stored in Obsidian's secret storage, not
in your vault's `data.json`.

Repeat the process for each Google account. Every profile owns its credentials, tokens, calendars,
cache, and health state. Removing a profile revokes its refresh token when possible and clears that
profile's local secrets without affecting any other profile.

### 5. Add a Secret iCalendar feed

Under **Secret iCalendar feeds**, click **Add iCal feed**, name it, and paste its private HTTPS
`.ics` URL. The URL is stored only in Obsidian SecretStorage and fetched directly from the host you
selected. It is never included in diagnostics or plugin `data.json`.

This mode is read-only and does not need OAuth. DailyCalSync supports all-day and timed VEVENTs,
folded/escaped text, `DURATION`, `EXDATE`, moved recurrence overrides, and bounded daily, weekly,
monthly, and yearly `RRULE` expansion. Feeds must use HTTPS, are limited to 5 MB, and may expand to
at most 5,000 occurrences in one sync range. Treat a Secret iCal URL like a password: anyone who
has it can usually read that calendar.

## Commands

- **Open today's daily note** / **Open tomorrow's daily note**
- **Sync calendars now** — syncs every enabled Google and iCalendar source for today plus the
  configured days ahead.
- **Sync upcoming days...** — prompts for a day count and syncs that range once, without changing
  your default.
- **Sync calendar date range...** — supports past/future dates, preview, and existing-only mode.
- **Sync calendar for this note** — resolves the active daily note using the configured format.
- **Repair calendar section** — previews and appends missing markers to the active note.
- **Undo last calendar sync** — restores managed sections from the last manual sync in this
  session, skipping sections changed afterward.
- **Copy redacted diagnostics** — copies versions, platform/configuration, permitted hosts, and
  categorized failures without credentials or calendar/event content.

Four common actions have ribbon icons: today, tomorrow, sync now, and upcoming days. You can hide
unwanted ribbon actions using Obsidian's ribbon configuration. Manual calendar syncs show a preview;
background syncs stay quiet and share the same coordinator so they cannot overlap a manual write.

## Multi-day events

DailyCalSync renders an all-day
event spanning several dates—and a timed event crossing midnight—in every overlapping daily note,
annotated as `(Day 1/3)`, `(Day 2/3)`, and so on. The span is calculated in the configured timezone;
Google's all-day end date is correctly treated as exclusive.

Multi-day checkbox lines contain an invisible event marker. On the next sync, DailyCalSync uses that
marker to preserve the checkbox state and offers three behaviors under Settings → DailyCalSync → Sync:

- **Keep each day independent** — preserve only the checkbox state already present in each note.
- **Ask during manual sync** — when a checked day has later occurrences, ask whether that day and
  every following day should be considered done. Declining keeps the dates independent. The prompt
  appears again on a later manual sync while the dates still differ.
- **Mark following days done** — automatically propagate from the earliest checked occurrence to
  the end of the event. Earlier occurrences remain unchanged.

### What happens to dates that have not been synced?

Accepting the prompt—or selecting automatic propagation—stores a small rule keyed by the source
calendar and event ID. For example, checking Day 2 stores “completed from Day 2 through the event's
end.” DailyCalSync does not create every future note immediately. Instead, when Day 3 or Day 4 later
enters a sync range, its occurrence is rendered checked from the stored rule.

Background checks never open a modal. In **Ask** mode they preserve checkbox states already on disk
but wait for the next manual sync before propagating. Accepted rules continue to apply silently.
Rules expire 30 days after the event ends and can be removed immediately with **Clear** beside
“Remembered multi-day completions.” Switching to **Keep each day independent** also clears them.
While a remembered rule is active it wins during sync, so manually unchecking one propagated line
will be reversed unless the remembered rules are cleared first.

Because older plugin versions did not emit event markers, an already-checked legacy line cannot be
matched reliably during the first sync after upgrading. Once the new marker has been written,
future state is preserved. Propagation applies to checkbox calendars; bullet calendars still get
the day annotation but have no completion state.

## Event annotations

Every identified event has an invisible marker. Text added after that marker on the same line, or
non-empty lines indented beneath the event, is treated as a user annotation and carried across
syncs. For example:

```markdown
- [x] 09:00 Standup <!-- dailycalsync:event:... --> send recap
  - Decision: ship on Friday
```

If an occurrence moves and its prior location is available in the local cache, the annotation is
reattached on the new date. If an annotated event is deleted or filtered, the annotation remains
under **Unmatched calendar annotations** instead of being silently discarded.

## Sync safety and caching

Calendar requests and every target note are preflighted before a write. The plan is checked again
after preview; if a note changed meanwhile, sync stops safely. Vault failures trigger rollback of
earlier writes. Transient quota/server errors use bounded retries with `Retry-After` support.

The first Google sync builds a per-calendar event cache and stores Google's incremental token.
Later syncs request changes only; an expired token automatically triggers a full rebuild. Secret
iCalendar feeds are fetched as complete read-only documents and their parsed range is cached.
Cache contents stay local in Obsidian's plugin data and can include event metadata.

## Development

- `npm run dev` — esbuild in watch mode.
- `npm run build` — type-checks (`tsc -noEmit`) and produces a minified production build.
- `npm run lint` — runs the official Obsidian plugin rules.
- `npm test` — runs the test suite.
- `npm run validate:release` — validates publication files and version metadata after a build.
- `npm run check` — runs the production build, tests, and release validation used by CI.

CI tests Node.js 20 and 22, compiles against Obsidian 1.11.4 and the latest API, and uploads an
installable plugin artifact. Tag builds additionally
require the tag to exactly match `manifest.json`, generate a provenance attestation, and create a
draft GitHub release for final review.

See `CLAUDE.md` for an architecture overview if you're working on the plugin itself.
