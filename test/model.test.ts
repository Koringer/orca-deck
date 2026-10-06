import assert from "node:assert/strict";
import { test } from "node:test";

import { toView, type OrcaPsRow } from "../src/orca/model.ts";
import { renderInfobar } from "../src/render/infobar.ts";
import { renderKey, wrap } from "../src/render/key.ts";
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
		assert.ok(o >= 0.3 && o <= 1);
	}
	assert.equal(breathe(123, null), 1);
});

test("renders every key state as valid-looking SVG", () => {
	const view = toView(row({ agents: [{ state: "working", agentType: "claude", stateStartedAt: 0 }] }));
	const frames = [
		renderKey({ connection: "ok", slot: { kind: "worktree", view }, now: 200_000, hold: null }),
		renderKey({ connection: "ok", slot: { kind: "worktree", view }, now: 1, hold: 0.5 }),
		renderKey({ connection: "ok", slot: { kind: "empty" }, now: 1, hold: null }),
		renderKey({ connection: "ok", slot: { kind: "empty", pending: { kind: "creating", at: 0 } }, now: 1, hold: null }),
		renderKey({ connection: "offline", slot: { kind: "empty" }, now: 1, hold: null }),
	];
	for (const svg of frames) assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
	assert.match(frames[0], /WORKING/);
	assert.doesNotMatch(frames[0], /claude · /);
	assert.match(frames[2], />\+</);
});

test("infobar: usage gauges at rest, details on focus", () => {
	const view = toView(row({ comment: "tests green", agents: [{ state: "working", agentType: "claude", toolName: "Edit" }] }));
	const usage = { provider: "claude", session: { usedPercent: 72, resetsAt: null }, weekly: { usedPercent: 12, resetsAt: null } };
	const rest = renderInfobar({ connection: "ok", views: [view], hidden: 0, focus: null, usage, now: 0 });
	assert.equal(rest.u1b.value, 72);
	assert.equal(rest.u1p.value, "72%");
	assert.equal(rest.c2.value, "1 work");
	assert.equal(rest.detail.enabled, false);

	const focus = renderInfobar({ connection: "ok", views: [view], hidden: 0, focus: view, usage, now: 0 });
	assert.equal(focus.title.value, "fix-login");
	assert.match(String(focus.detail.value), /WORKING · claude/);
	assert.equal(focus.u1b.enabled, false);
});
