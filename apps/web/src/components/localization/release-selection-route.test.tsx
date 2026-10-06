import { afterAll, expect, spyOn, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { act } from "react";
import type { ReleaseSummary } from "@/components/localization/release-record-view";
import { convexId } from "@/lib/convex-api";
import type {} from "@/main";
import { Route } from "@/routes/projects.$projectId.release";
import { createDomTest } from "@/test/dom";

const dom = createDomTest();
const client = new ConvexReactClient("https://example.convex.cloud");
const record: ReleaseSummary = {
	recordId: convexId<"releaseRecords">("frozen-record"),
	projectionId: convexId<"catalogProjections">("projection"),
	snapshotId: convexId<"sourceSnapshots">("snapshot"),
	commit: "baseline",
	navigationRevision: 1,
	selectedMessageIds: ["frozen_message"],
	excludedMessageIds: [],
	status: "ready",
	posture: "ready",
	progress: { cursor: 1, expectedKeyCount: 2 },
	deltaKeyCount: 1,
	changedKeyCount: 1,
	changedValueCount: 1,
	scopeValueCount: 1,
	blockedCount: 0,
	needsDecisionCount: 0,
	intentionalBlankCount: 0,
	sourceIdenticalCount: 0,
	unconfirmedImportCount: 0,
	localeSummaries: [],
	failure: null,
	createdAt: 1,
	completedAt: 2,
};
const results: Record<string, unknown> = {
	"projects:get": { type: "repository", name: "Project", role: "editor" },
	"releaseRecords:current": {
		kind: "available",
		canPrepare: true,
		basisCurrent: false,
		historyCursor: "",
		current: record,
	},
	"releaseRecords:history": { records: [], continueCursor: "", isDone: true },
	"releaseRecords:evidence": { page: [], continueCursor: "", isDone: true },
	"releaseRecords:changes": { page: [], continueCursor: "", isDone: true },
	"releaseBundles:forRecord": { status: "ready", changeKeyCount: 1 },
	"localeIntroductionTargets:list": [],
};
const watch = spyOn(client, "watchQuery").mockImplementation(
	(query, _args) => ({
		onUpdate: () => () => {},
		localQueryResult: () => results[getFunctionName(query)] as never,
		localQueryLogs: () => [],
		journal: () => undefined,
	}),
);
const calls: unknown[] = [];
const mutate = spyOn(client, "mutation").mockImplementation(
	async (_query, args) => {
		calls.push(args);
		return record;
	},
);
afterAll(async () => {
	watch.mockRestore();
	mutate.mockRestore();
	await client.close();
});

test("URL navigation and reload keep the exact draft; stale refresh preserves the frozen record's scope", async () => {
	const root = createRootRoute({
		component: () => (
			<ConvexProvider client={client}>
				<Outlet />
			</ConvexProvider>
		),
	});
	const standaloneRouteOptions = {
		...Route.options,
		id: "/projects/$projectId/release",
		path: "/projects/$projectId/release",
		getParentRoute: () => root,
	};
	const release = Route.update(standaloneRouteOptions);
	const history = createMemoryHistory({
		initialEntries: [
			"/projects/project/release?selectedMessages=%5B%22first_message%22%5D",
		],
	});
	const router = createRouter({
		routeTree: root.addChildren([release]),
		history,
	});
	await dom.render(<RouterProvider router={router} />);
	const prepare = () =>
		[...dom.container.querySelectorAll("button")].find(
			(button) => button.textContent === "Prepare with this selection",
		);
	const refresh = () =>
		[...dom.container.querySelectorAll("button")].find(
			(button) => button.textContent === "Refresh this report’s selection",
		);
	expect(dom.container.textContent).toContain("first_message");
	expect(dom.container.textContent).toContain("frozen_message");
	expect(dom.container.textContent).toContain(
		"Prepare this selection to update the report",
	);
	await act(async () => {
		await router.navigate({
			to: "/projects/$projectId/release",
			params: { projectId: "project" },
			search: { selectedMessages: ["next_message"] },
		});
	});
	expect(dom.container.textContent).toContain("next_message");
	expect(dom.container.textContent).not.toContain("first_message");
	await act(async () => {
		history.back();
		await router.load();
	});
	expect(dom.container.textContent).toContain("first_message");
	await act(async () => {
		await router.load();
	});
	await act(async () => prepare()?.click());
	expect(calls.at(-1)).toEqual({
		projectId: "project",
		selectedMessageIds: ["first_message"],
	});
	await act(async () => refresh()?.click());
	expect(calls.at(-1)).toEqual({
		projectId: "project",
		selectedMessageIds: ["frozen_message"],
	});
	await act(async () => {
		await router.navigate({
			to: "/projects/$projectId/release",
			params: { projectId: "project" },
			search: { selectedMessages: [] },
		});
	});
	expect(prepare()?.disabled).toBe(true);
	const count = calls.length;
	await act(async () => prepare()?.click());
	expect(calls).toHaveLength(count);
});
