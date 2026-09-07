export type Role = "owner" | "editor" | "viewer";
export type Actor = {
	kind: "user" | "agent" | "system" | "repositoryAdapter";
	id: string;
};
export type TokenScope =
	| "read"
	| "search"
	| "propose"
	| "export"
	| "snapshot-submission";

export const DEFAULT_INTEGRATION_BRANCH = "develop";

export function slugify(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

export function normalizeLocaleCode(input: string): string {
	const parts = input.trim().replaceAll("_", "-").split("-").filter(Boolean);
	return parts
		.map((part, index) =>
			index === 0 ? part.toLowerCase() : part.toUpperCase(),
		)
		.join("-");
}

export function now(): number {
	return Date.now();
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
