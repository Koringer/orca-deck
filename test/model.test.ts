import assert from "node:assert/strict";
import { test } from "node:test";

import { orchestrators, toView, type OrcaPsRow } from "../src/orca/model.ts";
import { renderInfobar } from "../src/render/infobar.ts";
import { renderKey, wrap } from "../src/render/key.ts";
import { renderStatus } from "../src/render/status.ts";
import { breathe, marquee } from "../src/render/theme.ts";

const row = (over: Partial<OrcaPsRow> = {}): OrcaPsRow => ({
	worktreeId: "repo1::/w/fix-login",
	repoId: "repo1",
	repo: "shop",
	path: "/w/fix-login",
	branch: "jeremie/fix-login",
	status: "inactive",
	agents: [],
	...over,
});

test("status priority: input beats working beats done", () => {
	const v = toView(
		row({
			agents: [
				{ state: "done", agentType: "codex" },
				{ state: "working", agentType: "claude", stateStartedAt: 5 },
				{ state: "waiting", agentType: "claude", stateStartedAt: 9 },
			],
		}),
	);
	assert.equal(v.status, "input");
	assert.equal(v.since, 9);
});

test("monitoring background tasks is its own status, not input", () => {
	assert.equal(toView(row({ agents: [{ state: "working", workingMode: "monitoring" }] })).status, "background");
	assert.equal(toView(row({ status: "working", workingMode: "monitoring" })).status, "background");
	assert.equal(toView(row({ agents: [{ state: "working", workingMode: "monitoring" }, { state: "waiting" }] })).status, "input");
	assert.equal(toView(row({ agents: [{ state: "working" }] })).status, "working");
});

test("row status fallback and review", () => {
	assert.equal(toView(row({ status: "working" })).status, "working");
	assert.equal(toView(row({ status: "inactive", workspaceStatus: "in-review" })).status, "review");
	assert.equal(toView(row({ agents: [{ state: "failed" }] })).status, "error");
	assert.equal(toView(row({ agents: [{ state: "done", interrupted: true }] })).status, "error");
});

test("name: user name, renamed branch, prompt, then generated name", () => {
	const generated = { path: "/w/BWHG", displayName: "BWHG", branch: "refs/heads/Koringer/BWHG" };
	assert.equal(toView(row(generated)).name, "BWHG");
	assert.equal(toView(row({ ...generated, displayName: "Login bug" })).name, "Login bug");
	assert.equal(toView(row({ ...generated, branch: "refs/heads/Koringer/fix-login-redirect" })).name, "fix-login-redirect");
	assert.equal(toView(row(generated), "✳ Ca va").name, "Ca va");
	assert.equal(toView(row(generated), "⠂ Fix login redirect").name, "Fix login redirect");
	assert.equal(toView(row({ ...generated, displayName: "Login bug" }), "✳ Ca va").name, "Login bug");
	const deck = { path: "/w/task-1006-143205", displayName: "task-1006-143205", branch: "refs/heads/Koringer/task-1006-143205" };
	assert.equal(toView(row(deck), "✳ Add tests").name, "Add tests");
	const long = toView(row(generated), "✳ Investigate the flaky checkout tests on CI and fix them").name;
	assert.equal(long.length, 28);
	assert.ok(long.endsWith("…"));
});

test("wrap and marquee", () => {
	assert.deepEqual(wrap("fix-login", 9, 2), ["fix-login"]);
	assert.deepEqual(wrap("checkout-pricing", 9, 2), ["checkout-", "pricing"]);
	assert.equal(wrap("a-very-long-worktree-name-here", 9, 2), null);
	assert.deepEqual(wrap("Fix login redirect loop", 10, 3), ["Fix login", "redirect", "loop"]);
	assert.deepEqual(wrap("Internationalization", 10, 3), ["Internatio", "nalization"]);
	assert.equal(marquee("short", 9, 0), "short");
	assert.equal(marquee("abcdefghijkl", 5, 0).length, 5);
});

test("breathe stays in range and idle is static", () => {
	for (let t = 0; t < 3000; t += 37) {
		const o = breathe(t, 1000);
		assert.ok(o >= 0 && o <= 1);
	}
	assert.equal(breathe(123, null), 0, "static statuses keep the base (thin) border");
});

test("renders every key state as valid-looking SVG", () => {
	const view = toView(row({ agents: [{ state: "working", agentType: "claude", stateStartedAt: 0 }] }));
	const frames = [
		renderKey({ connection: "ok", slot: { kind: "worktree", view }, now: 200_000, hold: null }),
		renderKey({ connection: "ok", slot: { kind: "worktree", view }, now: 1, hold: 0.5 }),
		renderKey({ connection: "ok", slot: { kind: "empty" }, now: 1, hold: null }),
		renderKey({ connection: "ok", slot: { kind: "empty", pending: { kind: "awaiting", at: 0, until: 9e15 } }, now: 1, hold: null }),
		renderKey({ connection: "offline", slot: { kind: "empty" }, now: 1, hold: null }),
	];
	for (const svg of frames) assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
	assert.match(frames[0], /WORKING/);
	assert.doesNotMatch(frames[0], /claude · /);
	assert.match(frames[2], />\+</);
});

test("infobar: line 1 status counters, line 2 always usage", () => {
	const view = toView(row({ comment: "tests green", agents: [{ state: "working", agentType: "claude", toolName: "Edit" }] }));
	const usage = { provider: "claude", session: { usedPercent: 72, resetsAt: null }, weekly: { usedPercent: 12, resetsAt: null } };
	const rest = renderInfobar({ connection: "ok", views: [view], hidden: 0, usage, now: 0 });
	assert.equal(rest.u1b.value, 72);
	assert.equal(rest.u1p.value, "72%");
	assert.equal(rest.c2.value, "1 work");
	assert.equal(rest.detail.enabled, false);

	const broken = renderInfobar({ connection: "ok", views: [view], hidden: 0, usage: { provider: "claude", session: null, weekly: null, error: "Not signed in" }, now: 0 });
	assert.ok(String(broken.detail.value).startsWith("Claude usage unavailable"));

	const asking = toView(row({ worktreeId: "r::/w/b", agents: [{ state: "waiting" }] }));
	const withAsk = renderInfobar({ connection: "ok", views: [view, asking], hidden: 0, usage, now: 0 });
	assert.equal(withAsk.c1.value, "1 ask", "line 1 stays on the counters");
	assert.equal(withAsk.u1p.value, "72%");

	const offline = renderInfobar({ connection: "offline", views: [], hidden: 0, usage, now: 0 });
	assert.equal(offline.u1p.value, "72%");
});

test("status key: counters and usage when no agent is shown in Orca, context otherwise", () => {
	const usage = { provider: "claude", session: { usedPercent: 23, resetsAt: null }, weekly: { usedPercent: 51, resetsAt: null } };
	const views = [toView(row({ agents: [{ state: "waiting", agentType: "claude" }] }))];
	const counts = renderStatus({ connection: "ok", views, usage, now: 0 });
	assert.match(counts, />1 ask</);
	assert.match(counts, />23%</);
	assert.match(counts, />51%</);
	const ctx = renderStatus({ connection: "ok", views, usage, activeContext: { worktreeId: "w", name: "Fix login", context: { tokens: 1, window: 1, percent: 42.4, model: null } }, now: 0 });
	assert.match(ctx, />ctx</);
	assert.match(ctx, />42%</);
	assert.doesNotMatch(ctx, /ask/);
});

test("orchestrators: coordinator worktree counts its workers still in progress", () => {
	const terminals = new Map([
		["term_coord", "r::/w/coord"],
		["term_w1", "r::/w/w1"],
	]);
	const runs = [
		{ id: "run_1", coordinator_handle: "term_coord" },
		{ id: "run_legacy", coordinator_handle: null },
		{ id: "run_gone", coordinator_handle: "term_closed" },
	];
	const workers = [
		{ runId: "run_1", terminalState: "active", projection: { outcome: "in_progress" } },
		{ runId: "run_1", terminalState: "active", projection: { outcome: "in_progress" } },
		{ runId: "run_1", terminalState: "reclaimable", projection: { outcome: "succeeded" } },
		{ runId: "run_1", terminalState: "released", projection: { outcome: "succeeded" } },
		{ runId: "run_gone", terminalState: "active", projection: { outcome: "in_progress" } },
		{ runId: "run_legacy", terminalState: "active", projection: { outcome: "in_progress" } },
	];
	assert.deepEqual([...orchestrators(workers, runs, terminals)], [["r::/w/coord", 2]]);

	// All workers finished but not released yet: still a coordinator, with 0 in progress.
	assert.deepEqual([...orchestrators(workers.slice(2, 3), runs, terminals)], [["r::/w/coord", 0]]);
	assert.equal(orchestrators([], runs, terminals).size, 0);
});

test("orchestrator badge is drawn only on coordinator keys, in the status color", () => {
	const view = toView(row({ agents: [{ state: "working" }] }));
	const plain = renderKey({ connection: "ok", slot: { kind: "worktree", view }, now: 0, hold: null });
	const badged = renderKey({ connection: "ok", slot: { kind: "worktree", view: { ...view, workers: 3 } }, now: 0, hold: null });
	assert.ok(!plain.includes('height="22" rx="11"'));
	assert.ok(badged.includes('height="22" rx="11" fill="#FFB020"'));
	assert.ok(badged.includes(">3</text>"));
});
