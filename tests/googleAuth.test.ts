import { SecretStorage } from "obsidian";
import { describe, expect, it } from "vitest";
import {
	getClientSecret,
	isConnected,
	migrateLegacySecrets,
	setClientSecret,
	type AuthDeps,
} from "../src/googleAuth";
import { DEFAULT_SETTINGS } from "../src/settings";

function makeDeps(overrides: Partial<AuthDeps["settings"]> = {}): AuthDeps {
	return {
		settings: { ...DEFAULT_SETTINGS, ...overrides },
		saveSettings: async () => {},
		secretStorage: new SecretStorage(),
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
});

describe("isConnected", () => {
	it("is false with no tokens at all", () => {
		expect(isConnected(makeDeps())).toBe(false);
	});

	it("is false with an expiry recorded but no refresh token in secret storage", () => {
		expect(isConnected(makeDeps({ tokenExpiresAt: Date.now() + 3600_000 }))).toBe(false);
	});

	it("is true once both a refresh token and an expiry are present", () => {
		const deps = makeDeps({ tokenExpiresAt: Date.now() + 3600_000 });
		deps.secretStorage.setSecret("obcaldian-google-refresh-token", "refresh-token-value");
		expect(isConnected(deps)).toBe(true);
	});
});

describe("migrateLegacySecrets", () => {
	it("moves a legacy plaintext client secret into secret storage and strips it from raw", () => {
		const storage = new SecretStorage();
		const raw: Record<string, unknown> = { googleClientSecret: "legacy-secret" };
		const migrated = migrateLegacySecrets(storage, raw);
		expect(migrated).toBe(true);
		expect(storage.getSecret("obcaldian-google-client-secret")).toBe("legacy-secret");
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
		expect(storage.getSecret("obcaldian-google-access-token")).toBe("access-123");
		expect(storage.getSecret("obcaldian-google-refresh-token")).toBe("refresh-456");
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
