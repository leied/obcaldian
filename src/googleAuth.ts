import { requestUrl } from "obsidian";
import type { GoogleTokens, ObcaldianSettings } from "./settings";

const REDIRECT_PORT = 42813;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

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

/**
 * Runs the installed-app OAuth loopback flow: opens the system browser for
 * consent, listens on 127.0.0.1 for the redirect, and exchanges the code
 * for tokens. Requires Node's http module, hence isDesktopOnly.
 */
export async function connectGoogleAccount(deps: AuthDeps): Promise<void> {
	const { settings } = deps;
	if (!settings.googleClientId || !settings.googleClientSecret) {
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
			client_secret: settings.googleClientSecret,
			redirect_uri: REDIRECT_URI,
			grant_type: "authorization_code",
		}).toString(),
	});

	const data = tokenResp.json;
	if (!data.access_token || !data.refresh_token) {
		throw new Error("Google did not return the expected tokens.");
	}

	settings.tokens = {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: Date.now() + data.expires_in * 1000,
	};
	await deps.saveSettings();
}

export function disconnectGoogleAccount(deps: AuthDeps): Promise<void> {
	deps.settings.tokens = undefined;
	return deps.saveSettings();
}

async function refreshAccessToken(deps: AuthDeps, tokens: GoogleTokens): Promise<GoogleTokens> {
	const { settings } = deps;
	const resp = await requestUrl({
		url: "https://oauth2.googleapis.com/token",
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: new URLSearchParams({
			refresh_token: tokens.refreshToken,
			client_id: settings.googleClientId,
			client_secret: settings.googleClientSecret,
			grant_type: "refresh_token",
		}).toString(),
	});
	const data = resp.json;
	if (!data.access_token) {
		throw new Error("Failed to refresh Google access token. Try reconnecting your account.");
	}
	const refreshed: GoogleTokens = {
		accessToken: data.access_token,
		refreshToken: tokens.refreshToken,
		expiresAt: Date.now() + data.expires_in * 1000,
	};
	settings.tokens = refreshed;
	await deps.saveSettings();
	return refreshed;
}

/** Returns a valid access token, refreshing it first if it has expired. */
export async function getValidAccessToken(deps: AuthDeps): Promise<string> {
	const tokens = deps.settings.tokens;
	if (!tokens) {
		throw new Error("Google account is not connected.");
	}
	if (Date.now() > tokens.expiresAt - 60_000) {
		const refreshed = await refreshAccessToken(deps, tokens);
		return refreshed.accessToken;
	}
	return tokens.accessToken;
}
