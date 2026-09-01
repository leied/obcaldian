/**
 * Minimal runtime stand-in for the "obsidian" package, which ships types only
 * (no JS) since the real implementation lives inside the Obsidian app.
 * vitest.config.ts aliases "obsidian" to this file for tests.
 */

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\//, "")
		.replace(/\/$/, "");
}

export class TFile {
	path = "";
	stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder {
	path = "";
}

export const Platform = {
	isDesktop: true,
	isMobile: false,
	isDesktopApp: true,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: false,
	isWin: false,
	isLinux: true,
};

export const apiVersion = "test";

export class Notice {
	message: string;
	/** Every Notice created during a test run, for assertions. Reset with `Notice.instances = []`. */
	static instances: Notice[] = [];

	constructor(message: string) {
		this.message = message;
		Notice.instances.push(this);
	}
}

export function requestUrl(_opts: unknown): never {
	throw new Error("requestUrl has no test implementation; mock the calling module instead.");
}

export class SecretStorage {
	private store = new Map<string, string>();

	setSecret(id: string, secret: string): void {
		this.store.set(id, secret);
	}

	getSecret(id: string): string | null {
		return this.store.get(id) ?? null;
	}

	listSecrets(): string[] {
		return [...this.store.keys()];
	}
}
