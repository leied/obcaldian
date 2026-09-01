import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalId } from "../src/localId";

afterEach(() => vi.unstubAllGlobals());

describe("createLocalId", () => {
	it("keeps every derived Google SecretStorage ID within Obsidian's limit", () => {
		vi.stubGlobal("window", {
			crypto: { randomUUID: () => "12345678-1234-1234-1234-123456789abc" },
		});
		const accountId = createLocalId("google");
		expect(accountId).toMatch(/^[a-z0-9-]+$/);
		expect(accountId.length).toBeLessThanOrEqual(30);
		expect(`dailycalsync-google-${accountId}-refresh-token`.length).toBeLessThanOrEqual(64);
	});
});
