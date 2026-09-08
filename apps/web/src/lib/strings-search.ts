import type { CatalogValueScope } from "./strings-catalog-navigation";

export type StringsSearch = {
	collection?: string;
	cursor?: string;
	locales?: string[];
	after?: number;
	q?: string;
	key?: string;
	scope?: CatalogValueScope;
	release?: string;
};
