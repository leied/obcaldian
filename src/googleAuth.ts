import { requestUrl } from "obsidian";
import type { SecretStorage } from "obsidian";
import type { ObcaldianSettings } from "./settings";

const REDIRECT_PORT = 42813;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const SECRET_CLIENT_SECRET = "obcaldian-google-client-secret";
const SECRET_ACCESS_TOKEN = "obcaldian-google-access-token";
const SECRET_REFRESH_TOKEN = "obcaldian-google-refresh-token";

const SUCCESS_HTML = `<!DOCTYPE html>
<html><body style="font-family: sans-serif; padding: 2em;">
<h2>Obcaldian connected.</h2>
<p>You can close this tab and return to Obsidian.</p>
</body></html>`;

const FAILURE_HTML = (message: string) => `<!DOCTYPE html>
<html><body style="font-family: sans-serif; padding: 2em;">
<h2>Obcaldian: connection failed</h2>
<p>${message}</p>
</body></html>`;

export interface AuthDeps {
	settings: ObcaldianSettings;
	saveSettings: () => Promise<void>;
	secretStorage: SecretStorage;
}

function buildAuthUrl(clientId: string): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		response_type: "code",
		scope: SCOPE,
		access_type: "offline",
		prompt: "consent",
	});
	return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function getClientSecret(deps: AuthDeps): string {
	return deps.secretStorage.getSecret(SECRET_CLIENT_SECRET) ?? "";
}

export function setClientSecret(deps: AuthDeps, secret: string): void {
	deps.secretStorage.setSecret(SECRET_CLIENT_SECRET, secret);
}

/** True once a refresh token is on file and a token expiry has been recorded. */
export function isConnected(deps: AuthDeps): boolean {
	return (
		deps.settings.tokenExpiresAt !== undefined &&
		!!deps.secretStorage.getSecret(SECRET_REFRESH_TOKEN)
	);
}

/**
 * Runs the installed-app OAuth loopback flow: opens the system browser for
 * consent, listens on 127.0.0.1 for the redirect, and exchanges the code
 * for tokens. Requires Node's http module, hence isDesktopOnly.
 */
export async function connectGoogleAccount(deps: AuthDeps): Promise<void> {
	const { settings } = deps;
	const clientSecret = getClientSecret(deps);
	if (!settings.googleClientId || !clientSecret) {
		throw new Error("Set a Google Client ID and Client Secret first.");
	}

	const code = await new Promise<string>((resolve, reject) => {
		// Obsidian desktop runs in Electron/Node, so 'http' is available via require.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const http = require("http");
		const server = http.createServer(
			(req: import("http").IncomingMessage, res: import("http").ServerResponse) => {
				try {
					const url = new URL(req.url ?? "", REDIRECT_URI);
					if (url.pathname !== "/callback") {
						res.writeHead(404);
						res.end();
						return;
					}
					const err = url.searchParams.get("error");
					const authCode = url.searchParams.get("code");
					if (err) {
						res.writeHead(400, { "Content-Type": "text/html" });
						res.end(FAILURE_HTML(err));
						server.close();
						reject(new Error(`Google denied the request: ${err}`));
						return;
					}
					if (!authCode) {
						res.writeHead(400, { "Content-Type": "text/html" });
						res.end(FAILURE_HTML("No authorization code received."));
						server.close();
						reject(new Error("No authorization code received."));
						return;
					}
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(SUCCESS_HTML);
					server.close();
					resolve(authCode);
				} catch (e) {
					server.close();
					reject(e);
				}
			}
		);
		server.on("error", (e: Error) => reject(e));
		server.listen(REDIRECT_PORT, "127.0.0.1", () => {
			window.open(buildAuthUrl(settings.googleClientId));
		});
	});

	const tokenResp = await requestUrl({
		url: "https://oauth2.googleapis.com/token",
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams({
			code,
			client_id: settings.googleClientId,
			client_secret: clientSecret,
			redirect_uri: REDIRECT_URI,
			grant_type: "authorization_code",
		}).toString(),
	});

	const data = tokenResp.json;
	if (!data.access_token || !data.refresh_token) {
		throw new Error("Google did not return the expected tokens.");
	}

	deps.secretStorage.setSecret(SECRET_ACCESS_TOKEN, data.access_token);
	deps.secretStorage.setSecret(SECRET_REFRESH_TOKEN, data.refresh_token);
	settings.tokenExpiresAt = Date.now() + data.expires_in * 1000;
	await deps.saveSettings();
}

export async function disconnectGoogleAccount(deps: AuthDeps): Promise<void> {
	// SecretStorage has no delete; overwriting with an empty string is the
	// closest available "clear".
	deps.secretStorage.setSecret(SECRET_ACCESS_TOKEN, "");
	deps.secretStorage.setSecret(SECRET_REFRESH_TOKEN, "");
	deps.settings.tokenExpiresAt = undefined;
	await deps.saveSettings();
}

async function refreshAccessToken(deps: AuthDeps): Promise<string> {
	const { settings } = deps;
	const refreshToken = deps.secretStorage.getSecret(SECRET_REFRESH_TOKEN);
	if (!refreshToken) {
		throw new Error("Google account is not connected.");
	}
	const resp = await requestUrl({
		url: "https://oauth2.googleapis.com/token",
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams({
			refresh_token: refreshToken,
			client_id: settings.googleClientId,
			client_secret: getClientSecret(deps),
			grant_type: "refresh_token",
		}).toString(),
	});
	const data = resp.json;
	if (!data.access_token) {
		throw new Error("Failed to refresh Google access token. Try reconnecting your account.");
	}
	deps.secretStorage.setSecret(SECRET_ACCESS_TOKEN, data.access_token);
	settings.tokenExpiresAt = Date.now() + data.expires_in * 1000;
	await deps.saveSettings();
	return data.access_token;
}

/** Returns a valid access token, refreshing it first if it has expired. */
export async function getValidAccessToken(deps: AuthDeps): Promise<string> {
	if (deps.settings.tokenExpiresAt === undefined) {
		throw new Error("Google account is not connected.");
	}
	if (Date.now() > deps.settings.tokenExpiresAt - 60_000) {
		return refreshAccessToken(deps);
	}
	const accessToken = deps.secretStorage.getSecret(SECRET_ACCESS_TOKEN);
	if (!accessToken) {
		throw new Error("Google account is not connected.");
	}
	return accessToken;
}

/**
 * One-time migration for data.json written by versions before secrets moved
 * into Obsidian's secret storage (API 1.11.4+). Mutates `raw` in place,
 * copying legacy plaintext fields into secret storage and stripping them so
 * they're never written back to disk. Returns whether anything was migrated.
 */
export function migrateLegacySecrets(
	secretStorage: SecretStorage,
	raw: Record<string, unknown>
): boolean {
	let migrated = false;

	if (typeof raw.googleClientSecret === "string" && raw.googleClientSecret) {
		secretStorage.setSecret(SECRET_CLIENT_SECRET, raw.googleClientSecret);
		migrated = true;
	}
	delete raw.googleClientSecret;

	const legacyTokens = raw.tokens as
		| { accessToken?: string; refreshToken?: string; expiresAt?: number }
		| undefined;
	if (legacyTokens) {
		if (legacyTokens.accessToken) {
			secretStorage.setSecret(SECRET_ACCESS_TOKEN, legacyTokens.accessToken);
		}
		if (legacyTokens.refreshToken) {
			secretStorage.setSecret(SECRET_REFRESH_TOKEN, legacyTokens.refreshToken);
		}
		if (typeof legacyTokens.expiresAt === "number") {
			raw.tokenExpiresAt = legacyTokens.expiresAt;
		}
		migrated = true;
	}
	delete raw.tokens;

	return migrated;
}
