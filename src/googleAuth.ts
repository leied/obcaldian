import * as http from "node:http";
import { Platform } from "obsidian";
import type { SecretStorage, TFile } from "obsidian";
import { googleRequest } from "./network";
import {
	LEGACY_GOOGLE_ACCOUNT_ID,
	type DailyCalSyncSettings,
	type GoogleAccountProfile,
} from "./settings";

const REDIRECT_PORT = 42813;
const CALLBACK_PATH = "/callback";
const CALLBACK_TIMEOUT_MS = 120_000;
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const LEGACY_SECRET_CLIENT_SECRET = "obcaldian-google-client-secret";
const LEGACY_SECRET_ACCESS_TOKEN = "obcaldian-google-access-token";
const LEGACY_SECRET_REFRESH_TOKEN = "obcaldian-google-refresh-token";

const SUCCESS_HTML = `<!DOCTYPE html><html><body><h2>Calendar connected.</h2><p>You can close this tab and return to Obsidian.</p></body></html>`;

export interface AuthDeps {
	settings: DailyCalSyncSettings;
	saveSettings: () => Promise<void>;
	secretStorage: SecretStorage;
	accountId?: string;
	rollbackCreatedFile?: (file: TFile) => Promise<void>;
}

export interface ImportedGoogleCredentials {
	clientId: string;
	clientSecret: string;
	projectId: string;
}

export interface ConnectOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

interface TokenPayload {
	accessToken: string;
	refreshToken?: string;
	expiresIn: number;
}

type UnknownRecord = Record<string, unknown>;

export class ReconnectRequiredError extends Error {
	constructor(message = "Google access was revoked or expired. Reconnect this account.") {
		super(message);
		this.name = "ReconnectRequiredError";
	}
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountSecretKey(accountId: string, kind: "client-secret" | "access-token" | "refresh-token"): string {
	return `dailycalsync-google-${accountId}-${kind}`;
}

function validSecretId(id: string): boolean {
	return /^[a-z0-9-]{1,64}$/.test(id);
}

function getAccountSecret(deps: AuthDeps, accountId: string, kind: "client-secret" | "access-token" | "refresh-token"): string {
	const id = accountSecretKey(accountId, kind);
	return validSecretId(id) ? deps.secretStorage.getSecret(id) ?? "" : "";
}

function clearAccountSecret(deps: AuthDeps, accountId: string, kind: "client-secret" | "access-token" | "refresh-token"): void {
	const id = accountSecretKey(accountId, kind);
	if (validSecretId(id)) deps.secretStorage.setSecret(id, "");
}

export function googleAccount(deps: AuthDeps): GoogleAccountProfile {
	if (!deps.accountId) throw new Error("Choose a Google account profile first.");
	const account = deps.settings.googleAccounts.find((candidate) => candidate.id === deps.accountId);
	if (!account) throw new Error("The selected Google account profile no longer exists.");
	return account;
}

export function withGoogleAccount(deps: AuthDeps, accountId: string): AuthDeps {
	return { ...deps, accountId };
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	})[character] ?? character);
}

function failureHtml(message: string): string {
	return `<!DOCTYPE html><html><body><h2>Connection failed</h2><p>${escapeHtml(message)}</p></body></html>`;
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomUrlSafe(byteCount: number): string {
	const bytes = new Uint8Array(byteCount);
	window.crypto.getRandomValues(bytes);
	return base64Url(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64Url(new Uint8Array(digest));
}

function buildAuthUrl(clientId: string, redirectUri: string, state: string, codeChallenge: string): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: SCOPE,
		access_type: "offline",
		prompt: "consent",
		state,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
	});
	return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function parseTokenPayload(value: unknown, requireRefreshToken: boolean): TokenPayload {
	if (!isRecord(value)) throw new Error("Google returned a malformed token response.");
	const accessToken = value.access_token;
	const refreshToken = value.refresh_token;
	const expiresIn = value.expires_in;
	if (typeof accessToken !== "string" || !accessToken || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0 || (requireRefreshToken && (typeof refreshToken !== "string" || !refreshToken))) {
		throw new Error("Google did not return the expected tokens.");
	}
	return { accessToken, expiresIn, ...(typeof refreshToken === "string" && refreshToken ? { refreshToken } : {}) };
}

function googleError(value: unknown): { code?: string; description?: string } {
	if (!isRecord(value)) return {};
	return {
		...(typeof value.error === "string" ? { code: value.error } : {}),
		...(typeof value.error_description === "string" ? { description: value.error_description } : {}),
	};
}

export function parseGoogleCredentialsJson(rawText: string): ImportedGoogleCredentials {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText) as unknown;
	} catch {
		throw new Error("The selected file is not valid JSON.");
	}
	if (!isRecord(parsed) || !isRecord(parsed.installed)) {
		throw new Error("Choose credentials for a Google OAuth Desktop app (an installed client).");
	}
	const installed = parsed.installed;
	const clientId = installed.client_id;
	const clientSecret = installed.client_secret;
	const projectId = installed.project_id;
	const authUri = installed.auth_uri;
	const tokenUri = installed.token_uri;
	if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string" || !clientSecret || typeof projectId !== "string" || !projectId) {
		throw new Error("The Google desktop credentials file is missing required fields.");
	}
	if ((authUri !== undefined && authUri !== "https://accounts.google.com/o/oauth2/auth") || (tokenUri !== undefined && tokenUri !== "https://oauth2.googleapis.com/token")) {
		throw new Error("The credentials file contains unexpected OAuth endpoints.");
	}
	return { clientId, clientSecret, projectId };
}

export async function importGoogleCredentials(deps: AuthDeps, rawText: string): Promise<ImportedGoogleCredentials> {
	const credentials = parseGoogleCredentialsJson(rawText);
	const account = googleAccount(deps);
	account.clientId = credentials.clientId;
	account.projectId = credentials.projectId;
	setClientSecret(deps, credentials.clientSecret);
	await deps.saveSettings();
	return credentials;
}

export function getClientSecret(deps: AuthDeps): string {
	const account = googleAccount(deps);
	return getAccountSecret(deps, account.id, "client-secret");
}

export function setClientSecret(deps: AuthDeps, secret: string): void {
	const account = googleAccount(deps);
	deps.secretStorage.setSecret(accountSecretKey(account.id, "client-secret"), secret);
}

export function isConnected(deps: AuthDeps): boolean {
	if (!deps.accountId) {
		return deps.settings.googleAccounts.some((account) => isConnected(withGoogleAccount(deps, account.id)));
	}
	const account = googleAccount(deps);
	return account.tokenExpiresAt !== undefined && Boolean(getAccountSecret(deps, account.id, "refresh-token"));
}

/** Clears every locally stored token for an account and returns the former refresh token for optional revocation. */
export function clearGoogleAccountTokens(deps: AuthDeps): string {
	const account = googleAccount(deps);
	const refreshToken = getAccountSecret(deps, account.id, "refresh-token");
	clearAccountSecret(deps, account.id, "access-token");
	clearAccountSecret(deps, account.id, "refresh-token");
	account.tokenExpiresAt = undefined;
	return refreshToken;
}

/** Clears all local credentials without failing on legacy profiles whose derived secret IDs are too long. */
export function clearGoogleAccountSecrets(deps: AuthDeps): string {
	const account = googleAccount(deps);
	const refreshToken = clearGoogleAccountTokens(deps);
	clearAccountSecret(deps, account.id, "client-secret");
	return refreshToken;
}

/** Best-effort remote revocation. Local removal must never wait for this request. */
export async function revokeGoogleToken(refreshToken: string): Promise<boolean> {
	if (!refreshToken) return false;
	try {
		const response = await googleRequest(
			{
				url: "https://oauth2.googleapis.com/revoke",
				method: "POST",
				contentType: "application/x-www-form-urlencoded",
				body: new URLSearchParams({ token: refreshToken }).toString(),
				throw: false,
			},
			{ maxAttempts: 1 }
		);
		return response.status >= 200 && response.status < 300;
	} catch {
		return false;
	}
}

async function receiveAuthorizationCode(clientId: string, state: string, codeChallenge: string, options: ConnectOptions): Promise<{ code: string; redirectUri: string }> {
	if (!Platform.isDesktop) throw new Error("Google OAuth connection is available on desktop only.");
	const redirectUri = `http://127.0.0.1:${REDIRECT_PORT}${CALLBACK_PATH}`;
	return new Promise((resolve, reject) => {
		let settled = false;
		const server = http.createServer((request, response) => {
			try {
				const url = new URL(request.url ?? "", redirectUri);
				if (url.pathname !== CALLBACK_PATH) {
					response.writeHead(404).end();
					return;
				}
				const returnedState = url.searchParams.get("state");
				if (returnedState !== state) {
					const message = "Authorization state did not match. Start the connection again.";
					response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					response.end(failureHtml(message));
					finish(new Error(message));
					return;
				}
				const denied = url.searchParams.get("error");
				const code = url.searchParams.get("code");
				if (denied || !code) {
					const message = denied ? `Google denied the request: ${denied}` : "No authorization code was received.";
					response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					response.end(failureHtml(message));
					finish(new Error(message));
					return;
				}
				response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				response.end(SUCCESS_HTML);
				finish(undefined, code);
			} catch (error) {
				finish(error instanceof Error ? error : new Error("OAuth callback failed."));
			}
		});
		const abort = (): void => finish(new Error("Google connection was cancelled."));
		const timeoutId = window.setTimeout(() => finish(new Error("Google connection timed out. Try connecting again.")), options.timeoutMs ?? CALLBACK_TIMEOUT_MS);
		function finish(error?: Error, code?: string): void {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeoutId);
			options.signal?.removeEventListener("abort", abort);
			server.close();
			if (error) reject(error);
			else if (code) resolve({ code, redirectUri });
			else reject(new Error("Google authorization ended without a code."));
		}
		server.once("error", (error) => finish(new Error(`Could not start the local OAuth callback: ${error.message}`)));
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) {
			abort();
			return;
		}
		server.listen(REDIRECT_PORT, "127.0.0.1", () => window.open(buildAuthUrl(clientId, redirectUri, state, codeChallenge)));
	});
}

export async function connectGoogleAccount(deps: AuthDeps, options: ConnectOptions = {}): Promise<void> {
	const account = googleAccount(deps);
	const clientSecret = getClientSecret(deps);
	if (!account.clientId || !clientSecret) throw new Error("Import Google desktop credentials or set a Client ID and secret first.");
	const state = randomUrlSafe(32);
	const verifier = randomUrlSafe(64);
	const challenge = await pkceChallenge(verifier);
	const { code, redirectUri } = await receiveAuthorizationCode(account.clientId, state, challenge, options);
	const response = await googleRequest({
		url: "https://oauth2.googleapis.com/token",
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		throw: false,
		body: new URLSearchParams({ code, client_id: account.clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }).toString(),
	});
	const payload: unknown = response.json;
	if (response.status >= 400) {
		const error = googleError(payload);
		throw new Error(error.description ?? error.code ?? "Google token exchange failed.");
	}
	const tokens = parseTokenPayload(payload, true);
	deps.secretStorage.setSecret(accountSecretKey(account.id, "access-token"), tokens.accessToken);
	deps.secretStorage.setSecret(accountSecretKey(account.id, "refresh-token"), tokens.refreshToken ?? "");
	account.tokenExpiresAt = Date.now() + tokens.expiresIn * 1000;
	await deps.saveSettings();
}

export async function disconnectGoogleAccount(deps: AuthDeps, revoke = true): Promise<boolean> {
	const refreshToken = clearGoogleAccountTokens(deps);
	await deps.saveSettings();
	return revoke ? revokeGoogleToken(refreshToken) : false;
}

async function refreshAccessToken(deps: AuthDeps): Promise<string> {
	const account = googleAccount(deps);
	const refreshToken = getAccountSecret(deps, account.id, "refresh-token");
	if (!refreshToken) throw new ReconnectRequiredError();
	const response = await googleRequest({
		url: "https://oauth2.googleapis.com/token",
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		throw: false,
		body: new URLSearchParams({ refresh_token: refreshToken, client_id: account.clientId, client_secret: getClientSecret(deps), grant_type: "refresh_token" }).toString(),
	});
	const payload: unknown = response.json;
	if (response.status >= 400) {
		const error = googleError(payload);
		if (error.code === "invalid_grant") {
			deps.secretStorage.setSecret(accountSecretKey(account.id, "access-token"), "");
			deps.secretStorage.setSecret(accountSecretKey(account.id, "refresh-token"), "");
			account.tokenExpiresAt = undefined;
			await deps.saveSettings();
			throw new ReconnectRequiredError();
		}
		throw new Error(error.description ?? error.code ?? "Failed to refresh Google access.");
	}
	const tokens = parseTokenPayload(payload, false);
	deps.secretStorage.setSecret(accountSecretKey(account.id, "access-token"), tokens.accessToken);
	account.tokenExpiresAt = Date.now() + tokens.expiresIn * 1000;
	await deps.saveSettings();
	return tokens.accessToken;
}

export async function getValidAccessToken(deps: AuthDeps): Promise<string> {
	const account = googleAccount(deps);
	if (account.tokenExpiresAt === undefined) throw new ReconnectRequiredError();
	if (Date.now() > account.tokenExpiresAt - 60_000) return refreshAccessToken(deps);
	const accessToken = getAccountSecret(deps, account.id, "access-token");
	if (!accessToken) throw new ReconnectRequiredError();
	return accessToken;
}

/** Migrates pre-profile secrets into the isolated default profile and removes plaintext copies. */
export function migrateLegacySecrets(secretStorage: SecretStorage, raw: Record<string, unknown>): boolean {
	let migrated = false;
	const move = (legacyKey: string, kind: "client-secret" | "access-token" | "refresh-token", explicit?: unknown): void => {
		const value = typeof explicit === "string" && explicit ? explicit : secretStorage.getSecret(legacyKey);
		if (!value) return;
		secretStorage.setSecret(accountSecretKey(LEGACY_GOOGLE_ACCOUNT_ID, kind), value);
		secretStorage.setSecret(legacyKey, "");
		migrated = true;
	};
	move(LEGACY_SECRET_CLIENT_SECRET, "client-secret", raw.googleClientSecret);
	delete raw.googleClientSecret;
	const legacyTokens = isRecord(raw.tokens) ? raw.tokens : undefined;
	move(LEGACY_SECRET_ACCESS_TOKEN, "access-token", legacyTokens?.accessToken);
	move(LEGACY_SECRET_REFRESH_TOKEN, "refresh-token", legacyTokens?.refreshToken);
	if (legacyTokens && typeof legacyTokens.expiresAt === "number") {
		raw.tokenExpiresAt = legacyTokens.expiresAt;
		migrated = true;
	}
	delete raw.tokens;
	return migrated;
}
