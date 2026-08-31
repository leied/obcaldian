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
- [x] Preserve checkbox state for multi-day events across syncs, including persisted propagation
  into notes that have not been synced yet.
- [ ] Extend checkbox preservation to single-day checkbox events.
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

## User controls and rendering

- [ ] Add a setting to choose between creating missing future notes and updating existing notes
  only.
- [ ] Add filters for declined and cancelled events.
- [ ] Add rendering controls for all-day grouping, descriptions, attendees, location, meeting
  links, and calendar ordering.
- [ ] Add a safe **Repair calendar section** command that previews and confirms marker insertion in
  an existing note.

## Obsidian integration

- [ ] Optionally reuse the core Daily Notes plugin's folder, template, and filename format instead
  of requiring a separate `YYYYMMDD.md` configuration.
- [ ] Consider configurable commands/ribbon visibility if four default ribbon actions feel crowded
  during beta testing.

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
