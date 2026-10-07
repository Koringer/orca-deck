import { formatMoney } from "../claude/usage.ts";
import type { DeckStatus, WorktreeView } from "../orca/model.ts";
import type { ActiveContext, Connection, Usage, UsageWindow } from "../orca/store.ts";
import { esc, frame, text } from "./key.ts";
import { FONT, marquee, STATUS_STYLE } from "./theme.ts";

/**
 * "Orca Status" key: the Neo infobar squeezed into one key, for decks without an infobar (Stream Deck
 * Mobile, Mini, MK.2…). Top half = active agent's context window or status counters; bottom half =
 * token usage.
 */
export type StatusFrame = {
	connection: Connection;
	views: WorktreeView[];
	usage: Usage | null;
	hooksIssue?: string | null;
	activeContext?: ActiveContext | null;
	now: number;
};

const LEFT = 18;
const RIGHT = 126;
/** Row centers: two rows for the top half, two for usage. */
const ROWS = [34, 58, 90, 114];
const PILL = "#2A2E38";
const DIM = "#3A3F4B";
const FRAME = "#2A2E38";

function left(x: number, y: number, size: number, fill: string, value: string, weight = 700) {
	return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(value)}</text>`;
}

function usageColor(pct: number) {
	return pct >= 85 ? STATUS_STYLE.error.color : pct >= 60 ? STATUS_STYLE.working.color : STATUS_STYLE.done.color;
}

/** Label pill, bar and percentage; same geometry on every row so the gauges line up. */
function gauge(cy: number, label: string, pct: number | null) {
	const color = pct === null ? DIM : usageColor(pct);
	const fill = pct === null ? 0 : Math.round((36 * Math.min(100, Math.max(0, pct))) / 100);
	return (
		`<rect x="${LEFT}" y="${cy - 10}" width="30" height="20" rx="5" fill="${PILL}"/>` +
		text(LEFT + 15, cy + 5, 13, "#FFFFFF", label) +
		`<rect x="52" y="${cy - 4}" width="36" height="8" rx="4" fill="#4A4F5C"/>` +
		(fill ? `<rect x="52" y="${cy - 4}" width="${fill}" height="8" rx="4" fill="${color}"/>` : "") +
		left(92, cy + 5, 15, "#FFFFFF", pct === null ? "–" : `${pct}%`)
	);
}

const COUNTS: { status: DeckStatus[]; label: string; x: number; row: number }[] = [
	{ status: ["input", "error"], label: "ask", x: LEFT, row: 0 },
	{ status: ["working", "background"], label: "work", x: 72, row: 0 },
	{ status: ["done", "review"], label: "done", x: LEFT, row: 1 },
	{ status: ["idle"], label: "idle", x: 72, row: 1 },
];

function counts(views: WorktreeView[]) {
	return COUNTS.map((c) => {
		const n = views.filter((v) => c.status.includes(v.status)).length;
		const color = n === 0 || c.label === "idle" ? "#FFFFFF" : STATUS_STYLE[c.status[0]].color;
		return left(c.x, ROWS[c.row] + 5, 15, color, `${n} ${c.label}`);
	}).join("");
}

/** Two centered lines: a title and a scrolling message. */
function message(title: string, color: string, detail: string, now: number) {
	return text(72, ROWS[0] + 5, 15, color, title) + text(72, ROWS[1] + 5, 14, "#FFFFFF", marquee(detail, 12, now), 600);
}

function top({ connection, views, hooksIssue, activeContext, now }: StatusFrame) {
	if (connection === "no-cli") return message("ORCA", STATUS_STYLE.error.color, "CLI not found · set its path in the plugin settings", now);
	if (connection !== "ok") return message("ORCA", "#FFFFFF", connection === "starting" ? "connecting…" : "offline", now);
	if (hooksIssue) return message("⚠ HOOKS", STATUS_STYLE.working.color, hooksIssue, now);
	if (activeContext) {
		const pct = Math.round(activeContext.context.percent);
		return gauge(ROWS[0], "ctx", pct) + text(72, ROWS[1] + 5, 14, "#FFFFFF", marquee(activeContext.name, 12, now), 600);
	}
	return counts(views);
}

function bottom(usage: Usage | null, now: number) {
	const window = (w: UsageWindow | null) => (w ? Math.round(w.usedPercent) : null);
	if (usage?.error) {
		const name = usage.provider.charAt(0).toUpperCase() + usage.provider.slice(1);
		return text(72, ROWS[2] + 5, 13, "#FFFFFF", `${name} usage`) + text(72, ROWS[3] + 5, 13, "#FFFFFF", marquee(`unavailable: ${usage.error}`, 13, now, 250), 500);
	}
	if (usage && !usage.session && !usage.weekly && usage.monthly) {
		const { usedPercent, used, limit } = usage.monthly;
		return gauge(ROWS[2], "mo", Math.round(usedPercent)) + text(72, ROWS[3] + 5, 15, "#FFFFFF", `${formatMoney(used)} / ${formatMoney(limit)}`);
	}
	if (!usage || (!usage.session && !usage.weekly)) return text(72, (ROWS[2] + ROWS[3]) / 2 + 5, 13, "#FFFFFF", "usage: loading…", 500);
	return gauge(ROWS[2], "5h", window(usage.session)) + gauge(ROWS[3], "7d", window(usage.weekly));
}

export function renderStatus(f: StatusFrame): string {
	const divider = `<rect x="${LEFT}" y="73" width="${RIGHT - LEFT}" height="2" rx="1" fill="${FRAME}"/>`;
	return frame(FRAME, 0, top(f) + divider + bottom(f.usage, f.now));
}
