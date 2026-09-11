/** Throwaway examples; the optional local JSON contains a read-only Marketing snapshot. */
export type PrototypeString = {
	id: string;
	name: string | null;
	tags: string[];
	limit?: number;
	context?: string;
	values: { code: string; text: string; reviewed: boolean }[];
};
const description =
	"Turn the bricks you already have into your next idea.\n\nScan your collection and discover things you can build. Brickit recognises your pieces, suggests ideas, and shows you where each brick is hiding.\n\nBUILD WITH WHAT YOU HAVE\nA small collection can hold a surprising number of possibilities. Explore simple models and unexpected combinations, with step-by-step instructions to help you get started.\n\nMAKE IT YOUR OWN\nFollow an idea or change it along the way. Try another colour, add a new detail, or invent something completely different. There is no single right way to build.\n\nKEEP DISCOVERING\nReturn to your collection with fresh eyes. Find a quick activity for a quiet afternoon, or make something together with friends and family.";
const value = (text: string) => [
	{ code: "en-US", text, reviewed: true },
	{ code: "fr-FR", text: "", reviewed: false },
	{ code: "de-DE", text: "", reviewed: false },
];
export const exampleStrings: PrototypeString[] = [
	{
		id: "sample-title",
		name: "App Store / Title",
		tags: ["App Store"],
		limit: 30,
		values: value("Brickit: Your Brick Collection"),
	},
	{
		id: "sample-description",
		name: "App Store / Description",
		tags: ["App Store"],
		limit: 4000,
		values: value(description),
	},
	{
		id: "sample-subtitle",
		name: "App Store / Subtitle",
		tags: ["App Store"],
		limit: 30,
		values: value("Build new ideas with old bricks"),
	},
	{
		id: "sample-play",
		name: "Google Play / Short description",
		tags: ["Google Play"],
		limit: 80,
		values: value("Scan your bricks. Find your next idea."),
	},
	{
		id: "sample-shared",
		name: "Screenshot / Discover",
		tags: ["App Store", "Google Play", "Screenshots"],
		values: value("A whole world in your pile of bricks"),
	},
	{
		id: "sample-shared-2",
		name: "Screenshot / Build",
		tags: ["App Store", "Google Play", "Screenshots"],
		values: value("Make something you never imagined"),
	},
	{
		id: "sample-email",
		name: null,
		tags: [],
		values: value("Your next idea is already in your collection."),
	},
];
