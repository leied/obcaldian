import { requestUrl } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertAllowedOutboundUrl, googleRequest } from "../src/network";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<typeof import("obsidian")>()),
	requestUrl: vi.fn(),
}));

beforeEach(() => {
	vi.mocked(requestUrl).mockReset();
	window.setTimeout = setTimeout as typeof window.setTimeout;
	window.clearTimeout = clearTimeout as typeof window.clearTimeout;
});

describe("outbound host policy", () => {
	it("allows only approved HTTPS Google hosts", () => {
		expect(assertAllowedOutboundUrl("https://www.googleapis.com/calendar/v3").hostname).toBe(
			"www.googleapis.com"
		);
		expect(() => assertAllowedOutboundUrl("https://example.com/collect")).toThrow(/unapproved/i);
		expect(() => assertAllowedOutboundUrl("http://www.googleapis.com/calendar")).toThrow(
			/unapproved/i
		);
	});

	it("retries a quota response and honors a zero Retry-After", async () => {
		vi.mocked(requestUrl)
			.mockResolvedValueOnce({ status: 429, headers: { "retry-after": "0" } } as never)
			.mockResolvedValueOnce({ status: 200, headers: {}, json: { ok: true } } as never);
		await expect(
			googleRequest("https://www.googleapis.com/calendar/v3/users/me/calendarList")
		).resolves.toEqual(expect.objectContaining({ status: 200 }));
		expect(requestUrl).toHaveBeenCalledTimes(2);
	});

	it("stops before a request when already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			googleRequest("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
				signal: controller.signal,
			})
		).rejects.toThrow(/cancelled/i);
		expect(requestUrl).not.toHaveBeenCalled();
	});
});
