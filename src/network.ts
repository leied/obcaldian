import { requestUrl } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

/**
 * Every production network destination is declared here. Keep this list small and auditable;
 * CI rejects direct requestUrl calls anywhere else in src/.
 */
export const ALLOWED_OUTBOUND_HOSTS = new Set([
	"accounts.google.com",
	"oauth2.googleapis.com",
	"www.googleapis.com",
]);

export interface RequestPolicy {
	maxAttempts?: number;
	signal?: AbortSignal;
}

export class GoogleHttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly retryAfterMs?: number
	) {
		super(`Google request failed with HTTP ${status}.`);
		this.name = "GoogleHttpError";
	}
}

export class ICalHttpError extends Error {
	constructor(public readonly status: number) {
		super(`iCalendar feed request failed with HTTP ${status}.`);
		this.name = "ICalHttpError";
	}
}

export function assertAllowedOutboundUrl(rawUrl: string): URL {
	const url = new URL(rawUrl);
	if (url.protocol !== "https:" || !ALLOWED_OUTBOUND_HOSTS.has(url.hostname)) {
		throw new Error(`Blocked outbound request to unapproved host: ${url.hostname || rawUrl}`);
	}
	return url;
}

/** Secret iCalendar feeds may use any user-selected host, but never plaintext HTTP or URL credentials. */
export function assertSafeICalUrl(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error("Enter a valid HTTPS Secret iCal URL.");
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error("Secret iCal URLs must use HTTPS and cannot contain username/password fields.");
	}
	return url;
}

export async function iCalRequest(
	request: RequestUrlParam | string,
	policy: RequestPolicy = {}
): Promise<RequestUrlResponse> {
	const rawUrl = typeof request === "string" ? request : request.url;
	assertSafeICalUrl(rawUrl);
	const requestParams: RequestUrlParam =
		typeof request === "string" ? { url: request, throw: false } : { ...request, throw: false };
	const maxAttempts = Math.max(1, Math.min(5, policy.maxAttempts ?? 3));
	let lastNetworkError: Error | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		if (policy.signal?.aborted) throw new Error("iCalendar request cancelled.");
		try {
			const response = await requestUrl(requestParams);
			const status = response.status ?? 200;
			if (status < 400) return response;
			if ((status === 429 || status >= 500) && attempt < maxAttempts) {
				await cancellableDelay(
					parseRetryAfter(response.headers?.["retry-after"]) ?? backoffMs(attempt),
					policy.signal,
					"iCalendar request cancelled."
				);
				continue;
			}
			throw new ICalHttpError(status);
		} catch (error) {
			if (error instanceof ICalHttpError) throw error;
			lastNetworkError = error instanceof Error ? error : new Error("iCalendar network request failed.");
			if (attempt < maxAttempts) {
				await cancellableDelay(backoffMs(attempt), policy.signal, "iCalendar request cancelled.");
				continue;
			}
		}
	}
	throw lastNetworkError ?? new Error("iCalendar network request failed.");
}

export async function googleRequest(
	request: RequestUrlParam | string,
	policy: RequestPolicy = {}
): Promise<RequestUrlResponse> {
	const rawUrl = typeof request === "string" ? request : request.url;
	assertAllowedOutboundUrl(rawUrl);
	const shouldReturnHttpErrors = typeof request !== "string" && request.throw === false;
	const requestParams: RequestUrlParam =
		typeof request === "string" ? { url: request, throw: false } : { ...request, throw: false };
	const maxAttempts = Math.max(1, Math.min(5, policy.maxAttempts ?? 3));
	let lastNetworkError: Error | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		if (policy.signal?.aborted) throw new Error("Google request cancelled.");
		try {
			const response = await requestUrl(requestParams);
			const status = response.status ?? 200;
			if (status < 400) return response;
			const retryAfterMs = parseRetryAfter(response.headers?.["retry-after"]);
			const retryable = status === 429 || status >= 500;
			if (retryable && attempt < maxAttempts) {
				await cancellableDelay(retryAfterMs ?? backoffMs(attempt), policy.signal, "Google request cancelled.");
				continue;
			}
			if (shouldReturnHttpErrors) return response;
			throw new GoogleHttpError(status, retryAfterMs);
		} catch (error) {
			if (error instanceof GoogleHttpError) throw error;
			lastNetworkError =
				error instanceof Error ? error : new Error("Google network request failed.");
			if (attempt < maxAttempts) {
				await cancellableDelay(backoffMs(attempt), policy.signal, "Google request cancelled.");
				continue;
			}
		}
	}
	throw lastNetworkError ?? new Error("Google network request failed.");
}

function parseRetryAfter(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 60_000)) : undefined;
}

function backoffMs(attempt: number): number {
	return Math.min(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250), 10_000);
}

function cancellableDelay(
	milliseconds: number,
	signal: AbortSignal | undefined,
	cancelMessage: string
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeoutId = window.setTimeout(finish, milliseconds);
		function finish(): void {
			signal?.removeEventListener("abort", cancel);
			resolve();
		}
		function cancel(): void {
			window.clearTimeout(timeoutId);
			signal?.removeEventListener("abort", cancel);
			reject(new Error(cancelMessage));
		}
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
	});
}
