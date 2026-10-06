import type { DeckStatus, WorktreeView } from "../orca/model.ts";
import { formatMoney } from "../claude/usage.ts";
import type { ActiveContext, Connection, Usage, UsageWindow } from "../orca/store.ts";
import { marquee, STATUS_STYLE } from "./theme.ts";

/** Layout file (relative to the .sdPlugin folder), 232 × 50 px. */
export const INFOBAR_LAYOUT = "layouts/infobar.json";

const COUNTS: { key: string; status: DeckStatus[]; label: string }[] = [
	{ key: "c1", status: ["input", "error"], label: "ask" },
	{ key: "c2", status: ["working", "background"], label: "work" },
	{ key: "c3", status: ["done", "review"], label: "done" },
	{ key: "c4", status: ["idle"], label: "idle" },
];
const USAGE_KEYS = ["u1l", "u1b", "u1p", "u2l", "u2b", "u2p", "u2t"];
const CONTEXT_KEYS = ["x1l", "x1b", "x1p", "x1n"];
const DIM = "#3A3F4B";

export type InfobarFrame = {
	connection: Connection;
	views: WorktreeView[];
	hidden: number;
	usage: Usage | null;
	/** Shown instead of the counters when Orca's agent status hooks are missing. */
	hooksIssue?: string | null;
	/** Context window of the agent in the worktree shown in Orca (when it is on the deck). */
	activeContext?: ActiveContext | null;
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
		...off(CONTEXT_KEYS),
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
	return { title: { value, color, enabled: true }, ...off([...COUNTS.map((c) => c.key), "hid", ...CONTEXT_KEYS]) };
}

/** Line 1 while an agent on the deck is shown in Orca: how full its context window is. */
function topContext({ name, context }: ActiveContext, now: number): Feedback {
	const pct = Math.round(context.percent);
	return {
		title: { enabled: false },
		hid: { enabled: false },
		...off(COUNTS.map((c) => c.key)),
		x1l: { value: "ctx", enabled: true },
		x1b: { value: pct, bar_fill_c: usageColor(pct), enabled: true },
		x1p: { value: `${pct}%`, color: "#FFFFFF", enabled: true },
		x1n: { value: marquee(name, 12, now), color: "#FFFFFF", enabled: true },
	};
}

function usageColor(pct: number) {
	return pct >= 85 ? STATUS_STYLE.error.color : pct >= 60 ? STATUS_STYLE.working.color : STATUS_STYLE.done.color;
}

/** Bottom line: token usage gauges (5h session + weekly), or a free text detail line. */
function bottomUsage(usage: Usage | null, now: number): Feedback {
	if (usage?.error) {
		const name = usage.provider.charAt(0).toUpperCase() + usage.provider.slice(1);
		return bottomDetail(`${name} usage unavailable: ${usage.error}`, now);
	}
	if (usage && !usage.session && !usage.weekly && usage.monthly) {
		const { usedPercent, used, limit } = usage.monthly;
		const p = Math.round(usedPercent);
		return {
			detail: { enabled: false },
			u1l: { value: "mo", enabled: true },
			u1b: { value: p, bar_fill_c: usageColor(p), enabled: true },
			u1p: { value: `${p}%`, color: "#FFFFFF", enabled: true },
			u2t: { value: `${formatMoney(used)} / ${formatMoney(limit)}`, color: "#FFFFFF", enabled: true },
			...off(["u2l", "u2b", "u2p"]),
		};
	}
	if (!usage || (!usage.session && !usage.weekly)) return bottomDetail("Token usage: loading…", now);
	const gauge = (prefix: string, label: string, w: UsageWindow | null): Feedback => {
		const pct = Math.round(w?.usedPercent ?? 0);
		const color = w ? usageColor(pct) : DIM;
		return {
			[`${prefix}l`]: { value: label, enabled: true },
			[`${prefix}b`]: { value: pct, bar_fill_c: color, enabled: true },
			[`${prefix}p`]: { value: w ? `${pct}%` : "–", color: "#FFFFFF", enabled: true },
		};
	};
	return { detail: { enabled: false }, u2t: { enabled: false }, ...gauge("u1", "5h", usage.session), ...gauge("u2", "7d", usage.weekly) };
}

function bottomDetail(value: string, now: number): Feedback {
	return { detail: { value: marquee(value, 32, now, 250), enabled: true }, ...off(USAGE_KEYS) };
}

/**
 * Line 1: context window of the agent shown in Orca when it is on the deck, otherwise the agents'
 * status counters (or why they can't be read). Line 2: always token usage.
 */
export function renderInfobar({ connection, views, hidden, usage, hooksIssue, activeContext, now }: InfobarFrame): Feedback {
	const top =
		connection === "no-cli"
			? topTitle(marquee("Orca CLI not found · set its path in the plugin settings", 24, now), STATUS_STYLE.error.color)
			: connection !== "ok"
				? topTitle(marquee("Orca offline · press any key to open it", 24, now), "#FFFFFF")
				: hooksIssue
					? topTitle(marquee(`⚠ ${hooksIssue}`, 24, now), STATUS_STYLE.working.color)
					: activeContext
						? topContext(activeContext, now)
						: topCounts(views, hidden);
	return { ...top, ...bottomUsage(usage, now) };
}
