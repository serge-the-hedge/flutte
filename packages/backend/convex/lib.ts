export type Role = "owner" | "editor" | "viewer";
export type Actor = {
	kind: "user" | "agent" | "system" | "repositoryAdapter";
	id: string;
};
export const tokenScopeValidator = v.union(
	v.literal("read"),
	v.literal("review"),
	v.literal("search"),
	v.literal("propose"),
	v.literal("dictionary-write"),
	v.literal("export"),
	v.literal("snapshot-submission"),
);
export type TokenScope = Infer<typeof tokenScopeValidator>;

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

import { type Infer, v } from "convex/values";

/** Repository membership is independent of a Locale being available to managed content. */
export function isRepositoryLocale(locale: {
	isSource: boolean;
	catalogPath?: string;
	archivedAt?: number;
}): boolean {
	return (
		locale.archivedAt === undefined &&
		(locale.isSource || locale.catalogPath !== undefined)
	);
}
