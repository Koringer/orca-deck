/** Subset of an agent entry in `orca worktree ps --json` rows. */
export type OrcaAgent = {
	state?: string; // working | waiting | blocked | done | failed | interrupted | idle | ...
	agentType?: string | null;
	interrupted?: boolean;
	stateStartedAt?: number;
	updatedAt?: number;
	lastAssistantMessage?: string | null;
	toolName?: string | null;
};

/** Subset of a row in `orca worktree ps --json`. */
export type OrcaPsRow = {
	worktreeId: string;
	repoId: string;
	repo: string;
	path: string;
	branch: string;
	displayName?: string;
	isArchived?: boolean;
	isMainWorktree?: boolean;
	workspaceKind?: string;
	workspaceStatus?: string;
	comment?: string;
	unread?: boolean;
	liveTerminalCount?: number;
	status?: string; // permission | working | done | active | inactive
	agents?: OrcaAgent[];
	lastActivityAt?: number;
	createdAt?: number;
};

export type DeckStatus = "input" | "error" | "working" | "done" | "review" | "idle";

export type WorktreeView = {
	id: string;
	repoId: string;
	repo: string;
	name: string;
	branch: string;
	status: DeckStatus;
	unread: boolean;
	agent: string | null;
	/** Epoch ms when the current status started, if known. */
	since: number | null;
	comment: string;
	/** What the leading agent is doing / said last (tool name or last assistant message). */
	activity: string;
	isMain: boolean;
	isArchived: boolean;
	createdAt: number;
	lastActivityAt: number;
};

const STATUS_PRIORITY: DeckStatus[] = ["input", "error", "working", "done", "review", "idle"];

function agentStatus(a: OrcaAgent): DeckStatus {
	switch (a.state) {
		case "waiting":
		case "blocked":
		case "permission":
			return "input";
		case "failed":
			return "error";
		case "interrupted":
			return "error";
		case "working":
		case "monitoring":
			return "working";
		case "done":
			return a.interrupted ? "error" : "done";
		default:
			return "idle";
	}
}

function rowStatus(row: OrcaPsRow): DeckStatus {
	switch (row.status) {
		case "permission":
			return "input";
		case "working":
			return "working";
		case "done":
			return "done";
		default:
			return "idle";
	}
}

/** Branch `feature/fix-login` → `fix-login`. */
function shortBranch(branch: string): string {
	const clean = branch.replace(/^refs\/heads\//, "");
	return clean.split("/").pop() || clean;
}

/** Names given by the deck's "+" key (see store.taskName). */
const DECK_NAME = /^task-\d{4}-\d{6}$/;

/** Longest name shown on a key; longer names are cut with "…". */
export const MAX_NAME = 28;

/** Strips the activity glyph agents put in front of their terminal title (`✳ Ca va`, `⠂ Fix tests`). */
export function cleanTitle(title: string | null | undefined): string {
	return (title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+/g, " ").trim();
}

/**
 * The task name, by preference:
 * 1. a display name the user typed in Orca;
 * 2. the agent's conversation title (its terminal tab title, e.g. "Ca va");
 * 3. the branch, once Orca's "auto-rename branch from work" has replaced the generated name;
 * 4. the generated name (e.g. `BWHG`).
 */
function taskName(row: OrcaPsRow, agentTitle: string): string {
	const folder = row.path.split(/[\\/]/).pop() ?? "";
	const display = row.displayName?.trim() ?? "";
	const generated = (n: string) => !n || n === folder || DECK_NAME.test(n);
	const branch = shortBranch(row.branch);
	const name = !generated(display) ? display : agentTitle || (!generated(branch) ? branch : display || branch || folder || "worktree");
	return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1).trimEnd()}…` : name;
}

/** `agentTitle`: title of the worktree's agent terminal, from `orca terminal list`. */
export function toView(row: OrcaPsRow, agentTitle = ""): WorktreeView {
	const agents = row.agents ?? [];
	let status = rowStatus(row);
	let lead: OrcaAgent | undefined;
	for (const a of agents) {
		const s = agentStatus(a);
		if (STATUS_PRIORITY.indexOf(s) < STATUS_PRIORITY.indexOf(status) || (s === status && !lead)) {
			status = s;
			lead = a;
		}
	}
	if (status === "idle" && row.workspaceStatus === "in-review") status = "review";

	return {
		id: row.worktreeId,
		repoId: row.repoId,
		repo: row.repo,
		name: taskName(row, cleanTitle(agentTitle)),
		branch: row.branch,
		status,
		unread: !!row.unread,
		agent: lead?.agentType ?? agents[agents.length - 1]?.agentType ?? null,
		since: lead?.stateStartedAt ?? null,
		comment: row.comment ?? "",
		activity: activityOf(lead),
		isMain: !!row.isMainWorktree,
		isArchived: !!row.isArchived,
		createdAt: row.createdAt ?? 0,
		lastActivityAt: Math.max(row.lastActivityAt ?? 0, ...agents.map((a) => a.updatedAt ?? a.stateStartedAt ?? 0)),
	};
}

function activityOf(a: OrcaAgent | undefined): string {
	if (!a) return "";
	if (a.state === "working" && a.toolName) return a.toolName;
	return (a.lastAssistantMessage ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
}
