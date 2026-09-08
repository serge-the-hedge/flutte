import { expect, test } from "bun:test";
import { ConvexError } from "convex/values";
import {
	advanceWindowBatches,
	type CatalogWindowBatch,
	initialWindowBatches,
	windowBatchKey,
} from "./catalog-window-requests";
import { convexId } from "./convex-api";

const tooLarge = new ConvexError({ code: "WINDOW_TOO_LARGE" });
test("splits keys before locales, then stops at one key and one locale", () => {
	const batch: CatalogWindowBatch = {
		messageIds: ["a", "b"],
		localeIds: [convexId<"locales">("de"), convexId<"locales">("fr")],
		started: true,
	};
	const first = advanceWindowBatches([batch], {
		[windowBatchKey(batch)]: tooLarge,
	});
	expect(first?.map((batch) => batch.messageIds)).toEqual([["a"], ["b"]]);
	const single = first?.[0];
	if (!single) throw new Error("Expected split");
	const second = advanceWindowBatches([single], {
		[windowBatchKey(single)]: tooLarge,
	});
	expect(second?.map((batch) => batch.localeIds?.map(String))).toEqual([
		["de"],
		["fr"],
	]);
	const leaf = second?.[0];
	if (!leaf) throw new Error("Expected leaf");
	expect(() =>
		advanceWindowBatches([leaf], { [windowBatchKey(leaf)]: tooLarge }),
	).toThrow(tooLarge);
});
test("preserves unexpected errors", () => {
	const batch: CatalogWindowBatch = { messageIds: ["a"], started: true };
	const error = new ConvexError({ code: "STALE_BASIS" });
	expect(() =>
		advanceWindowBatches([batch], { [windowBatchKey(batch)]: error }),
	).toThrow(error);
});

test("partitions both request dimensions before subscribing", () => {
	const batches = initialWindowBatches({
		projectId: convexId<"projects">("project"),
		expectedProjectionId: convexId<"catalogProjections">("projection"),
		messageIds: Array.from({ length: 33 }, (_, index) => String(index)),
		localeIds: Array.from({ length: 9 }, (_, index) =>
			convexId<"locales">(String(index)),
		),
	});
	expect(
		batches.map((batch) => [batch.messageIds.length, batch.localeIds?.length]),
	).toEqual([
		[32, 4],
		[32, 4],
		[32, 1],
		[1, 4],
		[1, 4],
		[1, 1],
	]);
	expect(batches.filter((batch) => batch.started)).toHaveLength(4);
});
