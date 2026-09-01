# Plan: Simpler Google Calendar connections

Status: user-owned OAuth path implemented 2026-08-31; optional Secret iCal remains an evaluation.

## App Password decision

Do **not** implement a Google App Password field.

An App Password is a replacement account password for older clients and protocols that accept
username/password authentication. It is not an OAuth access token, cannot carry a Calendar API
scope, and cannot be sent as the `Authorization: Bearer` credential required by the Google Calendar
REST API. It also cannot be used as Basic Authentication against Google's current CalDAV endpoint:
Google documents that CalDAV requires HTTPS plus OAuth 2.0 and returns `401 Unauthorized` for Basic
Authentication.

Collecting a user's email and App Password would therefore add a high-value credential to the
plugin without producing a supported Calendar connection.

Official references:

- [Google Calendar API authorization and scopes](https://developers.google.com/workspace/calendar/api/auth)
- [OAuth 2.0 for desktop applications](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google CalDAV authentication requirements](https://developers.google.com/workspace/calendar/caldav/v2/guide)
- [Google Account App Password guidance](https://support.google.com/accounts/answer/185833)

## Project constraints

- No Obcaldian-operated backend, proxy, token broker, or hosted callback.
- No publisher-owned OAuth client shared by all users.
- Calendar contents and OAuth tokens must travel only between the user's machine and Google.
- Users should not need to trust the publisher with an authorization boundary that can be avoided.
- The plugin must remain independently auditable and usable if the publisher disappears.

Although a desktop OAuth client can use a local loopback callback without hosted infrastructure,
a publisher-managed client would still centralize the application identity, consent-screen control,
quota, and verification under the publisher's Google project. It also asks users to trust that the
distributed build behaves like the published source. That is explicitly not the desired model, so
publisher-managed OAuth is out of scope.

## Recommended connection paths

### 1. User-owned OAuth with credentials JSON import

Keep user-owned Google Cloud credentials as the full-featured connection method, but remove most of
the error-prone setup inside Obcaldian:

1. Add an **Import Google credentials JSON** control accepting Google's downloaded desktop-client
   file.
2. Validate that it contains an `installed` client, then copy the client ID into plugin settings and
   the client secret into SecretStorage. Never retain the source file or its path.
3. Show the parsed project/client identity before authorization so the user can verify which Google
   project they control.
4. Use Authorization Code + PKCE, a random `state` value, and the existing local loopback redirect.
5. Request only `calendar.readonly`; all Calendar API traffic goes directly from Obsidian to Google.
6. Keep refresh/access tokens in Obsidian SecretStorage and add explicit disconnect/revoke UX.
7. Retain manual Client ID/secret fields as a fallback, but make JSON import the documented path.

Acceptance criteria:

- Obcaldian operates no server and receives no token, calendar content, or connection metadata.
- Every user controls their own Google project, OAuth client, quota, consent configuration, and
  revocation boundary.
- Setup requires downloading and selecting one credentials file rather than copying individual
  fields.
- Consent asks only for read-only Calendar access.
- Callback state is verified and the loopback server always times out and closes.
- Revoked/expired tokens produce a direct reconnect action.
- README and privacy documentation accurately disclose Google data access and storage.
- Production code has an explicit outbound-host allowlist limited to Google's OAuth/Calendar
  endpoints and the local loopback callback; no telemetry or publisher endpoint is permitted.
- CI checks the network-destination allowlist and release provenance so unexpected outbound hosts
  cannot be added unnoticed.

### 2. Optional Secret iCal URL connection

Investigate a separate read-only feed mode using Google's **Secret address in iCal format**. This is
not an App Password and is not equivalent to account access. It is a bearer-secret URL for one
calendar at a time.

Implementation work:

1. Store each URL in SecretStorage and show only a redacted identifier in settings.
2. Fetch and parse ICS, including recurrence rules, exceptions, all-day values, timezones, and
   cancelled instances.
3. Give feed calendars stable local IDs so existing rendering and multi-day state logic can be
   reused.
4. Document limitations: manual setup per calendar, no automatic calendar list, possible Workspace
   admin restrictions, read-only access, and refresh latency controlled by the feed.
5. Provide a clear rotation workflow because anyone holding the URL can read that calendar.

This is the lowest-setup connection for users who accept its limitations. User-owned OAuth remains
the full-featured path for listing and selecting all calendars through Google's supported API.
