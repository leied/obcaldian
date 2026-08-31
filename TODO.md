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

- [ ] Add Google event IDs to the event model and embed stable, invisible event markers in rendered
  Markdown.
- [ ] Preserve checkbox state across syncs. Start with multi-day events as designed in
  [`docs/plans/multi-day-events.md`](docs/plans/multi-day-events.md), then extend preservation to
  single-day checkbox events.
- [ ] Calculate all-day and overnight spans in the configured timezone and render `Day N/Total`
  annotations on every covered day.
- [ ] During interactive sync, ask before propagating a completed multi-day event across its other
  notes. During background sync, preserve existing states without opening a modal.

## Sync integrity and efficiency

- [ ] Fetch and validate the entire requested date range before writing any notes. Per-day writes
  are protected now, but a later failure can still leave an earlier day updated.
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

- [ ] Add an OAuth `state` nonce, callback timeout/cancellation, and guaranteed loopback-server
  cleanup.
- [ ] Recognize revoked or expired refresh tokens and guide the user directly to reconnect.
- [ ] Allow importing Google's downloaded desktop OAuth credentials JSON instead of requiring two
  fields to be copied manually.
