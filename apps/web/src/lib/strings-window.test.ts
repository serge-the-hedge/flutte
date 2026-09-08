import { describe, expect, test } from "bun:test";

import {
	collectStringsWindowMessageIds,
	createStringsWindowCardCache,
	estimateStringsCardHeight,
	quantizeStringsWindowBounds,
	StringsCardMeasurementCache,
	sameStringsWindowMessageIds,
	stringsWindowKeyCap,
	updateStringsWindowCardCache,
	WINDOW_KEY_CAP,
} from "./strings-window";

function card(id: string) {
	return {
		id,
		source: {
			localeCode: "en",
			isSource: true,
			value: id,
			materialized: false,
		},
		targets: [],
	};
}

describe("quantizeStringsWindowBounds", () => {
	test("keeps a full rolling window around the visible range", () => {
		expect(quantizeStringsWindowBounds(5, 11, 200, WINDOW_KEY_CAP)).toEqual({
			start: 0,
			end: 32,
		});
		expect(quantizeStringsWindowBounds(21, 30, 200, WINDOW_KEY_CAP)).toEqual({
			start: 8,
			end: 40,
		});
	});

	test("stays inside the catalog and covers small ranges", () => {
		expect(quantizeStringsWindowBounds(0, 3, 10, WINDOW_KEY_CAP)).toEqual({
			start: 0,
			end: 10,
		});
		expect(quantizeStringsWindowBounds(190, 196, 193, WINDOW_KEY_CAP)).toEqual({
			start: 161,
			end: 193,
		});
	});
});

describe("Strings window transitions", () => {
	test("does not publish an unchanged Window request again", () => {
		expect(
			sameStringsWindowMessageIds(["key_8", "key_9"], ["key_8", "key_9"]),
		).toBe(true);
		expect(
			sameStringsWindowMessageIds(["key_8", "key_9"], ["key_9", "key_10"]),
		).toBe(false);
	});

	test("keeps hydrated overlap while the next Window is pending", () => {
		const first = updateStringsWindowCardCache(createStringsWindowCardCache(), {
			projectionId: "projection_1",
			cards: new Map([
				["key_0", card("key_0")],
				["key_1", card("key_1")],
				["key_2", card("key_2")],
			]),
			maxCards: 4,
		});

		const pending = updateStringsWindowCardCache(first, {
			projectionId: "projection_1",
			cards: undefined,
			maxCards: 4,
		});

		expect(pending).toBe(first);
		expect([...pending.cards.keys()]).toEqual(["key_0", "key_1", "key_2"]);

		const advanced = updateStringsWindowCardCache(pending, {
			projectionId: "projection_1",
			cards: new Map([
				["key_2", card("key_2")],
				["key_3", card("key_3")],
				["key_4", card("key_4")],
			]),
			maxCards: 4,
		});
		expect([...advanced.cards.keys()]).toEqual([
			"key_1",
			"key_2",
			"key_3",
			"key_4",
		]);

		const nextProjection = updateStringsWindowCardCache(advanced, {
			projectionId: "projection_2",
			cards: undefined,
			maxCards: 4,
		});
		expect(nextProjection.cards.size).toBe(0);
	});
});

describe("collectStringsWindowMessageIds", () => {
	const ordered = Array.from({ length: 40 }, (_, index) => `key_${index}`);

	test("collects the aligned slice plus deduplicated extras", () => {
		const ids = collectStringsWindowMessageIds({
			orderedMessageIds: ordered,
			bounds: { start: 0, end: 8 },
			extraMessageIds: ["key_3", "key_20", "key_20"],
			cap: WINDOW_KEY_CAP,
		});
		expect(ids.slice(0, 8)).toEqual(ordered.slice(0, 8));
		expect(ids).toContain("key_20");
		expect(ids.filter((id) => id === "key_20")).toHaveLength(1);
	});

	test("drops extras outside the catalog and respects the cap", () => {
		const ids = collectStringsWindowMessageIds({
			orderedMessageIds: ordered,
			bounds: { start: 0, end: 30 },
			extraMessageIds: ["unknown_key", "key_38"],
			cap: 32,
		});
		expect(ids).not.toContain("unknown_key");
		expect(ids.length).toBeLessThanOrEqual(32);
		expect(ids).toContain("key_38");
	});

	test("reserves room for focus outside a full rolling window", () => {
		const ids = collectStringsWindowMessageIds({
			orderedMessageIds: ordered,
			bounds: { start: 0, end: 32 },
			extraMessageIds: ["key_3", "key_38"],
			cap: WINDOW_KEY_CAP,
		});
		expect(ids).toHaveLength(WINDOW_KEY_CAP);
		expect(ids).toContain("key_3");
		expect(ids).toContain("key_38");
	});
});

describe("StringsCardMeasurementCache", () => {
	test("keys heights by projection and message identifier", () => {
		const cache = new StringsCardMeasurementCache();
		expect(cache.estimate("p1", "greeting", 208)).toBe(208);
		cache.record("p1", "greeting", 312);
		expect(cache.estimate("p1", "greeting", 208)).toBe(312);
		expect(cache.estimate("p2", "greeting", 208)).toBe(208);
		cache.clear();
		expect(cache.estimate("p1", "greeting", 208)).toBe(208);
	});
});

test("wide language windows hydrate the actual visible key at every stride", () => {
	expect([0, 4, 8, 24, 100, 1000].map(stringsWindowKeyCap)).toEqual([
		32, 32, 16, 5, 1, 1,
	]);
	const ordered = Array.from({ length: 40 }, (_, i) => `key_${i}`);
	for (const targets of [24, 100])
		for (let visible = 0; visible < 40; visible++) {
			const cap = stringsWindowKeyCap(targets);
			const bounds = quantizeStringsWindowBounds(visible, visible + 1, 40, cap);
			const ids = collectStringsWindowMessageIds({
				orderedMessageIds: ordered,
				bounds,
				visibleBounds: { start: visible, end: visible + 1 },
				extraMessageIds: ["key_0"],
				cap,
			});
			expect(ids).toContain(`key_${visible}`);
			expect(ids.length).toBeLessThanOrEqual(cap);
		}
	expect(estimateStringsCardHeight(100)).toBeGreaterThan(3000);
	expect(estimateStringsCardHeight(100)).toBeGreaterThan(
		estimateStringsCardHeight(4),
	);
});

test("removes suppressed requested cards while retaining unrelated lookahead", () => {
	const initial = updateStringsWindowCardCache(createStringsWindowCardCache(), {
		projectionId: "projection",
		maxCards: 4,
		cards: new Map(
			["suppressed", "retained", "lookahead"].map((id) => [id, card(id)]),
		),
	});
	const requestedMessageIds = ["suppressed", "retained"];
	expect(
		updateStringsWindowCardCache(initial, {
			projectionId: "projection",
			maxCards: 4,
			cards: undefined,
			requestedMessageIds,
		}),
	).toBe(initial);
	const result = updateStringsWindowCardCache(initial, {
		projectionId: "projection",
		maxCards: 4,
		requestedMessageIds,
		cards: new Map([["retained", card("retained")]]),
	});
	expect(result.cards.has("suppressed")).toBe(false);
	expect([...result.cards.keys()]).toEqual(["lookahead", "retained"]);
});
