# Obcaldian

An Obsidian plugin (desktop only) that generates daily notes from your own template and keeps a
plugin-managed section of each note synced with selected Google Calendars.

## Features

- Creates a daily note from a template you write, on demand or via ribbon icon/commands.
- Keeps a single marker-delimited section of that note in sync with your Google Calendar events —
  the rest of the note is never touched, so your own edits are safe.
- Each event can carry a footnote with its description and, once there are three or more attendees,
  a participant list.
- Event times are computed against a configurable IANA timezone (defaults to your system's), so
  sync stays correct even if your calendar and machine disagree.
- Sync today plus a configurable number of days ahead, or run a one-off "Sync next N days" from the
  command palette.
- Optional background auto-sync on an interval.
- Google client secret and OAuth tokens are stored in Obsidian's own secret storage, never in plain
  text in your vault's `data.json`.

## Setup

### 1. Install and enable

Copy (or build, see below) `main.js`, `manifest.json`, and `styles.css` into your vault's
`.obsidian/plugins/obcaldian/` folder, then enable **Obcaldian** in Settings → Community plugins.

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

### 3. Configure the plugin

In Settings → Obcaldian:

- **Daily note folder** / **Template file** — where notes go and which template to use.
- **Timezone** — defaults to your system timezone; only change it if your calendar should be
  queried in a different zone than the machine you're running Obsidian on.
- **Days ahead to sync** — how far past today "Sync now" reaches.

### 4. Connect a Google account

Google requires your own OAuth client — this plugin doesn't ship a shared one, so you create a
small, free "app" in Google Cloud that only you use.

#### 4a. Create a Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and sign in with the Google
   account whose calendars you want to sync.
2. Click the project dropdown (top left, next to "Google Cloud") → **New Project**.
3. Give it any name (e.g. "Obcaldian") and click **Create**. No billing account is required for
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
   > this status, so Obcaldian's sync will eventually fail with a "not connected"-style error and
   > you'll need to click **Connect** again in the plugin settings — a few seconds' work. If you
   > have a Google Workspace account (a work/school domain, not `@gmail.com`), you can instead set
   > the user type to **Internal** in step 2 above; internal apps skip verification and the 7-day
   > expiry entirely, but are restricted to accounts in your Workspace org.

#### 4d. Create the OAuth client

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Desktop app**. Give it any name.
3. Click **Create**, then copy the generated **Client ID** and **Client secret** from the dialog
   (or the credentials list afterwards).

   Desktop-app clients don't need a redirect URI configured in the console — Google allows any
   loopback address automatically. Obcaldian's local callback server listens on
   `http://127.0.0.1:42813/callback` and requests only the read-only Calendar scope.

#### 4e. Connect in Obsidian

1. In Settings → Obcaldian, paste the Client ID and Client secret into their fields.
2. Click **Connect**. This opens your system browser to Google's consent screen; approve access
   (you'll hit the "unverified app" warning here if you published the app per 4c, or you'll just
   sign in directly if it's still in Testing and you're the test user).
3. Google redirects back to the local callback server, which shows a plain "Obcaldian connected"
   page — you can close that browser tab and return to Obsidian.
4. Click **Refresh** under Calendars, then toggle on the calendars you want synced and choose how
   each one's events should be added (`- [ ]` checkbox or `-` bullet).

Both the Client Secret and the resulting OAuth tokens are stored in Obsidian's secret storage, not
in your vault's `data.json`.

## Commands

- **Open today's daily note** / **Open tomorrow's daily note**
- **Sync Google calendars now** — syncs today plus the configured days ahead.
- **Sync next N days...** — prompts for a day count and syncs that range once, without changing
  your default.

## Development

- `npm run dev` — esbuild in watch mode.
- `npm run build` — type-checks (`tsc -noEmit`) and produces a minified production build.
- `npm test` — runs the test suite.

See `CLAUDE.md` for an architecture overview if you're working on the plugin itself.
