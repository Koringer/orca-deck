import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Token usage of the Claude account Claude Code is logged into, read like Claude Code's `/usage`:
 * the OAuth access token Claude Code stores (macOS Keychain item "Claude Code-credentials", or
 * ~/.claude/.credentials.json elsewhere) is sent to Anthropic's usage endpoint. The token is only
 * read: never written, refreshed, logged, or sent anywhere else.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export type Money = { amount: number; currency: string };

export type ClaudeUsage = {
	/** 5-hour window, % used. */
	session: { usedPercent: number; resetsAt: number | null } | null;
	/** 7-day window, % used. */
	weekly: { usedPercent: number; resetsAt: number | null } | null;
	/** Monthly spend cap (organization plans, usage credits). */
	monthly: { usedPercent: number; used: Money; limit: Money } | null;
};

export class ClaudeUsageError extends Error {
	/** Set on HTTP 429: how long Anthropic asks to wait before the next request. */
	readonly retryAfterMs: number | null;

	constructor(message: string, retryAfterMs: number | null = null) {
		super(message);
		this.retryAfterMs = retryAfterMs;
	}
}

type Window = { utilization?: number | null; resets_at?: string | null } | null | undefined;
type Amount = { amount_minor?: number; currency?: string; exponent?: number } | null | undefined;
type UsageResponse = {
	five_hour?: Window;
	seven_day?: Window;
	spend?: { used?: Amount; limit?: Amount; percent?: number | null; enabled?: boolean } | null;
};

async function readToken(): Promise<string | null> {
	let raw: string | null = null;
	if (process.platform === "darwin") {
		raw = await new Promise((resolve) =>
			execFile("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 10_000 }, (err, stdout) =>
				resolve(err ? null : stdout),
			),
		);
	}
	raw ??= await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8").catch(() => null);
	if (!raw) return null;
	try {
		return JSON.parse(raw)?.claudeAiOauth?.accessToken ?? null;
	} catch {
		return null;
	}
}

const pct = (n: number) => Math.min(100, Math.max(0, n));

function window(w: Window): ClaudeUsage["session"] {
	if (typeof w?.utilization !== "number") return null;
	const resetsAt = w.resets_at ? Date.parse(w.resets_at) : NaN;
	return { usedPercent: pct(w.utilization), resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

function money(a: Amount): Money | null {
	if (typeof a?.amount_minor !== "number") return null;
	return { amount: a.amount_minor / 10 ** (a.exponent ?? 2), currency: a.currency ?? "USD" };
}

export function parseUsage(body: UsageResponse): ClaudeUsage {
	const used = money(body.spend?.used);
	const limit = money(body.spend?.limit);
	const monthly =
		// A cap that isn't "enabled" is extra credits on top of 5h/7d limits; without those windows it's the plan's limit.
		used && limit && limit.amount > 0 && (body.spend?.enabled !== false || (!body.five_hour && !body.seven_day))
			? { usedPercent: pct(typeof body.spend?.percent === "number" ? body.spend.percent : (used.amount / limit.amount) * 100), used, limit }
			: null;
	return { session: window(body.five_hour), weekly: window(body.seven_day), monthly };
}

export async function fetchClaudeUsage(): Promise<ClaudeUsage> {
	const token = await readToken();
	if (!token) throw new ClaudeUsageError("Claude Code login not found");
	const res = await fetch(USAGE_URL, {
		headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "orca-deck" },
		signal: AbortSignal.timeout(10_000),
	});
	if (res.status === 401) throw new ClaudeUsageError("Claude login expired: open Claude Code to refresh it");
	if (res.status === 429) {
		const seconds = Number(res.headers.get("retry-after"));
		throw new ClaudeUsageError("Claude usage API: rate limited", (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000);
	}
	if (!res.ok) throw new ClaudeUsageError(`Claude usage API: HTTP ${res.status}`);
	return parseUsage((await res.json()) as UsageResponse);
}

export function formatMoney({ amount, currency }: Money): string {
	const symbol = ({ USD: "$", EUR: "€", GBP: "£" } as Record<string, string>)[currency];
	const value = Number.isInteger(amount) ? String(amount) : amount.toFixed(amount < 10 ? 2 : 0);
	return symbol ? (currency === "EUR" ? `${value}${symbol}` : `${symbol}${value}`) : `${value} ${currency}`;
}
