# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's **Security → Report a vulnerability**
workflow for this repository. Do not include OAuth tokens, Google credentials, secret calendar
URLs, private event data, or a real vault in the report. A minimal reproduction with redacted or
synthetic data is preferred.

If private vulnerability reporting is unavailable, open a repository issue asking the maintainer
to establish a private contact channel. Do not disclose exploit details in that public issue.

## Security boundaries

- OAuth client secrets and access/refresh tokens are stored using Obsidian SecretStorage.
- Calendar data is written only to the user's vault and plugin-local persisted data.
- Production network requests are restricted in code to Google OAuth and Calendar hosts.
- The plugin has no analytics, telemetry, publisher proxy, or publisher-operated backend.
- The loopback OAuth callback listens only on `127.0.0.1` and is used only while connecting.

Only the latest released version is supported with security fixes.
