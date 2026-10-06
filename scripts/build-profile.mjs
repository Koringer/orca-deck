// Generates dev.orcadeck.sdPlugin/profiles/orca-deck.streamDeckProfile: a Stream Deck Neo page with
// the 8 keys set to "Worktree" and the infobar set to "Orca Infobar". The plugin manifest installs it
// with the plugin and switches the Neo to it, so a fresh machine needs no drag and drop.
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
const keys = {};
for (let col = 0; col < 4; col++) for (let row = 0; row < 2; row++) keys[`${col},${row}`] = action("dev.orcadeck.worktree", "Worktree", `${col},${row}`, [keyState]);

const profileId = uuid("profile");
const pageId = uuid("page");
const defaultPageId = uuid("default-page");
const root = `Profiles/${profileId}.sdProfile`;

const page = {
	Controllers: [
		{ Actions: { "1,0": action("dev.orcadeck.infobar", "Orca Infobar", "infobar", [{}]) }, Type: "Neo" },
		{ Actions: keys, Type: "Keypad" },
	],
	Icon: "",
	Name: "",
};
const emptyPage = { Controllers: [{ Actions: {}, Type: "Keypad" }, { Actions: {}, Type: "Neo" }], Icon: "", Name: "" };

const files = {
	"package.json": strToU8(
		JSON.stringify({ AppVersion: "7.6.0.0", DeviceModel: "20GBJ9901", DeviceSettings: null, FormatVersion: 1, OSType: "macOS", OSVersion: "13.0", RequiredPlugins: [plugin.UUID] }),
	),
	[`${root}/manifest.json`]: strToU8(
		JSON.stringify({
			Device: { Model: "20GBJ9901", UUID: "" },
			Name: "Orca Deck",
			Pages: { Current: pageId.toLowerCase(), Default: defaultPageId.toLowerCase(), Pages: [pageId.toLowerCase()] },
			Version: "3.0",
		}),
	),
	[`${root}/Profiles/${pageId}/manifest.json`]: strToU8(JSON.stringify(page)),
	[`${root}/Profiles/${defaultPageId}/manifest.json`]: strToU8(JSON.stringify(emptyPage)),
};

mkdirSync("dev.orcadeck.sdPlugin/profiles", { recursive: true });
writeFileSync("dev.orcadeck.sdPlugin/profiles/orca-deck.streamDeckProfile", zipSync(files, { mtime: new Date("2026-01-01") }));
console.log("profile: dev.orcadeck.sdPlugin/profiles/orca-deck.streamDeckProfile");
