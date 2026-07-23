import { TFile } from "obsidian";

/** In-memory stand-in for Obsidian's Vault, covering the handful of methods dailyNote.ts uses. */
export class FakeVault {
	private contents = new Map<string, string>();
	private folders = new Set<string>();
	private nextCtime = 1;

	async create(path: string, content: string): Promise<TFile> {
		const file = new TFile();
		file.path = path;
		file.stat = { ctime: this.nextCtime++, mtime: this.nextCtime, size: content.length };
		this.contents.set(path, content);
		return file;
	}

	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}

	getAbstractFileByPath(path: string): TFile | null {
		if (!this.contents.has(path) && !this.folders.has(path)) return null;
		if (this.folders.has(path) && !this.contents.has(path)) return null;
		const file = new TFile();
		file.path = path;
		return file;
	}

	async read(file: TFile): Promise<string> {
		const content = this.contents.get(file.path);
		if (content === undefined) throw new Error(`FakeVault: no such file: ${file.path}`);
		return content;
	}

	async modify(file: TFile, content: string): Promise<void> {
		if (!this.contents.has(file.path)) {
			throw new Error(`FakeVault: no such file: ${file.path}`);
		}
		this.contents.set(file.path, content);
	}

	contentOf(path: string): string | undefined {
		return this.contents.get(path);
	}
}
