import { describe, expect, test } from "vitest";
import {
	authenticatedBackend,
	createBackend,
	createProject,
} from "../test/support";
import { api, internal } from "./_generated/api";
import { preparePromotedProjectGuidance } from "./dictionaries";
import { readGuidance } from "./translationGuidance";

const term = {
	kind: "untranslatable" as const,
	sourceTerm: "Brickit",
	definition: "Keep product spelling.",
};
async function setup() {
	const t = createBackend({ transactionLimits: true });
	const owner = await authenticatedBackend(t, "dictionary-shared-owner");
	const member = await authenticatedBackend(t, "dictionary-project-member");
	const outsider = await authenticatedBackend(t, "dictionary-outsider");
	const projectId = await createProject(owner);
	await owner.mutation(api.projects.addMember, {
		projectId,
		userId: "dictionary-project-member",
		role: "editor",
	});
	const dictionaryId = await owner.mutation(api.dictionaries.create, {
		name: "Product terms",
	});
	await owner.mutation(api.dictionaries.connect, {
		projectId,
		dictionaryId,
		expectedConnectionRevision: 0,
	});
	return { t, owner, member, outsider, projectId, dictionaryId };
}
describe("reusable Dictionaries", () => {
	test("rejects a delayed agent-write grant after reconnecting the same Dictionary", async () => {
		const f = await setup();
		const delayed = {
			dictionaryId: f.dictionaryId,
			projectId: f.projectId,
			enabled: true,
			expectedConnectionRevision: 1,
		};
		await f.owner.mutation(api.dictionaries.connect, {
			projectId: f.projectId,
			dictionaryId: null,
			expectedConnectionRevision: 1,
		});
		await f.owner.mutation(api.dictionaries.connect, {
			projectId: f.projectId,
			dictionaryId: f.dictionaryId,
			expectedConnectionRevision: 2,
		});
		await expect(
			f.owner.mutation(api.dictionaries.setConnectionWrites, delayed),
		).rejects.toThrow("connection changed");
		expect(
			await f.owner.query(api.dictionaries.projectConnection, {
				projectId: f.projectId,
			}),
		).toMatchObject({ connectionRevision: 3, agentWriteEnabled: false });
		await f.owner.mutation(api.dictionaries.setConnectionWrites, {
			...delayed,
			expectedConnectionRevision: 3,
		});
		expect(
			await f.owner.query(api.dictionaries.projectConnection, {
				projectId: f.projectId,
			}),
		).toMatchObject({ connectionRevision: 4, agentWriteEnabled: true });
	});

	test("promotion copies independent voice citations only for relevant languages without creating an empty Dictionary", async () => {
		const t = createBackend({ transactionLimits: true });
		const owner = await authenticatedBackend(t, "voice-promoter");
		const sourceProjectId = await createProject(owner);
		const destinationProjectId = await createProject(owner, {
			slug: "voice-destination",
		});
		for (const code of ["de", "fr"])
			await owner.mutation(api.locales.create, {
				projectId: sourceProjectId,
				code,
			});
		const sourceVoice = await owner.mutation(
			api.translationGuidance.saveProjectVoiceGuide,
			{
				projectId: sourceProjectId,
				expectedRevision: 0,
				text: "Clear and friendly",
				examples: [],
			},
		);
		await owner.mutation(api.translationGuidance.saveVoiceGuide, {
			projectId: sourceProjectId,
			expectedRevision: 1,
			localeCode: "de",
			text: "Use du",
			examples: [],
		});
		await owner.mutation(api.translationGuidance.saveVoiceGuide, {
			projectId: sourceProjectId,
			expectedRevision: 2,
			localeCode: "fr",
			text: "Use tu",
			examples: [],
		});
		expect(
			await t.run((ctx) =>
				preparePromotedProjectGuidance(ctx, {
					sourceProjectId,
					destinationProjectId,
					userId: "voice-promoter",
					localeCodes: ["de"],
				}),
			),
		).toEqual({ dictionaryId: null });
		const copied = await owner.query(api.translationGuidance.list, {
			projectId: destinationProjectId,
		});
		expect(copied.projectGuide?.text).toBe("Clear and friendly");
		expect(copied.projectGuide?.revisionId).not.toBe(sourceVoice.revisionId);
		expect(copied.guides.map((g) => g.localeCode)).toEqual(["de"]);
		expect(await owner.query(api.dictionaries.list, {})).toEqual([]);
	});

	test("new typed projects require a connected Dictionary before authoring terms", async () => {
		const t = createBackend({ transactionLimits: true });
		const owner = await authenticatedBackend(t, "typed-dictionary-owner");
		const projectId = await owner.mutation(api.projects.create, {
			name: "Basic",
			slug: "basic",
			type: "basic",
			sourceLocaleCode: "en",
			sourceLocaleLabel: "English",
		});
		await expect(
			owner.mutation(api.translationGuidance.saveTerm, {
				projectId,
				expectedRevision: 0,
				term,
			}),
		).rejects.toThrow("Connect a Dictionary first");
		const dictionaryId = await owner.mutation(
			api.dictionaries.promoteProjectTerms,
			{ projectId, name: "Reusable", expectedRevision: 0 },
		);
		await owner.mutation(api.dictionaries.saveTerm, {
			dictionaryId,
			expectedRevision: 0,
			term,
		});
		expect(
			(await owner.query(api.translationGuidance.list, { projectId })).terms[0]
				?.term,
		).toEqual(term);
	});

	test("discovers linked Dictionaries only through active projects and reserves connection changes for project owners", async () => {
		const f = await setup();
		expect(await f.member.query(api.dictionaries.list, {})).toMatchObject([
			{ _id: f.dictionaryId, canEdit: false },
		]);
		await expect(
			f.member.mutation(api.dictionaries.connect, {
				projectId: f.projectId,
				dictionaryId: null,
				expectedConnectionRevision: 1,
			}),
		).rejects.toThrow("permissions");
		await f.owner.mutation(api.projects.archive, { projectId: f.projectId });
		expect(await f.member.query(api.dictionaries.list, {})).toEqual([]);
		await expect(
			f.member.query(api.dictionaries.detail, { dictionaryId: f.dictionaryId }),
		).rejects.toThrow("access required");
		expect(
			(
				await f.owner.query(api.dictionaries.detail, {
					dictionaryId: f.dictionaryId,
				})
			).canEdit,
		).toBe(true);
	});

	test("connected readers see shared terms but cannot edit or inspect other projects", async () => {
		const f = await setup();
		await f.owner.mutation(api.dictionaries.saveTerm, {
			dictionaryId: f.dictionaryId,
			expectedRevision: 0,
			term,
		});
		const read = await f.member.query(api.dictionaries.detail, {
			dictionaryId: f.dictionaryId,
		});
		expect(read.terms[0]?.term).toEqual(term);
		expect(read.canEdit).toBe(false);
		expect(read.editors).toEqual([]);
		expect(read.connections).toEqual([]);
		await expect(
			f.member.mutation(api.dictionaries.saveTerm, {
				dictionaryId: f.dictionaryId,
				expectedRevision: 1,
				term: { ...term, definition: "Wrong" },
			}),
		).rejects.toThrow("owner or editor");
		await expect(
			f.member.mutation(api.translationGuidance.saveTerm, {
				projectId: f.projectId,
				expectedRevision: 1,
				term,
			}),
		).rejects.toThrow("owner or editor");
		await expect(
			f.outsider.query(api.dictionaries.detail, {
				dictionaryId: f.dictionaryId,
			}),
		).rejects.toThrow("access required");
		await f.owner.mutation(api.dictionaries.setEditor, {
			dictionaryId: f.dictionaryId,
			email: "dictionary-project-member@example.test",
			enabled: true,
		});
		expect(
			(
				await f.member.query(api.dictionaries.detail, {
					dictionaryId: f.dictionaryId,
				})
			).canEdit,
		).toBe(true);
	});
	test("project agents require a Dictionary-side grant and fresh connection identity", async () => {
		const f = await setup();
		const token = await f.owner.mutation(api.apiTokens.create, {
			projectId: f.projectId,
			name: "Dictionary writer",
			scopes: ["read", "dictionary-write"],
		});
		const initial = await f.t.query(internal.agentDictionary.list, {
			token: token.token,
		});
		expect(initial).toMatchObject({
			dictionaryId: f.dictionaryId,
			connectionRevision: 1,
			revision: 0,
			agentWriteEnabled: false,
		});
		const input = {
			token: token.token,
			expectedRevision: 0,
			expectedDictionaryId: f.dictionaryId,
			expectedConnectionRevision: 1,
			terms: [term],
		};
		await expect(
			f.t.mutation(internal.agentDictionary.save, input),
		).rejects.toThrow("not granted");
		await f.owner.mutation(api.dictionaries.setConnectionWrites, {
			dictionaryId: f.dictionaryId,
			projectId: f.projectId,
			enabled: true,
			expectedConnectionRevision: 1,
		});
		await expect(
			f.t.mutation(internal.agentDictionary.save, input),
		).rejects.toThrow("connection revision");
		await f.t.mutation(internal.agentDictionary.save, {
			...input,
			expectedConnectionRevision: 2,
		});
		const before = await f.t.run((ctx) =>
			readGuidance(ctx, f.projectId, {
				texts: ["Brickit"],
				localeCodes: [],
				syntax: "plain",
			}),
		);
		await f.owner.mutation(api.dictionaries.saveTerm, {
			dictionaryId: f.dictionaryId,
			expectedRevision: 1,
			term: { ...term, definition: "Updated spelling guidance" },
		});
		const after = await f.t.run((ctx) =>
			readGuidance(ctx, f.projectId, {
				texts: ["Brickit"],
				localeCodes: [],
				syntax: "plain",
			}),
		);
		expect(after.dictionary?.revision).not.toBe(before.dictionary?.revision);
		expect(after.terms[0]?.term.definition).toBe("Updated spelling guidance");
		await f.owner.mutation(api.dictionaries.connect, {
			projectId: f.projectId,
			dictionaryId: null,
			expectedConnectionRevision: 2,
		});
		await expect(
			f.t.mutation(internal.agentDictionary.save, {
				...input,
				expectedConnectionRevision: 2,
				expectedRevision: 2,
			}),
		).rejects.toThrow("connection changed");
	});
	test("promotion preserves term citation IDs without sharing private voice history", async () => {
		const t = createBackend({ transactionLimits: true });
		const owner = await authenticatedBackend(t, "legacy-dictionary-owner");
		const source = await createProject(owner);
		const destination = await createProject(owner, { slug: "destination" });
		const old = await owner.mutation(api.translationGuidance.saveTerm, {
			projectId: source,
			expectedRevision: 0,
			term,
		});
		const voice = await owner.mutation(
			api.translationGuidance.saveProjectVoiceGuide,
			{
				projectId: source,
				expectedRevision: 1,
				text: "Private source voice",
				examples: [],
			},
		);
		const dictionaryId = await owner.mutation(
			api.dictionaries.promoteProjectTerms,
			{ projectId: source, expectedRevision: 2, name: "Shared" },
		);
		await owner.mutation(api.dictionaries.connect, {
			projectId: destination,
			dictionaryId,
			expectedConnectionRevision: 0,
		});
		const shared = await owner.query(api.translationGuidance.list, {
			projectId: destination,
		});
		expect(shared.terms[0]?.revisionId).toBe(old.revisionId);
		expect(shared.projectGuide).toBeNull();
		if (!old.revisionId || !voice.revisionId) throw Error("missing citations");
		expect(
			(
				await owner.query(api.translationGuidance.getRevision, {
					projectId: destination,
					revisionId: old.revisionId,
				})
			).content,
		).toMatchObject({ kind: "term" });
		await expect(
			owner.query(api.translationGuidance.getRevision, {
				projectId: destination,
				revisionId: voice.revisionId,
			}),
		).rejects.toThrow("not found");
		expect(
			(
				await owner.query(api.dictionaries.legacyProjectTerms, {
					projectId: source,
				})
			).terms,
		).toEqual([]);
		await owner.mutation(api.dictionaries.connect, {
			projectId: source,
			dictionaryId: null,
			expectedConnectionRevision: 1,
		});
		const local = await owner.query(api.dictionaries.legacyProjectTerms, {
			projectId: source,
		});
		const future = await owner.mutation(api.translationGuidance.saveTerm, {
			projectId: source,
			expectedRevision: local.revision,
			term: { ...term, definition: "Future private local term" },
		});
		if (!future.revisionId) throw Error("missing citation");
		await expect(
			owner.query(api.translationGuidance.getRevision, {
				projectId: destination,
				revisionId: future.revisionId,
			}),
		).rejects.toThrow("not found");

		const other = await owner.mutation(api.dictionaries.create, {
			name: "Unrelated",
		});
		const otherTerm = await owner.mutation(api.dictionaries.saveTerm, {
			dictionaryId: other,
			expectedRevision: 0,
			term,
		});
		if (!otherTerm.revisionId) throw Error("missing citation");
		await expect(
			owner.query(api.translationGuidance.getRevision, {
				projectId: destination,
				revisionId: otherTerm.revisionId,
			}),
		).rejects.toThrow("not found");
	});
	test("standalone terms accept canonical languages independently of connected project languages", async () => {
		const f = await setup();
		await f.owner.mutation(api.dictionaries.saveTerm, {
			dictionaryId: f.dictionaryId,
			expectedRevision: 0,
			term: {
				kind: "translated",
				sourceTerm: "Build",
				definition: "Assemble pieces",
				renderings: [{ localeCode: "ja", value: "作る" }],
			},
		});
		expect(
			(
				await f.owner.query(api.dictionaries.detail, {
					dictionaryId: f.dictionaryId,
				})
			).terms,
		).toHaveLength(1);
		await expect(
			f.owner.mutation(api.dictionaries.saveTerm, {
				dictionaryId: f.dictionaryId,
				expectedRevision: 1,
				term: {
					kind: "translated",
					sourceTerm: "Bad",
					definition: "Bad",
					renderings: [{ localeCode: "pt_BR", value: "x" }],
				},
			}),
		).rejects.toThrow("canonical");
	});
});
