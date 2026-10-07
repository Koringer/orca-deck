// Generates the profiles the plugin manifest installs with the plugin, so a fresh machine needs no drag
// and drop:
// - profiles/orca-deck.streamDeckProfile: Stream Deck Neo, 8 "Worktree" keys + "Orca Infobar";
// - profiles/orca-deck-mobile.streamDeckProfile: Stream Deck Mobile (free 3 × 2 layout), "Orca Status"
//   top left (the infobar as a key) + 5 "Worktree" keys.
import { zipSync, strToU8 } from "fflate";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("dev.orcadeck.sdPlugin/manifest.json", "utf8"));
const plugin = { Name: manifest.Name, UUID: manifest.UUID, Version: manifest.Version };

/** Deterministic UUID so rebuilding the profile doesn't produce a diff. */
const uuid = (seed) => {
	const h = createHash("sha1").update(`orca-deck:${seed}`).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
};

const action = (uuid_, name, coord, states) => ({
	ActionID: uuid(`action:${uuid_}:${coord}`).toLowerCase(),
	LinkedTitle: true,
	Name: name,
	Plugin: plugin,
	Resources: null,
	Settings: {},
	State: 0,
	States: states,
	UUID: uuid_,
});

const keyState = { FontFamily: "", FontSize: 12, FontStyle: "", FontUnderline: false, OutlineThickness: 2, ShowTitle: false, TitleAlignment: "bottom", TitleColor: "#ffffff" };

function grid(columns, rows, special = {}) {
	const keys = {};
	for (let col = 0; col < columns; col++)
		for (let row = 0; row < rows; row++) {
			const coord = `${col},${row}`;
			const [uuid_, name] = special[coord] ?? ["dev.orcadeck.worktree", "Worktree"];
			keys[coord] = action(uuid_, name, coord, [keyState]);
		}
	return keys;
}

function profile({ file, seed, model, controllers }) {
	const profileId = uuid(`${seed}profile`);
	const pageId = uuid(`${seed}page`);
	const defaultPageId = uuid(`${seed}default-page`);
	const root = `Profiles/${profileId}.sdProfile`;
	const page = { Controllers: controllers, Icon: "", Name: "" };
	const emptyPage = { Controllers: controllers.map((c) => ({ Actions: {}, Type: c.Type })), Icon: "", Name: "" };
	const files = {
		"package.json": strToU8(
			JSON.stringify({ AppVersion: "7.6.0.0", DeviceModel: model, DeviceSettings: null, FormatVersion: 1, OSType: "macOS", OSVersion: "13.0", RequiredPlugins: [plugin.UUID] }),
		),
		[`${root}/manifest.json`]: strToU8(
			JSON.stringify({
				Device: { Model: model, UUID: "" },
				Name: "Orca Deck",
				Pages: { Current: pageId.toLowerCase(), Default: defaultPageId.toLowerCase(), Pages: [pageId.toLowerCase()] },
				Version: "3.0",
			}),
		),
		[`${root}/Profiles/${pageId}/manifest.json`]: strToU8(JSON.stringify(page)),
		[`${root}/Profiles/${defaultPageId}/manifest.json`]: strToU8(JSON.stringify(emptyPage)),
	};
	const out = `dev.orcadeck.sdPlugin/profiles/${file}.streamDeckProfile`;
	writeFileSync(out, zipSync(files, { mtime: new Date("2026-01-01") }));
	console.log(`profile: ${out}`);
}

mkdirSync("dev.orcadeck.sdPlugin/profiles", { recursive: true });

// Seeds kept as before for the Neo so its profile (and the ids the app already knows) doesn't change.
profile({
	file: "orca-deck",
	seed: "",
	model: "20GBJ9901",
	controllers: [
		{ Actions: { "1,0": action("dev.orcadeck.infobar", "Orca Infobar", "infobar", [{}]) }, Type: "Neo" },
		{ Actions: grid(4, 2), Type: "Keypad" },
	],
});

profile({
	file: "orca-deck-mobile",
	seed: "mobile:",
	model: "VSD/WiFi",
	controllers: [{ Actions: grid(3, 2, { "0,0": ["dev.orcadeck.status", "Orca Status"] }), Type: "Keypad" }],
});
