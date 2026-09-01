# Privacy and data handling

Obcaldian runs locally inside Obsidian. It does not contain analytics or telemetry and does not
send data to the plugin publisher.

## Data read from Google

With the `calendar.readonly` OAuth scope, the plugin can read the calendars selected by the user
and their event metadata. Depending on rendering settings, that metadata may include titles,
times, descriptions, locations, meeting links, visibility, availability, and attendees.

## Data written locally

- Rendered event information is copied into the marker-delimited calendar sections of daily notes.
- Non-secret settings, calendar selections, sync health, and a local Google event cache are stored
  in Obsidian's plugin data for the vault. The cache reduces repeated Calendar API requests and can
  contain the same event metadata available to the renderer.
- The Google client secret and OAuth access/refresh tokens are stored in Obsidian SecretStorage.
- Imported Google credentials JSON is parsed once. Its source path and original contents are not
  retained.

Anyone who can read the vault or its backups can read event data rendered into notes. Privacy
settings can redact private events and omit attendee email addresses before data is persisted.

## Network destinations

The production allowlist permits HTTPS requests only to:

- `accounts.google.com` for browser authorization;
- `oauth2.googleapis.com` for OAuth token exchange and revocation;
- `www.googleapis.com` for Google Calendar API requests.

The OAuth redirect returns to a temporary HTTP server bound to `127.0.0.1` on the user's computer.
There are no publisher-controlled endpoints.

## Disconnecting and deletion

Disconnecting clears locally stored OAuth tokens. Existing Markdown already written to the vault
is not removed. Users can delete managed calendar sections, plugin settings/cache data, and the
plugin itself through their normal Obsidian and filesystem controls.
