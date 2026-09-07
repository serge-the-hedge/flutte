import { beforeEach, describe, expect, test } from "vitest";

import {
	authenticatedBackend,
	type Backend,
	createBackend,
	createProject,
} from "../test/support";
import { api } from "./_generated/api";

const CATALOG = "packages/brickit_generated/lib/l10n/intl_de.arb";

describe("locale binding", () => {
	let t: Backend;

	beforeEach(() => {
		t = createBackend();
	});

	async function projectWithLocale(userId = "owner") {
		const user = await authenticatedBackend(t, userId);
		const projectId = await createProject(user);
		const localeId = await user.mutation(api.locales.create, {
			projectId,
			code: "de",
			label: "German",
		});
		return { user, projectId, localeId };
	}

	test("binds a Locale to a catalog file and reads it back", async () => {
		const { user, projectId, localeId } = await projectWithLocale();
		await user.action(api.locales.bind, { localeId, catalogPath: CATALOG });

		const locales = await user.query(api.locales.list, { projectId });
		expect(locales.find((locale) => locale.code === "de")?.catalogPath).toBe(
			CATALOG,
		);
	});

	test("a binding can be changed later", async () => {
		const { user, projectId, localeId } = await projectWithLocale();
		await user.action(api.locales.bind, { localeId, catalogPath: CATALOG });
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: "lib/l10n/intl_de.arb",
		});

		const locales = await user.query(api.locales.list, { projectId });
		expect(locales.find((locale) => locale.code === "de")?.catalogPath).toBe(
			"lib/l10n/intl_de.arb",
		);
	});

	test("an unbound Locale is valid and carries no path", async () => {
		const { user, projectId } = await projectWithLocale();
		const locales = await user.query(api.locales.list, { projectId });
		expect(locales).toHaveLength(2);
		for (const locale of locales) {
			expect(locale.catalogPath).toBeUndefined();
		}
	});

	test("two Locales in one project cannot share a path", async () => {
		const { user, projectId, localeId } = await projectWithLocale();
		const other = await user.mutation(api.locales.create, {
			projectId,
			code: "fr",
			label: "French",
		});
		await user.action(api.locales.bind, { localeId, catalogPath: CATALOG });

		await expect(
			user.action(api.locales.bind, {
				localeId: other,
				catalogPath: CATALOG,
			}),
		).rejects.toThrow("already bound");
	});

	test("rebinding a Locale to the path it already has is not a conflict", async () => {
		const { user, localeId } = await projectWithLocale();
		await user.action(api.locales.bind, { localeId, catalogPath: CATALOG });
		await expect(
			user.action(api.locales.bind, { localeId, catalogPath: CATALOG }),
		).resolves.not.toThrow();
	});

	test("corrects a setup Locale code without losing its binding", async () => {
		const { user, projectId, localeId } = await projectWithLocale();
		await user.action(api.locales.bind, { localeId, catalogPath: CATALOG });

		const correctedId = await user.mutation(api.locales.correctSetupBinding, {
			localeId,
			code: "de-DE",
			label: "German (Germany)",
			catalogPath: CATALOG,
		});

		expect(correctedId).toBe(localeId);
		const locales = await user.query(api.locales.list, { projectId });
		expect(locales.find((locale) => locale._id === localeId)).toMatchObject({
			code: "de-DE",
			label: "German (Germany)",
			catalogPath: CATALOG,
		});
	});

	test("removes an empty duplicate while preserving the bound Locale history", async () => {
		const { user, projectId, localeId } = await projectWithLocale();
		await user.action(api.locales.bind, { localeId, catalogPath: CATALOG });
		await t.run(async (ctx) => {
			const timestamp = Date.now();
			const keyId = await ctx.db.insert("translationKeys", {
				projectId,
				key: "welcome",
				tagIds: [],
				icuType: "plain",
				placeholders: [],
				createdAt: timestamp,
				updatedAt: timestamp,
				searchText: "welcome",
			});
			await ctx.db.insert("translationValues", {
				projectId,
				keyId,
				localeId,
				value: "Willkommen",
				status: "translated",
				sourceVersion: 1,
				version: 1,
				updatedBy: { kind: "user", id: "owner" },
				updatedAt: timestamp,
			});
		});
		const accidentalLocaleId = await user.mutation(api.locales.create, {
			projectId,
			code: "de-DE",
			label: "German (Germany)",
		});

		const correctedId = await user.mutation(api.locales.correctSetupBinding, {
			localeId,
			code: "de-DE",
			label: "German (Germany)",
			catalogPath: CATALOG,
		});

		expect(correctedId).toBe(localeId);
		const active = await user.query(api.locales.list, { projectId });
		expect(active.map((locale) => locale.code)).toEqual(["en", "de-DE"]);
		expect(active.find((locale) => locale._id === localeId)?.catalogPath).toBe(
			CATALOG,
		);
		const all = await user.query(api.locales.list, {
			projectId,
			includeArchived: true,
		});
		expect(all.find((locale) => locale._id === accidentalLocaleId)).toBe(
			undefined,
		);
		const retainedValue = await t.run(async (ctx) =>
			ctx.db
				.query("translationValues")
				.withIndex("by_locale", (q) => q.eq("localeId", localeId))
				.first(),
		);
		expect(retainedValue?.value).toBe("Willkommen");
	});

	test("refuses to correct a Locale code after snapshot evidence exists", async () => {
		const { user, projectId, localeId } = await projectWithLocale();
		await user.action(api.locales.bind, { localeId, catalogPath: CATALOG });
		await t.run(async (ctx) => {
			await ctx.db.insert("sourceSnapshots", {
				projectId,
				repository: "github.com/brickit-app/brickit-flutter",
				commit: "baseline",
				manifestHash: "sha256:baseline",
				kind: "baseline",
				createdBy: { kind: "repositoryAdapter", id: "test" },
				createdAt: Date.now(),
			});
		});

		await expect(
			user.mutation(api.locales.correctSetupBinding, {
				localeId,
				code: "de-DE",
				label: "German (Germany)",
				catalogPath: CATALOG,
			}),
		).rejects.toThrow("before the first Source Snapshot");
	});

	test("the same path is free in a different project", async () => {
		const { user, localeId } = await projectWithLocale();
		await user.action(api.locales.bind, { localeId, catalogPath: CATALOG });

		const second = await createProject(user, {
			name: "Second",
			slug: "second-project",
		});
		const secondLocale = await user.mutation(api.locales.create, {
			projectId: second,
			code: "de",
			label: "German",
		});
		await expect(
			user.action(api.locales.bind, {
				localeId: secondLocale,
				catalogPath: CATALOG,
			}),
		).resolves.not.toThrow();
	});

	test("refuses a path that escapes the repository", async () => {
		// The path rules themselves are covered as a pure function; this only
		// establishes that the mutation applies them.
		const { user, localeId } = await projectWithLocale();
		await expect(
			user.action(api.locales.bind, { localeId, catalogPath: "/etc/passwd" }),
		).rejects.toThrow("Catalog path");
	});

	test("stores the tidied path, not the one that was typed", async () => {
		const { user, projectId, localeId } = await projectWithLocale();
		await user.action(api.locales.bind, {
			localeId,
			catalogPath: "./lib/./l10n/intl_de.arb",
		});

		const locales = await user.query(api.locales.list, { projectId });
		expect(locales.find((locale) => locale.code === "de")?.catalogPath).toBe(
			"lib/l10n/intl_de.arb",
		);
	});

	test("archiving does not release a path for another Locale to take", async () => {
		// This one rule is what keeps the revive path safe too. `create`
		// revives an archived Locale by clearing archivedAt without revisiting
		// its binding, so if archiving released the path, another Locale could
		// be holding it by the time the first came back — two live Locales on
		// one file. Because the claim survives archiving, that cannot arise,
		// which is why it needs no separate test.
		const { user, projectId, localeId } = await projectWithLocale();
		await user.action(api.locales.bind, { localeId, catalogPath: CATALOG });
		await user.mutation(api.locales.archive, { localeId });

		const french = await user.mutation(api.locales.create, {
			projectId,
			code: "fr",
			label: "French",
		});
		await expect(
			user.action(api.locales.bind, {
				localeId: french,
				catalogPath: CATALOG,
			}),
		).rejects.toThrow("already bound");
	});

	test("someone outside the project cannot bind", async () => {
		const { localeId } = await projectWithLocale();
		const outsider = await authenticatedBackend(t, "outsider");
		await expect(
			outsider.action(api.locales.bind, { localeId, catalogPath: CATALOG }),
		).rejects.toThrow();
	});
});
