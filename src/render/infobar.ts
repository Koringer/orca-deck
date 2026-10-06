import type { DeckStatus, WorktreeView } from "../orca/model.ts";
import type { Connection, Usage, UsageWindow } from "../orca/store.ts";
import { elapsed, marquee, STATUS_STYLE } from "./theme.ts";

/** Layout file (relative to the .sdPlugin folder), 232 × 50 px. */
export const INFOBAR_LAYOUT = "layouts/infobar.json";

const COUNTS: { key: string; status: DeckStatus[]; label: string }[] = [
	{ key: "c1", status: ["input", "error"], label: "ask" },
	{ key: "c2", status: ["working", "background"], label: "work" },
	{ key: "c3", status: ["done", "review"], label: "done" },
	{ key: "c4", status: ["idle"], label: "idle" },
];
const USAGE_KEYS = ["u1l", "u1b", "u1p", "u2l", "u2b", "u2p"];
const DIM = "#3A3F4B";

export type InfobarFrame = {
	connection: Connection;
	views: WorktreeView[];
	hidden: number;
	focus: WorktreeView | null;
	usage: Usage | null;
	/** Shown instead of the counters when Orca's agent status hooks are missing. */
	hooksIssue?: string | null;
	now: number;
};

type Item = { value?: string | number; color?: string; bar_fill_c?: string; enabled?: boolean };
type Feedback = Record<string, Item>;

const off = (keys: string[]): Feedback => Object.fromEntries(keys.map((k) => [k, { enabled: false }]));

/** Top line: either the status counters or a free text title. */
function topCounts(views: WorktreeView[], hidden: number): Feedback {
	return {
		title: { enabled: false },
		hid: { value: hidden ? `+${hidden}` : "", color: "#FFFFFF", enabled: hidden > 0 },
		...Object.fromEntries(
			COUNTS.map((c) => {
				const n = views.filter((v) => c.status.includes(v.status)).length;
				const color = n === 0 || c.key === "c4" ? "#FFFFFF" : STATUS_STYLE[c.status[0]].color;
				return [c.key, { value: `${n} ${c.label}`, color, enabled: true }];
			}),
		),
	};
}

function topTitle(value: string, color: string): Feedback {
	return { title: { value, color, enabled: true }, ...off([...COUNTS.map((c) => c.key), "hid"]) };
}

function usageColor(pct: number) {
	return pct >= 85 ? STATUS_STYLE.error.color : pct >= 60 ? STATUS_STYLE.working.color : STATUS_STYLE.done.color;
}

/** Bottom line: token usage gauges (5h session + weekly), or a free text detail line. */
function bottomUsage(usage: Usage | null, views: WorktreeView[], hidden: number, now: number): Feedback {
	if (!usage || (!usage.session && !usage.weekly)) {
		const total = `${views.length} worktree${views.length === 1 ? "" : "s"}${hidden ? ` (+${hidden} hidden)` : ""}`;
		return bottomDetail(total, now);
	}
	const gauge = (prefix: string, label: string, w: UsageWindow | null): Feedback => {
		const pct = Math.round(w?.usedPercent ?? 0);
		const color = w ? usageColor(pct) : DIM;
		return {
			[`${prefix}l`]: { value: label, color: "#FFFFFF", enabled: true },
			[`${prefix}b`]: { value: pct, bar_fill_c: color, enabled: true },
			[`${prefix}p`]: { value: w ? `${pct}%` : "–", color: "#FFFFFF", enabled: true },
		};
	};
	return { detail: { enabled: false }, ...gauge("u1", "5h", usage.session), ...gauge("u2", "7d", usage.weekly) };
}

function bottomDetail(value: string, now: number): Feedback {
	return { detail: { value: marquee(value, 32, now, 250), enabled: true }, ...off(USAGE_KEYS) };
}

export function describe(v: WorktreeView, now: number): string {
	return [STATUS_STYLE[v.status].label, v.agent, elapsed(v.since, now), v.activity, v.comment, v.branch].filter(Boolean).join(" · ");
}

/**
 * - focus (a key was just pressed): worktree name + status · agent · time · current tool / last message · comment · branch
 * - otherwise: status counters (or "X needs you" when a worktree waits for input) + token usage gauges
 */
export function renderInfobar({ connection, views, hidden, focus, usage, hooksIssue, now }: InfobarFrame): Feedback {
	if (connection === "no-cli") return { ...topTitle("Orca CLI not found", STATUS_STYLE.error.color), ...bottomDetail("Set its path in the plugin settings", now) };
	if (connection !== "ok") return { ...topTitle("Orca offline", "#FFFFFF"), ...bottomDetail("Press any key to open Orca", now) };

	if (focus) {
		return { ...topTitle(marquee(focus.name, 24, now), STATUS_STYLE[focus.status].color), ...bottomDetail(describe(focus, now), now) };
	}

	const asking = views.filter((v) => v.status === "input");
	const top = hooksIssue
		? topTitle(marquee(`⚠ ${hooksIssue}`, 24, now), STATUS_STYLE.working.color)
		: asking.length === 1
			? topTitle(marquee(`${asking[0].name} needs you`, 24, now), STATUS_STYLE.input.color)
			: asking.length > 1
				? topTitle(`${asking.length} worktrees need you`, STATUS_STYLE.input.color)
				: topCounts(views, hidden);
	return { ...top, ...bottomUsage(usage, views, hidden, now) };
}
