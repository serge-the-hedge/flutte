import type { CatalogValueScope } from "./strings-catalog-navigation";

export type StringsSearch = {
	/** Old collection links resolve to their promoted project; new URLs omit this. */
	collection?: string;
	cursor?: string;
	locales?: string[];
	after?: number;
	q?: string;
	key?: string;
	scope?: CatalogValueScope;
	release?: string;
};
