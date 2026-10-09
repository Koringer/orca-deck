import type { Connection, SlotState } from "../orca/store.ts";
import { BG, breathe, FONT, marquee, MUTED, STATUS_STYLE } from "./theme.ts";

const SIZE = 144;
const BORDER = 14;
/** Characters that fit on one line at the given font size inside the border (bold sans ≈ 0.6em/char). */
const fit = (fontSize: number) => Math.floor((SIZE - 2 * BORDER - 8) / (fontSize * 0.6));

export type KeyFrame = {
	connection: Connection;
	slot: SlotState;
	now: number;
	/** 0..1 while the key is held down, null otherwise. */
	hold: number | null;
};

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function text(x: number, y: number, size: number, fill: string, value: string, weight = 700) {
	return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="middle">${esc(value)}</text>`;
}

/** Border width of every key; breathing statuses swell from it up to BORDER. */
const MIN_BORDER = 8;
/** Corner radius of the border's outer edge, kept constant while its width changes. */
const OUTER_RADIUS = 29;

/** `level` 0..1: border width from MIN_BORDER (static) to BORDER, growing inward from a fixed outer edge. */
export function frame(color: string, level: number, body: string) {
	const width = MIN_BORDER + (BORDER - MIN_BORDER) * level;
	const inset = width / 2;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
		`<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>` +
		`<rect x="${inset}" y="${inset}" width="${SIZE - width}" height="${SIZE - width}" rx="${OUTER_RADIUS - inset}" fill="none" stroke="${color}" stroke-width="${width}"/>` +
		body +
		`</svg>`
	);
}

/**
 * Greedy word wrap on `-`, `_`, `/` and spaces; words longer than a line are cut. Returns null when
 * the text doesn't fit in `maxLines`.
 */
export function wrap(name: string, perLine: number, maxLines: number): string[] | null {
	const words = name.split(/(?<=[-_/ ])/).flatMap((w) => w.match(new RegExp(`.{1,${perLine}}`, "gu")) ?? []);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		if ((line + word).trimEnd().length <= perLine) line += word;
		else {
			lines.push(line.trimEnd());
			line = word.trimStart();
		}
	}
	if (line.trim()) lines.push(line.trimEnd());
	return lines.length <= maxLines ? lines : null;
}

/** Font sizes tried in turn until the name fits on 3 lines. */
const NAME_SIZES = [18, 16, 14];

/** Up to 3 centered lines above the status label, shrinking the font rather than scrolling. */
function nameBlock(name: string, now: number): string {
	for (const size of NAME_SIZES) {
		const lines = wrap(name, fit(size), 3);
		if (!lines) continue;
		const lineHeight = size + 2;
		const first = 64 - ((lines.length - 1) * lineHeight) / 2;
		return lines.map((l, i) => text(72, first + i * lineHeight, size, "#FFFFFF", l)).join("");
	}
	const size = NAME_SIZES[NAME_SIZES.length - 1];
	return text(72, 64, size, "#FFFFFF", marquee(name, fit(size), now, 160, 8));
}

/** Relative luminance (WCAG) of a `#RRGGBB` color. */
function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Orchestrator badge: a pill on the top edge of the border, in the status color, with a diamond and
 * the number of workers still in progress. It sits on the border so the name keeps its 3 lines.
 */
function orchestratorBadge(color: string, workers: number): string {
	const label = String(workers);
	const width = 40 + label.length * 9;
	const x = (SIZE - width) / 2;
	// Diamond drawn as a path: glyphs like ◆ depend on the fonts of the machine rasterizing the key.
	const dx = x + 15;
	const ink = luminance(color) > 0.4 ? BG : "#FFFFFF";
	return (
		`<rect x="${x}" y="0" width="${width}" height="22" rx="11" fill="${color}"/>` +
		`<path d="M${dx} 5.5 L${dx + 5.5} 11 L${dx} 16.5 L${dx - 5.5} 11 Z" fill="${ink}"/>` +
		`<text x="${dx + 10}" y="16" font-family="${FONT}" font-size="15" font-weight="800" fill="${ink}">${label}</text>`
	);
}

function holdOverlay(progress: number, label: string): string {
	const w = SIZE - 2 * BORDER - 12;
	return (
		`<rect x="${MIN_BORDER}" y="${MIN_BORDER}" width="${SIZE - 2 * MIN_BORDER}" height="${SIZE - 2 * MIN_BORDER}" rx="${OUTER_RADIUS - MIN_BORDER}" fill="#000"/>` +
		text(72, 66, 40, "#FFFFFF", "↻", 400) +
		text(72, 92, 15, "#FFFFFF", label) +
		`<rect x="${BORDER + 6}" y="104" width="${w}" height="8" rx="4" fill="#333845"/>` +
		`<rect x="${BORDER + 6}" y="104" width="${Math.round(w * Math.min(1, progress))}" height="8" rx="4" fill="#FFFFFF"/>`
	);
}

export function renderKey({ connection, slot, now, hold }: KeyFrame): string {
	if (connection === "no-cli") {
		return frame(STATUS_STYLE.error.color, 0, text(72, 60, 22, "#FFF", "ORCA") + text(72, 86, 14, MUTED, "CLI not found"));
	}
	if (connection === "offline" || connection === "starting") {
		const label = connection === "starting" ? "connecting…" : "offline";
		return frame(
			STATUS_STYLE.idle.color,
			1,
			text(72, 58, 22, "#FFF", "ORCA") + text(72, 82, 14, MUTED, label) + (connection === "offline" ? text(72, 104, 12, MUTED, "press to open") : ""),
		);
	}

	const pending = slot.pending;
	if (pending?.kind === "awaiting") {
		return frame("#FFFFFF", 0, text(72, 58, 17, "#FFF", "NAME IT") + text(72, 80, 17, "#FFF", "IN ORCA") + text(72, 106, 13, MUTED, "waiting…", 500));
	}
	if (pending?.kind === "error") {
		return frame(STATUS_STYLE.error.color, 0, text(72, 58, 18, "#FFF", "FAILED") + text(72, 86, 14, "#FFF", marquee(pending.message, 12, now, 180)));
	}

	if (slot.kind === "empty") {
		const body = text(72, 96, 84, "#6B7280", "+", 300);
		return frame("#2A2E38", 0, hold !== null && hold > 0.15 ? body + holdOverlay(hold, "NEW TASK") : body);
	}

	const { view } = slot;
	const style = STATUS_STYLE[view.status];
	// Long labels (BACKGROUND) get a smaller font so they stay inside the border.
	const labelSize = Math.min(17, Math.floor((SIZE - 2 * BORDER - 8) / (style.label.length * 0.8)));
	let body = nameBlock(view.name, now) + text(72, 114, labelSize, style.color, style.label);
	if (view.workers !== null) body += orchestratorBadge(style.color, view.workers);
	if (hold !== null && hold > 0.15) body += holdOverlay(hold, "NEW TASK");
	return frame(style.color, breathe(now, style.breatheMs), body);
}

export function toDataUrl(svg: string): string {
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}
