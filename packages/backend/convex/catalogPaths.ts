import { ConvexError } from "convex/values";

/**
 * Check and tidy a repository-relative catalog file path for a Locale Binding.
 * Returns the tidied path; throws when it is not a path inside the repository.
 *
 * Deliberately strict, because a binding names a file the delivery command
 * will later write inside somebody's checkout: a path that escapes the
 * repository or points at an absolute location is refused when it is typed
 * rather than when it is used.
 *
 * `.` segments are dropped so that two spellings of one file — `lib/l10n/x.arb`
 * and `lib/./l10n/x.arb` — cannot be claimed by two different Locales.
 */
export function normalizeCatalogPath(input: string): string {
	const invalid = (reason: string): never => {
		throw new ConvexError({
			code: "VALIDATION",
			message: `Catalog path ${reason}.`,
		});
	};

	const raw = input.trim();
	if (raw.length === 0) invalid("cannot be empty");
	if (raw.startsWith("/")) invalid("must be relative to the repository root");
	if (raw.endsWith("/")) invalid("must name a file, not a directory");
	if (raw.includes("\\")) invalid("must use forward slashes");
	if (raw.includes("\0")) invalid("contains an invalid character");

	const segments = raw.split("/");
	if (segments.some((segment) => segment === "..")) {
		invalid("cannot point outside the repository");
	}
	if (segments.some((segment) => segment.length === 0)) {
		invalid("cannot contain an empty segment");
	}

	const path = segments.filter((segment) => segment !== ".").join("/");
	if (path.length === 0) invalid("must name a file");
	return path;
}
