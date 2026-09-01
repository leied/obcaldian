import { SecretStorage } from "obsidian";
import { describe, expect, it } from "vitest";
import {
	clearGoogleAccountTokens,
	getClientSecret,
	isConnected,
	migrateLegacySecrets,
	parseGoogleCredentialsJson,
	setClientSecret,
	type AuthDeps,
} from "../src/googleAuth";
import { DEFAULT_SETTINGS } from "../src/settings";

const ACCOUNT_ID = "test-account";

function makeDeps(tokenExpiresAt?: number): AuthDeps {
	return {
		settings: {
			...DEFAULT_SETTINGS,
			googleAccounts: [{
				id: ACCOUNT_ID,
				name: "Test account",
				clientId: "client",
				projectId: "project",
				tokenExpiresAt,
				calendars: [],
				calendarHealth: {},
				calendarCaches: {},
			}],
		},
		saveSettings: async () => {},
		secretStorage: new SecretStorage(),
		accountId: ACCOUNT_ID,
	};
}

describe("client secret storage", () => {
	it("round-trips through secret storage rather than settings", () => {
		const deps = makeDeps();
		expect(getClientSecret(deps)).toBe("");
		setClientSecret(deps, "shh-its-a-secret");
		expect(getClientSecret(deps)).toBe("shh-its-a-secret");
		expect(deps.settings).not.toHaveProperty("googleClientSecret");
	});

	it("isolates secrets between account profiles", () => {
		const first = makeDeps();
		first.settings.googleAccounts.push({
			id: "second-account",
			name: "Second",
			clientId: "client-2",
			projectId: "project-2",
			calendars: [],
			calendarHealth: {},
			calendarCaches: {},
		});
		const second = { ...first, accountId: "second-account" };
		setClientSecret(first, "first-secret");
		setClientSecret(second, "second-secret");
		expect(getClientSecret(first)).toBe("first-secret");
		expect(getClientSecret(second)).toBe("second-secret");
	});
});

describe("isConnected", () => {
	it("is false with no tokens at all", () => {
		expect(isConnected(makeDeps())).toBe(false);
	});

	it("is false with an expiry recorded but no refresh token in secret storage", () => {
		expect(isConnected(makeDeps(Date.now() + 3600_000))).toBe(false);
	});

	it("is true once both a refresh token and an expiry are present", () => {
		const deps = makeDeps(Date.now() + 3600_000);
		deps.secretStorage.setSecret(`dailycalsync-google-${ACCOUNT_ID}-refresh-token`, "refresh-token-value");
		expect(isConnected(deps)).toBe(true);
	});
});

describe("local token removal", () => {
	it("clears tokens synchronously and returns the refresh token for background revocation", () => {
		const deps = makeDeps(Date.now() + 3600_000);
		deps.secretStorage.setSecret(`dailycalsync-google-${ACCOUNT_ID}-access-token`, "access-token-value");
		deps.secretStorage.setSecret(`dailycalsync-google-${ACCOUNT_ID}-refresh-token`, "refresh-token-value");

		expect(clearGoogleAccountTokens(deps)).toBe("refresh-token-value");
		expect(deps.secretStorage.getSecret(`dailycalsync-google-${ACCOUNT_ID}-access-token`)).toBe("");
		expect(deps.secretStorage.getSecret(`dailycalsync-google-${ACCOUNT_ID}-refresh-token`)).toBe("");
		expect(deps.settings.googleAccounts[0].tokenExpiresAt).toBeUndefined();
	});
});

describe("migrateLegacySecrets", () => {
	it("moves a legacy plaintext client secret into secret storage and strips it from raw", () => {
		const storage = new SecretStorage();
		const raw: Record<string, unknown> = { googleClientSecret: "legacy-secret" };
		const migrated = migrateLegacySecrets(storage, raw);
		expect(migrated).toBe(true);
		expect(storage.getSecret("dailycalsync-google-default-google-client-secret")).toBe("legacy-secret");
		expect(raw).not.toHaveProperty("googleClientSecret");
	});

	it("moves legacy tokens into secret storage and lifts expiresAt into tokenExpiresAt", () => {
		const storage = new SecretStorage();
		const raw: Record<string, unknown> = {
			tokens: {
				accessToken: "access-123",
				refreshToken: "refresh-456",
				expiresAt: 1_700_000_000_000,
			},
		};
		const migrated = migrateLegacySecrets(storage, raw);
		expect(migrated).toBe(true);
		expect(storage.getSecret("dailycalsync-google-default-google-access-token")).toBe("access-123");
		expect(storage.getSecret("dailycalsync-google-default-google-refresh-token")).toBe("refresh-456");
		expect(raw.tokenExpiresAt).toBe(1_700_000_000_000);
		expect(raw).not.toHaveProperty("tokens");
	});

	it("is a no-op on already-migrated data", () => {
		const storage = new SecretStorage();
		const raw: Record<string, unknown> = { googleClientId: "abc", tokenExpiresAt: 123 };
		const migrated = migrateLegacySecrets(storage, raw);
		expect(migrated).toBe(false);
		expect(raw).toEqual({ googleClientId: "abc", tokenExpiresAt: 123 });
	});
});

describe("Google credentials JSON import", () => {
	it("accepts an installed desktop client and exposes only the needed identity", () => {
		expect(
			parseGoogleCredentialsJson(
				JSON.stringify({
					installed: {
						client_id: "client.apps.googleusercontent.com",
						client_secret: "secret",
						project_id: "my-project",
						auth_uri: "https://accounts.google.com/o/oauth2/auth",
						token_uri: "https://oauth2.googleapis.com/token",
					},
				})
			)
		).toEqual({
			clientId: "client.apps.googleusercontent.com",
			clientSecret: "secret",
			projectId: "my-project",
		});
	});

	it("rejects web credentials and unexpected token endpoints", () => {
		expect(() => parseGoogleCredentialsJson(JSON.stringify({ web: {} }))).toThrow(/Desktop app/i);
		expect(() =>
			parseGoogleCredentialsJson(
				JSON.stringify({
					installed: {
						client_id: "client",
						client_secret: "secret",
						project_id: "project",
						token_uri: "https://example.com/token",
						},
					})
				)
		).toThrow(/unexpected OAuth endpoints/i);
	});
});
