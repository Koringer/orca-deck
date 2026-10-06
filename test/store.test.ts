import assert from "node:assert/strict";
import { test } from "node:test";

import type { OrcaPsRow } from "../src/orca/model.ts";
import { OrcaStore, type GlobalSettings } from "../src/orca/store.ts";

function fakeOrca(rows: () => OrcaPsRow[]) {
	const calls: string[][] = [];
	const cli = {
		run: async <T,>(args: string[]): Promise<T> => {
			calls.push(args);
			const cmd = args.slice(0, 2).join(" ");
			if (cmd === "worktree ps") return { worktrees: rows() } as T;
			if (cmd === "terminal list") return { terminals: [{ handle: "term_1", connected: true, worktreeId: "r::/w/a" }] } as T;
			return {} as T;
		},
	};
	return { cli, calls };
}

const row = (state: string, startedAt: number): OrcaPsRow => ({
	worktreeId: "r::/w/a",
	repoId: "r",
	repo: "app",
	path: "/w/a",
	branch: "refs/heads/a",
	agents: [{ state, agentType: "claude", stateStartedAt: startedAt }],
});

test("pressing a done worktree turns it idle until its agent changes state", async () => {
	let current = row("done", 100);
	const { cli } = fakeOrca(() => [current]);
	let saved: GlobalSettings = {};
	const store = new OrcaStore(cli, (s) => (saved = s));
	store.registerSlot(0);
	await store.refresh();
	const status = () => {
		const s = store.slot(0);
		return s.kind === "worktree" ? s.view.status : "empty";
	};

	assert.equal(status(), "done");
	await store.focusWorktree(0);
	assert.equal(status(), "idle");
	await store.refresh();
	assert.equal(status(), "idle", "stays idle across polls");
	assert.deepEqual(saved.seen, { "r::/w/a": 100 });

	current = row("working", 200);
	await store.refresh();
	assert.equal(status(), "working");

	current = row("done", 300);
	await store.refresh();
	assert.equal(status(), "done", "a new completion shows as done again");
});
