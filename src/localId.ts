/**
 * Keeps derived Obsidian SecretStorage identifiers within its 64-character limit.
 * The longest Google secret key adds 34 characters around this local ID.
 */
const MAX_LOCAL_ID_LENGTH = 30;

export function createLocalId(prefix: string): string {
	const random = window.crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return `${prefix}-${random.toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, MAX_LOCAL_ID_LENGTH);
}
