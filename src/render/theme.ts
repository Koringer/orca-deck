import type { DeckStatus } from "../orca/model.ts";

/** Input, error and working breathe; the other statuses are static. */
export const STATUS_STYLE: Record<DeckStatus, { color: string; label: string; breatheMs: number | null }> = {
	input: { color: "#2F9BFF", label: "INPUT", breatheMs: 1100 },
	error: { color: "#FF4D4F", label: "ERROR", breatheMs: 1500 },
	working: { color: "#FFB020", label: "WORKING", breatheMs: 2400 },
	background: { color: "#FFE600", label: "BACKGROUND", breatheMs: null },
	done: { color: "#2BD576", label: "DONE", breatheMs: null },
	review: { color: "#A970FF", label: "REVIEW", breatheMs: null },
	idle: { color: "#5A5F6B", label: "IDLE", breatheMs: null },
};

export const BG = "#0B0D12";
export const MUTED = "#C8CCD6";
export const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";

/**
 * Breathing level 0..1 (the key's border swells from its base width to full width and back),
 * quantized to 12 steps so the key image only changes about 24 times per cycle. 0 (base width) when
 * the status doesn't breathe.
 */
export function breathe(now: number, periodMs: number | null): number {
	if (!periodMs) return 0;
	const phase = (now % periodMs) / periodMs;
	const v = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI);
	return Math.round(v * 12) / 12;
}

/** Character-window marquee: returns the visible slice of `text`, pausing at the start of each loop. */
export function marquee(text: string, width: number, now: number, stepMs = 180, pauseSteps = 8): string {
	if (text.length <= width) return text;
	const gap = "   ";
	const loop = text + gap;
	const step = Math.floor(now / stepMs) % (loop.length + pauseSteps);
	const offset = Math.max(0, step - pauseSteps);
	return (loop + loop).slice(offset, offset + width);
}

export function elapsed(since: number | null, now: number): string {
	if (since == null) return "";
	const s = Math.max(0, Math.floor((now - since) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return h < 24 ? `${h}h${String(m % 60).padStart(2, "0")}` : `${Math.floor(h / 24)}d`;
}
