import streamDeck from "@elgato/streamdeck";

import { OrcaInfobar } from "./actions/infobar.ts";
import { StatusKey } from "./actions/status-key.ts";
import { WorktreeKey } from "./actions/worktree-key.ts";
import { OrcaCli, resolveOrcaBinary } from "./orca/cli.ts";
import { OrcaStore, type GlobalSettings } from "./orca/store.ts";

const TICK_MS = 100;

const logger = streamDeck.logger;
let binary: string | null = null;
let binaryFor: string | undefined | null = null;

const store = new OrcaStore(
	new OrcaCli(() => {
		// Re-resolve when the configured path changes or Orca gets installed later.
		if (binary === null || binaryFor !== store.orcaPath) {
			binaryFor = store.orcaPath;
			binary = resolveOrcaBinary(store.orcaPath);
			logger.info(`orca CLI: ${binary ?? "not found"}`);
		}
		return binary;
	}, (args) => logger.info(`orca ${args.join(" ")}`)),
	(s) => void streamDeck.settings.setGlobalSettings(s),
	(msg) => logger.warn(msg),
);

const keys = new WorktreeKey(store, (e) => logger.error(String(e)));
const infobar = new OrcaInfobar(store);
const status = new StatusKey(store, (e) => logger.error(String(e)));

streamDeck.actions.registerAction(keys);
streamDeck.actions.registerAction(infobar);
streamDeck.actions.registerAction(status);

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => store.applySettings(ev.settings));

await streamDeck.connect();
store.applySettings(await streamDeck.settings.getGlobalSettings<GlobalSettings>());
store.start();

setInterval(() => {
	const now = Date.now();
	keys.tick(now);
	infobar.tick(now);
	status.tick(now);
}, TICK_MS);
