import { execFile } from "node:child_process";

import { OrcaCli, OrcaError } from "./cli.ts";
import { toView, type OrcaPsRow, type WorktreeView } from "./model.ts";

export type GlobalSettings = {
	/** Absolute path to the `orca` CLI; auto-detected when empty. */
	orcaPath?: string;
	/** Repo selector for the "+" key, e.g. `name:my-repo` or `id:<repoId>`. Defaults to the most recent worktree's repo. */
	defaultRepo?: string;
	/** Agent launched in new worktrees (`claude`, `codex`, ...). */
	agent?: string;
	/** Long-press duration in ms. */
	holdMs?: number;
	/** Show the repo's main checkout as a worktree. */
	includeMain?: boolean;
	pollMs?: number;
	/** slot index → worktree id, so keys keep their worktree across restarts. */
	slots?: Record<string, string>;
};

export type SlotPending =
	| { kind: "creating"; at: number }
	| { kind: "removing"; at: number }
	| { kind: "dirty"; at: number; until: number; message: string }
	| { kind: "error"; at: number; until: number; message: string };

export type Connection = "ok" | "offline" | "no-cli" | "starting";

export type SlotState =
	| { kind: "worktree"; view: WorktreeView; pending?: SlotPending }
	| { kind: "empty"; pending?: SlotPending };

export type UsageWindow = { usedPercent: number; resetsAt: number | null };
export type Usage = { provider: string; session: UsageWindow | null; weekly: UsageWindow | null };

type RateLimitWindow = { usedPercent?: number; resetsAt?: number };
type RateLimits = Record<string, { session?: RateLimitWindow | null; weekly?: RateLimitWindow | null; status?: string } | undefined>;

type TerminalRow = { worktreeId?: string; title?: string | null; agentIdentity?: string | null; lastOutputAt?: number | null };

const USAGE_POLL_MS = 60_000;

export const DEFAULTS = { agent: "claude", holdMs: 700, pollMs: 1500 } as const;

const DIRTY_PATTERN = /uncommitted|dirty|modified|untracked|unmerged|local changes|--force/i;

export class OrcaStore {
	connection: Connection = "starting";
	views: WorktreeView[] = [];
	/** Worktree last pressed, shown in the infobar for a few seconds. */
	focus: { id: string; at: number } | null = null;
	/** Rate-limit usage of the configured agent's account, from `orca account list`. */
	usage: Usage | null = null;
	private usageAt = 0;

	private settings: GlobalSettings = {};
	private readonly slotMap = new Map<number, string>();
	private readonly pending = new Map<number, SlotPending>();
	private readonly visibleSlots = new Set<number>();
	private pollTimer: NodeJS.Timeout | null = null;
	private polling = false;

	constructor(
		private readonly cli: OrcaCli,
		private readonly persist: (s: GlobalSettings) => void,
		private readonly log: (msg: string) => void = () => {},
	) {}

	get config() {
		return {
			agent: this.settings.agent?.trim() || DEFAULTS.agent,
			holdMs: this.settings.holdMs || DEFAULTS.holdMs,
			pollMs: Math.max(500, this.settings.pollMs || DEFAULTS.pollMs),
		};
	}

	get orcaPath() {
		return this.settings.orcaPath?.trim() || undefined;
	}

	applySettings(settings: GlobalSettings) {
		this.settings = settings;
		this.slotMap.clear();
		for (const [slot, id] of Object.entries(settings.slots ?? {})) this.slotMap.set(Number(slot), id);
		this.assignSlots();
	}

	// ---------------------------------------------------------------- slots

	registerSlot(slot: number) {
		this.visibleSlots.add(slot);
		this.assignSlots();
	}

	unregisterSlot(slot: number) {
		this.visibleSlots.delete(slot);
	}

	slot(slot: number): SlotState {
		const pending = this.livePending(slot);
		const id = this.slotMap.get(slot);
		const view = id ? this.views.find((v) => v.id === id) : undefined;
		return view ? { kind: "worktree", view, pending } : { kind: "empty", pending };
	}

	/** Worktrees that have no visible key. */
	hiddenCount(): number {
		const shown = new Set([...this.visibleSlots].map((s) => this.slotMap.get(s)));
		return this.views.filter((v) => !shown.has(v.id)).length;
	}

	private livePending(slot: number): SlotPending | undefined {
		const p = this.pending.get(slot);
		if (p && "until" in p && p.until < Date.now()) {
			this.pending.delete(slot);
			return undefined;
		}
		return p;
	}

	private assignSlots() {
		if (this.connection !== "ok") return;
		const ids = new Set(this.views.map((v) => v.id));
		let changed = false;

		for (const [slot, id] of this.slotMap) {
			if (!ids.has(id) && this.pending.get(slot)?.kind !== "creating") {
				this.slotMap.delete(slot);
				changed = true;
			}
		}

		const assigned = new Set(this.slotMap.values());
		const free = [...this.visibleSlots]
			.filter((s) => !this.slotMap.has(s) && !this.pending.has(s))
			.sort((a, b) => a - b);
		for (const view of this.views) {
			if (free.length === 0) break;
			if (assigned.has(view.id)) continue;
			this.slotMap.set(free.shift()!, view.id);
			changed = true;
		}

		if (changed) this.save();
	}

	private save() {
		this.settings = { ...this.settings, slots: Object.fromEntries([...this.slotMap].map(([k, v]) => [String(k), v])) };
		this.persist(this.settings);
	}

	// ---------------------------------------------------------------- polling

	start() {
		if (this.pollTimer) return;
		const loop = async () => {
			await this.refresh();
			this.pollTimer = setTimeout(loop, this.config.pollMs);
		};
		void loop();
	}

	stop() {
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = null;
	}

	async refresh() {
		if (this.polling) return;
		this.polling = true;
		try {
			const [result, titles] = await Promise.all([
				this.cli.run<{ worktrees: OrcaPsRow[] }>(["worktree", "ps", "--limit", "200"]),
				this.agentTitles(),
			]);
			this.views = result.worktrees
				.map((row) => toView(row, titles.get(row.worktreeId)))
				.filter((v) => !v.isArchived && (this.settings.includeMain || !v.isMain));
			this.connection = "ok";
			this.assignSlots();
			if (Date.now() - this.usageAt > USAGE_POLL_MS) void this.refreshUsage();
		} catch (e) {
			const code = e instanceof OrcaError ? e.code : "unknown";
			this.connection = code === "cli_not_found" ? "no-cli" : "offline";
		} finally {
			this.polling = false;
		}
	}

	/** worktree id → title of its most recently active agent terminal (the conversation title). */
	private async agentTitles(): Promise<Map<string, string>> {
		const titles = new Map<string, string>();
		try {
			const { terminals } = await this.cli.run<{ terminals: TerminalRow[] }>(["terminal", "list", "--limit", "500"]);
			const agentTerminals = terminals
				.filter((t) => t.agentIdentity && t.title && t.worktreeId)
				.sort((a, b) => (a.lastOutputAt ?? 0) - (b.lastOutputAt ?? 0));
			for (const t of agentTerminals) titles.set(t.worktreeId!, t.title!);
		} catch (e) {
			this.log(`terminal list failed: ${e instanceof Error ? e.message : e}`);
		}
		return titles;
	}

	private async refreshUsage() {
		this.usageAt = Date.now();
		try {
			const { rateLimits } = await this.cli.run<{ rateLimits?: RateLimits }>(["account", "list"]);
			const provider = rateLimits?.[this.config.agent] ? this.config.agent : "claude";
			const limits = rateLimits?.[provider];
			const win = (w?: RateLimitWindow | null): UsageWindow | null =>
				typeof w?.usedPercent === "number" ? { usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null } : null;
			this.usage = limits ? { provider, session: win(limits.session), weekly: win(limits.weekly) } : null;
		} catch (e) {
			this.log(`usage refresh failed: ${e instanceof Error ? e.message : e}`);
		}
	}

	// ---------------------------------------------------------------- actions

	/** Shows the worktree behind `slot` in the infobar. */
	touch(slot: number) {
		const state = this.slot(slot);
		if (state.kind === "worktree") this.focus = { id: state.view.id, at: Date.now() };
	}

	/** Short press on a worktree: bring its agent terminal to the front in Orca. */
	async focusWorktree(slot: number) {
		const state = this.slot(slot);
		if (state.kind !== "worktree") return;
		const { view } = state;
		this.focus = { id: view.id, at: Date.now() };

		const { terminals } = await this.cli.run<{ terminals: { handle: string; connected?: boolean }[] }>([
			"terminal",
			"list",
			"--worktree",
			`id:${view.id}`,
		]);
		const terminal = terminals.find((t) => t.connected) ?? terminals[0];
		if (terminal) {
			await this.cli.run(["terminal", "switch", "--terminal", terminal.handle]);
		} else {
			// Nothing running in this worktree: start the agent there.
			const created = await this.cli.run<{ terminal?: { handle?: string } }>([
				"terminal",
				"create",
				"--worktree",
				`id:${view.id}`,
				"--command",
				this.config.agent,
			]);
			if (created.terminal?.handle) await this.cli.run(["terminal", "switch", "--terminal", created.terminal.handle]);
		}
		bringOrcaToFront();
	}

	/** Short press on "+": new worktree with a fresh agent. */
	async createInSlot(slot: number) {
		const repo = this.settings.defaultRepo?.trim() || (await this.guessRepo());
		if (!repo) {
			this.fail(slot, "No repo in Orca");
			return;
		}
		await this.create(slot, repo);
	}

	/**
	 * Long press on a worktree: remove it and start a new one (same repo, new agent) on the same key.
	 * A worktree with local changes is not removed unless the long press is repeated while the key
	 * shows the "dirty" warning.
	 */
	async replaceSlot(slot: number) {
		const state = this.slot(slot);
		if (state.kind !== "worktree") return this.createInSlot(slot);
		if (state.pending && state.pending.kind !== "dirty") return;

		const { view } = state;
		const force = state.pending?.kind === "dirty";
		this.pending.set(slot, { kind: "removing", at: Date.now() });
		try {
			await this.cli.run(["worktree", "rm", "--worktree", `id:${view.id}`, ...(force ? ["--force"] : [])], 60_000);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.log(`worktree rm failed: ${message}`);
			if (!force && DIRTY_PATTERN.test(message)) {
				this.pending.set(slot, { kind: "dirty", at: Date.now(), until: Date.now() + 6000, message });
			} else {
				this.fail(slot, message);
			}
			return;
		}
		this.slotMap.delete(slot);
		this.views = this.views.filter((v) => v.id !== view.id);
		await this.create(slot, `id:${view.repoId}`);
	}

	async openOrca() {
		await this.cli.run(["open"], 60_000).catch(() => bringOrcaToFront());
		await this.refresh();
	}

	private async create(slot: number, repoSelector: string) {
		this.pending.set(slot, { kind: "creating", at: Date.now() });
		this.save();
		try {
			const result = await this.cli.run<{ worktree: { id: string } }>(
				[
					"worktree",
					"create",
					"--repo",
					repoSelector,
					"--name",
					taskName(),
					"--agent",
					this.config.agent,
					"--no-parent",
					"--activate",
				],
				120_000,
			);
			this.slotMap.set(slot, result.worktree.id);
			this.pending.delete(slot);
			this.focus = { id: result.worktree.id, at: Date.now() };
			this.save();
			bringOrcaToFront();
		} catch (e) {
			this.fail(slot, e instanceof Error ? e.message : String(e));
		}
		await this.refresh();
	}

	private fail(slot: number, message: string) {
		this.log(`slot ${slot}: ${message}`);
		this.pending.set(slot, { kind: "error", at: Date.now(), until: Date.now() + 4000, message });
	}

	private async guessRepo(): Promise<string | null> {
		const recent = [...this.views].sort((a, b) => (b.since ?? 0) - (a.since ?? 0))[0];
		if (recent) return `id:${recent.repoId}`;
		const { repos } = await this.cli.run<{ repos: { id: string }[] }>(["repo", "list"]);
		return repos[0] ? `id:${repos[0].id}` : null;
	}
}

function taskName(d = new Date()) {
	const p = (n: number) => String(n).padStart(2, "0");
	return `task-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function bringOrcaToFront() {
	if (process.platform === "darwin") execFile("open", ["-b", "com.stablyai.orca"], () => {});
}
