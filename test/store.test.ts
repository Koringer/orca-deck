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
			if (cmd === "worktree create") return { worktree: { id: "r::/w/new" } } as T;
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

test("full deck: a new worktree takes the least recently active idle key, busy ones are never displaced", async () => {
	const mk = (n: number, state: string | null, created: number, activity: number): OrcaPsRow => ({
		worktreeId: `r::/w/${n}`,
		repoId: "r",
		repo: "app",
		path: `/w/${n}`,
		branch: `refs/heads/w${n}`,
		createdAt: created,
		lastActivityAt: activity,
		agents: state ? [{ state, stateStartedAt: activity }] : [],
	});
	let rows = [mk(1, "working", 1, 50), mk(2, null, 2, 10), mk(3, null, 3, 5)];
	const { cli } = fakeOrca(() => rows);
	const store = new OrcaStore(cli, () => {});
	for (let i = 0; i < 3; i++) store.registerSlot(i);
	await store.refresh();
	const ids = () => [0, 1, 2].map((i) => {
		const s = store.slot(i);
		return s.kind === "worktree" ? s.view.id.slice(-1) : "+";
	});
	const before = ids();
	assert.deepEqual([...before].sort(), ["1", "2", "3"]);

	// New worktree from Orca: takes the key of idle #3 (activity 5 < 10), not the working one.
	rows = [...rows, mk(4, "working", 4, 60)];
	await store.refresh();
	assert.deepEqual(ids(), before.map((id) => (id === "3" ? "4" : id)));
	assert.equal(store.hiddenCount(), 1);

	// The evicted idle worktree doesn't bounce back onto another idle key.
	await store.refresh();
	assert.equal(store.hiddenCount(), 1);
	assert.ok(!ids().includes("3"));

	// All keys busy: nothing is displaced.
	rows = rows.map((r) => (r.worktreeId.endsWith("2") ? mk(2, "working", 2, 70) : r)).concat(mk(5, "working", 5, 80));
	await store.refresh();
	assert.ok(!ids().includes("5"));
	assert.equal(store.hiddenCount(), 2);
});

test("full deck: a just-created worktree (agent not started yet) still gets a key", async () => {
	const mk = (n: number, activity: number): OrcaPsRow => ({
		worktreeId: `r::/w/${n}`, repoId: "r", repo: "app", path: `/w/${n}`, branch: `refs/heads/w${n}`, createdAt: n, lastActivityAt: activity, agents: [],
	});
	let rows = [mk(1, 20), mk(2, 10)];
	const { cli } = fakeOrca(() => rows);
	const store = new OrcaStore(cli, () => {});
	store.registerSlot(0);
	store.registerSlot(1);
	await store.refresh();
	rows = [...rows, mk(3, 30)];
	await store.refresh();
	const shown = [0, 1].map((i) => {
		const s = store.slot(i);
		return s.kind === "worktree" ? s.view.id.slice(-1) : "+";
	});
	assert.deepEqual(shown.sort(), ["1", "3"]);
});

test("long press takes the worktree off the deck without deleting it, and starts a new one on the key", async () => {
	const old: OrcaPsRow = { ...row("done", 100), createdAt: 1 };
	let rows: OrcaPsRow[] = [old];
	const { cli, calls } = fakeOrca(() => rows);
	const store = new OrcaStore(cli, () => {});
	store.registerSlot(0);
	await store.refresh();

	rows = [old, { ...row("working", 500), worktreeId: "r::/w/new", path: "/w/new", createdAt: 2 }];
	await store.replaceSlot(0);
	assert.ok(!calls.some((c) => c[0] === "worktree" && c[1] === "rm"), "never deletes in Orca");
	assert.ok(calls.some((c) => c[0] === "worktree" && c[1] === "create" && c.includes("id:r")));
	const s = store.slot(0);
	assert.equal(s.kind === "worktree" ? s.view.id : null, "r::/w/new");
	assert.equal(store.hiddenCount(), 0, "a dismissed worktree isn't counted as waiting for a key");

	// It comes back when its agent changes state (here: a key frees up).
	rows = [{ ...old, agents: [{ state: "waiting", agentType: "claude", stateStartedAt: 900 }] }];
	await store.refresh();
	const back = store.slot(0);
	assert.equal(back.kind === "worktree" ? back.view.id : null, "r::/w/a");
});

test("a failing poll is logged once, not on every poll", async () => {
	const logs: string[] = [];
	const cli = {
		run: async <T,>(args: string[]): Promise<T> => {
			if (args[0] === "terminal") throw new Error("Orca is not running");
			return { worktrees: [] } as T;
		},
	};
	const store = new OrcaStore(cli, () => {}, (m) => logs.push(m));
	for (let i = 0; i < 5; i++) await store.refresh();
	assert.equal(logs.filter((l) => l.startsWith("terminal list failed")).length, 1);
});
