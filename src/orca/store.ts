import { execFile } from "node:child_process";

import { OrcaCli, OrcaError } from "./cli.ts";
import { toView, type OrcaPsRow, type WorktreeView } from "./model.ts";

export type GlobalSettings = {
	/** Absolute path to the `orca` CLI; auto-detected when empty. */
	orcaPath?: string;
	/** Agent started when pressing a worktree with no terminal (`claude`, `codex`, ...). */
	agent?: string;
	/** Long-press duration in ms. */
	holdMs?: number;
	/** Show the repo's main checkout as a worktree. */
	includeMain?: boolean;
	pollMs?: number;
	/** slot index → worktree id, so keys keep their worktree across restarts. */
	slots?: Record<string, string>;
	/** worktree id → "done" state (its start time) the user already looked at; shown as idle. */
	seen?: Record<string, number>;
	/** worktree id → state signature when the user took it off the deck; it stays off until that changes. */
	dismissed?: Record<string, string>;
};

export type SlotPending =
	/** Orca's "Create worktree" dialog is open; the next new worktree goes on this key. */
	| { kind: "awaiting"; at: number; until: number; replaces?: string }
	| { kind: "error"; at: number; until: number; message: string };

export type Connection = "ok" | "offline" | "no-cli" | "starting";

export type SlotState =
	| { kind: "worktree"; view: WorktreeView; pending?: SlotPending }
	| { kind: "empty"; pending?: SlotPending };

export type UsageWindow = { usedPercent: number; resetsAt: number | null };
export type Usage = {
	provider: string;
	session: UsageWindow | null;
	weekly: UsageWindow | null;
	/** Why Orca has no usage for this account (e.g. "Codex not signed in"), when it has none. */
	error?: string;
};

type RateLimitWindow = { usedPercent?: number; resetsAt?: number };
type RateLimits = Record<
	string,
	{ session?: RateLimitWindow | null; weekly?: RateLimitWindow | null; status?: string; error?: string | null } | undefined
>;

type TerminalRow = { worktreeId?: string; title?: string | null; agentIdentity?: string | null; lastOutputAt?: number | null };

/** How long a key waits for the worktree created in Orca's dialog. */
const AWAIT_MS = 3 * 60_000;

const USAGE_POLL_MS = 60_000;
const HOOKS_POLL_MS = 5 * 60_000;

type HooksStatus = { enabled?: boolean; statuses?: { agent: string; managedHooksPresent?: boolean }[] };

export const DEFAULTS = { agent: "claude", holdMs: 700, pollMs: 1500 } as const;

export class OrcaStore {
	connection: Connection = "starting";
	views: WorktreeView[] = [];
	/** Worktree last pressed, shown in the infobar for a few seconds. */
	focus: { id: string; at: number } | null = null;
	/** Rate-limit usage of the configured agent's account, from `orca account list`. */
	usage: Usage | null = null;
	private usageAt = 0;
	/** Set when Orca's agent status hooks are missing: statuses then only update while the terminal is on screen. */
	hooksIssue: string | null = null;
	private hooksAt = 0;
	private hooksRepairTried = false;

	private settings: GlobalSettings = {};
	private readonly slotMap = new Map<number, string>();
	private readonly pending = new Map<number, SlotPending>();
	private readonly visibleSlots = new Set<number>();
	/** Worktree ids seen in a previous poll; anything else just appeared in Orca. */
	private known: Set<string> | null = null;
	private pollTimer: NodeJS.Timeout | null = null;
	private polling = false;

	private readonly cli: Pick<OrcaCli, "run">;
	private readonly persist: (s: GlobalSettings) => void;
	private readonly log: (msg: string) => void;

	constructor(cli: Pick<OrcaCli, "run">, persist: (s: GlobalSettings) => void, log: (msg: string) => void = () => {}) {
		this.cli = cli;
		this.persist = persist;
		this.log = log;
	}

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
		return this.views.filter((v) => !shown.has(v.id) && !this.isDismissed(v)).length;
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
			if (!ids.has(id)) {
				this.slotMap.delete(slot);
				changed = true;
			}
		}

		const assigned = new Set(this.slotMap.values());
		const free = [...this.visibleSlots]
			.filter((s) => !this.slotMap.has(s) && !this.pending.has(s))
			.sort((a, b) => a - b);
		// Busy worktrees first, then the most recently created.
		const waiting = this.views
			.filter((v) => !assigned.has(v.id) && !this.isDismissed(v))
			.sort((a, b) => Number(a.status === "idle") - Number(b.status === "idle") || b.createdAt - a.createdAt);

		const known = this.known;
		this.known = ids;

		// Worktrees that just appeared go to keys waiting on Orca's "Create worktree" dialog.
		const fresh = known ? waiting.filter((v) => !known.has(v.id)).sort((a, b) => a.createdAt - b.createdAt) : [];
		const awaiting = [...this.pending]
			.filter(([slot, p]) => p.kind === "awaiting" && this.livePending(slot))
			.sort(([, a], [, b]) => a.at - b.at);
		for (const [slot, p] of awaiting) {
			const view = fresh.shift();
			if (!view) break;
			if (p.kind === "awaiting" && p.replaces) {
				const old = this.views.find((v) => v.id === p.replaces);
				if (old) this.settings = { ...this.settings, dismissed: { ...this.settings.dismissed, [old.id]: signature(old) } };
			}
			this.pending.delete(slot);
			this.slotMap.set(slot, view.id);
			this.focus = { id: view.id, at: Date.now() };
			waiting.splice(waiting.indexOf(view), 1);
			changed = true;
		}

		for (const view of waiting) {
			let slot = free.shift();
			if (slot === undefined) {
				// Deck full: take the key of the least recently active idle worktree.
				// Only a new or busy worktree may displace an idle one, so displaced worktrees don't bounce
				// between keys. On the first poll after a start, nothing counts as new.
				const isNew = known !== null && !known.has(view.id);
				slot = isNew || view.status !== "idle" ? this.idleVictim(view) : undefined;
				if (slot === undefined) continue;
			}
			this.slotMap.set(slot, view.id);
			changed = true;
		}

		if (changed) this.save();
	}

	/** Taken off the deck with a long press, and its agent hasn't changed state since. */
	private isDismissed(view: WorktreeView): boolean {
		return this.settings.dismissed?.[view.id] === signature(view);
	}

	/** Forgets dismissals of worktrees that changed state or no longer exist. */
	private pruneDismissed() {
		const dismissed = this.settings.dismissed;
		if (!dismissed) return;
		const live = Object.fromEntries(Object.entries(dismissed).filter(([id]) => this.views.some((v) => v.id === id && this.isDismissed(v))));
		if (Object.keys(live).length !== Object.keys(dismissed).length) {
			this.settings = { ...this.settings, dismissed: live };
			this.persist(this.settings);
		}
	}

	private idleVictim(candidate: WorktreeView): number | undefined {
		const byId = new Map(this.views.map((v) => [v.id, v]));
		let victim: { slot: number; view: WorktreeView } | undefined;
		for (const slot of this.visibleSlots) {
			if (this.pending.has(slot)) continue;
			const view = byId.get(this.slotMap.get(slot) ?? "");
			if (!view || view.status !== "idle" || view.id === candidate.id) continue;
			if (!victim || view.lastActivityAt < victim.view.lastActivityAt) victim = { slot, view };
		}
		return victim?.slot;
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
				.map((row) => this.applySeen(toView(row, titles.get(row.worktreeId))))
				.filter((v) => !v.isArchived && (this.settings.includeMain || !v.isMain));
			this.connection = "ok";
			this.pruneDismissed();
			this.assignSlots();
			if (Date.now() - this.usageAt > USAGE_POLL_MS) void this.refreshUsage();
			if (Date.now() - this.hooksAt > HOOKS_POLL_MS) void this.checkHooks();
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
			this.recovered("terminal list");
			const agentTerminals = terminals
				.filter((t) => t.agentIdentity && t.title && t.worktreeId)
				.sort((a, b) => (a.lastOutputAt ?? 0) - (b.lastOutputAt ?? 0));
			for (const t of agentTerminals) titles.set(t.worktreeId!, t.title!);
		} catch (e) {
			this.logOnce("terminal list", e);
		}
		return titles;
	}

	private readonly failing = new Set<string>();

	/** Logs a polling failure once, not on every poll, so a closed Orca doesn't fill the log. */
	private logOnce(what: string, e: unknown) {
		if (this.failing.has(what)) return;
		this.failing.add(what);
		this.log(`${what} failed: ${e instanceof Error ? e.message : e}`);
	}

	private recovered(what: string) {
		if (this.failing.delete(what)) this.log(`${what} works again`);
	}

	/**
	 * Orca learns "needs input" / "working" / "done" instantly from hooks it installs in each agent's
	 * config (e.g. ~/.claude/settings.json). Without them it guesses from the terminal screen, which only
	 * updates while the terminal is displayed. Reinstalls them once if missing, otherwise warns.
	 */
	async checkHooks(): Promise<void> {
		this.hooksAt = Date.now();
		try {
			const status = await this.cli.run<HooksStatus>(["agent", "hooks", "status"]);
			const used = new Set([this.config.agent, ...this.views.map((v) => v.agent).filter((a): a is string => !!a)]);
			const missing = (status.statuses ?? []).filter((s) => used.has(s.agent) && !s.managedHooksPresent).map((s) => s.agent);

			if (status.enabled === false) {
				this.hooksIssue = "Orca agent hooks are off: statuses lag until the terminal is on screen";
			} else if (missing.length === 0) {
				this.hooksIssue = null;
			} else if (!this.hooksRepairTried) {
				this.hooksRepairTried = true;
				this.log(`agent hooks missing for ${missing.join(", ")}: running orca agent hooks on`);
				await this.cli.run(["agent", "hooks", "on"], 30_000);
				return this.checkHooks();
			} else {
				this.hooksIssue = `${missing.join(", ")} hooks missing: statuses lag until the terminal is on screen`;
			}
			this.recovered("agent hooks status");
		} catch (e) {
			this.logOnce("agent hooks status", e);
		}
	}

	private async refreshUsage() {
		this.usageAt = Date.now();
		try {
			const { rateLimits } = await this.cli.run<{ rateLimits?: RateLimits }>(["account", "list"]);
			this.recovered("account list");
			const provider = rateLimits?.[this.config.agent] ? this.config.agent : "claude";
			const limits = rateLimits?.[provider];
			const win = (w?: RateLimitWindow | null): UsageWindow | null =>
				typeof w?.usedPercent === "number" ? { usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null } : null;
			const session = win(limits?.session);
			const weekly = win(limits?.weekly);
			const error = session || weekly ? undefined : limits?.error || limits?.status || "Orca reports no usage for this account";
			this.usage = { provider, session, weekly, ...(error ? { error } : {}) };
			if (error) this.logOnce("usage", new Error(error));
			else this.recovered("usage");
		} catch (e) {
			this.logOnce("account list", e);
		}
	}

	// ---------------------------------------------------------------- actions

	/** A "done" worktree the user has pressed shows as idle until its agent changes state again. */
	private applySeen(view: WorktreeView): WorktreeView {
		const seen = this.settings.seen?.[view.id];
		if (seen === undefined) return view;
		if (view.status === "done" && (view.since ?? 0) === seen) return { ...view, status: "idle", unread: false };
		const { [view.id]: _, ...rest } = this.settings.seen ?? {};
		this.settings = { ...this.settings, seen: rest };
		this.persist(this.settings);
		return view;
	}

	private markSeen(view: WorktreeView) {
		this.settings = { ...this.settings, seen: { ...this.settings.seen, [view.id]: view.since ?? 0 } };
		this.persist(this.settings);
		this.views = this.views.map((v) => (v.id === view.id ? { ...v, status: "idle", unread: false } : v));
	}

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
		if (view.status === "done") this.markSeen(view);

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

	/** Press on "+": opens Orca's "Create worktree" dialog; the worktree created there lands on this key. */
	async createInSlot(slot: number) {
		await this.openCreateDialog(slot);
	}

	/**
	 * Long press on a worktree: opens Orca's "Create worktree" dialog. Once the new worktree exists it
	 * takes this key and the old one leaves the deck (it stays in Orca). The deck never deletes worktrees.
	 */
	async replaceSlot(slot: number) {
		const state = this.slot(slot);
		if (state.kind !== "worktree") return this.createInSlot(slot);
		if (state.pending) return;
		await this.openCreateDialog(slot, state.view.id);
	}

	async openOrca() {
		await this.cli.run(["open"], 60_000).catch(() => bringOrcaToFront());
		await this.refresh();
	}

	private async openCreateDialog(slot: number, replaces?: string) {
		const now = Date.now();
		this.pending.set(slot, { kind: "awaiting", at: now, until: now + AWAIT_MS, ...(replaces ? { replaces } : {}) });
		try {
			// Orca's own shortcut for "Create worktree" (Cmd+N / Ctrl+N), sent through Orca's computer-use helper.
			await this.cli.run(
				["computer", "hotkey", "--app", process.platform === "darwin" ? "com.stablyai.orca" : "Orca", "--key", "CmdOrCtrl+N", "--restore-window", "--no-screenshot"],
				20_000,
			);
		} catch (e) {
			this.pending.delete(slot);
			if (e instanceof OrcaError && e.code === "permission_denied") {
				// Opens the system settings where the user grants Accessibility to "Orca Computer Use".
				void this.cli.run(["computer", "permissions", "--id", "accessibility"]).catch(() => {});
				this.fail(slot, "Allow Accessibility for Orca Computer Use, then press again");
			} else {
				this.fail(slot, e instanceof Error ? e.message : String(e));
			}
		}
	}

	private fail(slot: number, message: string) {
		this.log(`slot ${slot}: ${message}`);
		this.pending.set(slot, { kind: "error", at: Date.now(), until: Date.now() + 4000, message });
	}
}

function bringOrcaToFront() {
	if (process.platform === "darwin") execFile("open", ["-b", "com.stablyai.orca"], () => {});
}

/** Changes whenever the worktree's agent changes state. */
function signature(view: WorktreeView): string {
	return `${view.status}:${view.since ?? 0}`;
}
