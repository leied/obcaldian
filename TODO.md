# Obcaldian roadmap

This file collects the recommended follow-up work from the initial project review. Items are
ordered roughly by user impact and release risk, not by implementation difficulty.

## Before public-directory submission

- [ ] Decide whether to rename **Obcaldian**. Current Obsidian directory validation discourages
  plugin names ending in `dian`, so the name may block publication even though the manifest ID is
  otherwise valid. If renamed, update `manifest.json`, `package.json`, README copy, OAuth-facing
  copy, release assets, and the eventual community-directory entry together.
- [ ] Run a beta release through BRAT and exercise OAuth, token refresh, calendar pagination,
  background checks, ribbon actions, and sync against a disposable real vault on each supported
  desktop platform.
- [ ] Add the official Obsidian ESLint rules and resolve all public-plugin policy findings.
- [ ] Add a security-reporting section or `SECURITY.md`, especially because the plugin handles
  OAuth credentials and makes external requests.

## Event identity and multi-day events

- [x] Add Google event IDs to the event model and embed stable, invisible event markers in rendered
  Markdown.
- [ ] Strengthen recurring-event identity using the calendar ID, recurring series ID, and immutable
  original start time where appropriate. Cover moved, cancelled, detached, and timezone-shifted
  instances so completion state and user annotations remain attached to the intended occurrence.
- [x] Preserve checkbox state for multi-day events across syncs, including persisted propagation
  into notes that have not been synced yet.
- [ ] Extend checkbox preservation to single-day checkbox events.
- [ ] Preserve user-authored annotations attached to an event across syncs. Anchor the editable
  content to the event's stable identity, reattach it after rendering, and define how annotations
  are handled when an event is moved or deleted.
- [x] Calculate all-day and overnight spans in the configured timezone and render `Day N/Total`
  annotations on every covered day.
- [x] During interactive sync, ask before propagating a completed multi-day event across its other
  notes. During background sync, preserve existing states without opening a modal.

## Sync integrity and efficiency

- [x] Fetch the entire requested date range before writing any notes, preventing a later network
  failure from leaving an earlier date updated.
- [ ] Preflight every target note/template before the write phase too, making non-network failures
  atomic across the requested range.
- [ ] Implement Google Calendar incremental sync tokens and local caching to reduce API traffic for
  background checks.
- [ ] Prevent or coalesce overlapping manual and automatic sync runs.
- [ ] Record per-calendar health and last-success timestamps so a failure identifies exactly which
  calendar and date needs attention.
- [ ] Add bounded, cancellable retries for transient Google failures and quota responses. Classify
  permanent errors separately, respect `Retry-After`, and use exponential backoff with jitter for
  retryable `429` and `5xx` responses.
- [ ] Add a manual sync preview that lists notes to create, change, or skip, with a diff of each
  managed calendar section. Retain a short-lived snapshot so the last successful manual sync can
  be undone without replacing user content outside the markers.
- [ ] Run a quiet catch-up sync when the plugin starts, the computer resumes, or connectivity
  returns if the last successful sync is stale. Route it through the shared sync coordinator so it
  cannot overlap another run.

## User controls and rendering

- [ ] Add a setting to choose between creating missing future notes and updating existing notes
  only.
- [ ] Add filters for declined and cancelled events.
- [ ] Add rendering controls for all-day grouping, descriptions, attendees, location, meeting
  links, and calendar ordering.
- [ ] Escape and normalize calendar names and event content before writing Markdown. Protect link
  syntax and footnotes, validate outbound event URLs, and prevent event text from containing or
  imitating Obcaldian's internal section markers.
- [ ] Add privacy-aware event rendering: recognize Google event visibility, optionally redact
  private events to a neutral `Busy` label, and allow attendee email addresses to be excluded from
  persisted Markdown.
- [ ] Recognize Google event types and availability, with controls for focus time, out-of-office,
  working-location, birthday, and transparent/free events.
- [ ] Make time rendering configurable: system or explicit locale, 12/24-hour clock, optional end
  times, and a customizable range separator.
- [ ] Emit stable CSS classes for calendars and support configured or Google-derived calendar
  colors without inline styles, while continuing to respect the active Obsidian theme.
- [ ] Add a safe **Repair calendar section** command that previews and confirms marker insertion in
  an existing note.

## Obsidian integration

- [ ] Optionally reuse the core Daily Notes plugin's folder, template, and filename format instead
  of requiring a separate `YYYYMMDD.md` configuration.
- [ ] Add **Sync date range...** with past and future dates, a maximum-range safeguard, preview, and
  support for update-existing-only mode.
- [ ] Add **Sync calendar for this note** by resolving the active daily note's date from the active
  Daily Notes or Obcaldian filename configuration.
- [ ] Replace the creation-time heuristic with an explicit `{ file, created }` result from daily-note
  creation so an existing but recently created file is never mistaken for a new note.
- [ ] Consider configurable commands/ribbon visibility if four default ribbon actions feel crowded
  during beta testing.

## Privacy, recovery, and supportability

- [ ] Add a privacy/data-handling document and link it from the README and connection UI. Explain
  which Google data is read and copied into the vault, where secrets and cached data live, every
  permitted network destination, and that the plugin has no analytics or telemetry.
- [ ] Add a redacted **Copy diagnostics** action containing plugin/app versions, platform, timezone,
  enabled-calendar count, note paths, network host names, and categorized recent failures. Never
  include credentials, calendar/event IDs, secret URLs, attendee data, or event text.
- [ ] Version and validate persisted settings. Add sequential migrations, repair malformed values
  to documented defaults, validate nested state, and test upgrades from each released schema.
- [ ] Test compatibility against both the declared minimum Obsidian version and the current API so
  development against `obsidian: latest` cannot silently introduce an unsupported API dependency.

## OAuth experience

- [ ] Implement the supported connection roadmap in
  [`docs/plans/google-connection-options.md`](docs/plans/google-connection-options.md). Google App
  Passwords were investigated and rejected because Calendar REST and current CalDAV require OAuth
  2.0; do not collect a credential the endpoints cannot use.
- [ ] Make user-owned desktop OAuth credentials JSON import the primary full-featured setup path.
  Keep all token exchange and Calendar requests local between Obsidian and Google.
- [ ] Add an auditable outbound-host allowlist and CI test: Google OAuth/Calendar plus local loopback
  only, with no analytics, telemetry, proxy, or publisher-controlled endpoint.
- [x] Reject publisher-managed OAuth as a project direction. Even without a hosted callback, it
  centralizes application identity, consent, quota, and trust under the publisher's Google project.
- [ ] Evaluate a per-calendar Secret iCal URL mode as a limited read-only/no-OAuth alternative.
- [ ] Add an OAuth `state` nonce, callback timeout/cancellation, and guaranteed loopback-server
  cleanup.
- [ ] Recognize revoked or expired refresh tokens and guide the user directly to reconnect.
- [ ] Allow importing Google's downloaded desktop OAuth credentials JSON instead of requiring two
  fields to be copied manually.

## Later product ideas

- [ ] Support multiple isolated Google account profiles, each with its own user-owned OAuth
  credentials, tokens, calendars, health state, and revocation boundary.
- [ ] Optionally generate a weekly or rolling seven-day calendar overview using the shared event
  cache and renderer while keeping daily notes and event completion state authoritative.
- [ ] Add a command to create or open an event note keyed by stable event identity, with selected
  metadata and a backlink to its daily note; do not create event notes automatically.
