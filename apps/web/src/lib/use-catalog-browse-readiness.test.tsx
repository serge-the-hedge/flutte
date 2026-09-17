import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { type FunctionReturnType, getFunctionName } from "convex/server";
import { act } from "react";
import { toast } from "sonner";
import { createDomTest } from "../test/dom";
import { api, convexId } from "./convex-api";
import { useCatalogBrowseReadiness } from "./use-catalog-browse-readiness";

type Readiness = FunctionReturnType<typeof api.catalogBrowse.readiness>;
const ready = (
	optimizationNeeded = false,
	projection = "projection",
): Extract<Readiness, { kind: "ready" }> => ({
	kind: "ready",
	projectionId: convexId<"catalogProjections">(projection),
	repository: "example/app",
	commit: "commit",
	snapshotId: null,
	canEdit: true,
	keyCount: 100,
	classificationRevision: 4,
	classificationGeneration:
		convexId<"catalogBrowseStates">("browse-generation"),
	optimizationNeeded,
	revision: undefined,
	ordinaryImports: {
		policy: "ordinary-v1",
		total: 0,
		eligible: 0,
		empty: 0,
		sourceIdentical: 0,
		repeated: 0,
		modified: 0,
		stale: 0,
		alreadyConfirmed: 0,
		pendingSourceProposal: 0,
		introduced: 0,
		run: null,
	},
});

describe("Strings catalog readiness", () => {
	const dom = createDomTest();
	const client = new ConvexReactClient("https://example.convex.cloud");
	const readinessName = getFunctionName(api.catalogBrowse.readiness);
	const overviewName = getFunctionName(api.catalogBrowse.overview);
	const responses = new Map<string, Readiness>();
	const listeners = new Map<string, Set<() => void>>();
	const watch = spyOn(client, "watchQuery").mockImplementation(
		(query, _args) => {
			const name = getFunctionName(query);
			return {
				onUpdate(callback) {
					const active = listeners.get(name) ?? new Set<() => void>();
					active.add(callback);
					listeners.set(name, active);
					return () => {
						active.delete(callback);
					};
				},
				localQueryResult: () => responses.get(name) as never,
				localQueryLogs: () => [],
				journal: () => undefined,
			};
		},
	);
	const prepare = spyOn(client, "mutation").mockImplementation(
		async () => null as never,
	);
	const reportError = spyOn(toast, "error").mockImplementation(() => "toast");
	beforeEach(() => {
		responses.clear();
		responses.set(readinessName, ready());
		responses.set(overviewName, { ...ready(), revision: 42 });
		listeners.clear();
		watch.mockClear();
		prepare.mockClear();
		reportError.mockClear();
	});
	afterAll(async () => {
		watch.mockRestore();
		prepare.mockRestore();
		reportError.mockRestore();
		await client.close();
	});
	function Harness({ q }: { q?: string }) {
		const { overview, contentRevision } = useCatalogBrowseReadiness(
			convexId<"projects">("project"),
			q,
		);
		return (
			<output>
				{overview?.kind}:{contentRevision ?? "no content subscription"}
			</output>
		);
	}
	const view = (q?: string, key = "session") => (
		<ConvexProvider client={client}>
			<Harness key={key} q={q} />
		</ConvexProvider>
	);
	async function publish(response: Readiness) {
		await act(async () => {
			responses.set(readinessName, response);
			for (const listener of listeners.get(readinessName) ?? []) listener();
		});
	}

	test("ordinary browsing avoids the hot content subscription; text search attaches it only while needed", async () => {
		await dom.render(view());
		expect(dom.container.textContent).toBe("ready:no content subscription");
		expect(listeners.get(overviewName)?.size ?? 0).toBe(0);
		await dom.render(view("Welcome"));
		expect(dom.container.textContent).toBe("ready:42");
		expect(listeners.get(overviewName)?.size).toBe(1);
		await dom.render(view("   "));
		expect(listeners.get(overviewName)?.size).toBe(0);
		expect(prepare).not.toHaveBeenCalled();
	});

	test("prepares old catalogs automatically without withholding ready editing or rerunning on content changes", async () => {
		responses.set(readinessName, ready(true));
		await dom.render(view());
		expect(dom.container.textContent).toBe("ready:no content subscription");
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(prepare.mock.calls[0]?.[1]).toEqual({ projectId: "project" });
		await publish({ ...ready(true), revision: 2 });
		await publish({ ...ready(true), revision: 3 });
		expect(prepare).toHaveBeenCalledTimes(1);
		await publish(ready(false));
		await publish(ready(true, "new-generation"));
		expect(prepare).toHaveBeenCalledTimes(2);
	});

	test("reports preparation failure once, keeps browsing usable, and retries on reopening", async () => {
		responses.set(readinessName, ready(true));
		prepare.mockRejectedValueOnce(new Error("Service unavailable"));
		await dom.render(view());
		expect(reportError).toHaveBeenCalledTimes(1);
		expect(dom.container.textContent).toBe("ready:no content subscription");
		await dom.render(view());
		expect(prepare).toHaveBeenCalledTimes(1);
		await dom.render(view(undefined, "reopened"));
		expect(prepare).toHaveBeenCalledTimes(2);
	});
});
