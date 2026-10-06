import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * How full a Claude Code session's context window is, computed like Claude Code's status line:
 * input + cache-creation + cache-read tokens of the last main-thread assistant message.
 *
 * The live session for a worktree comes from ~/.claude/sessions/<pid>.json (cwd → sessionId); its
 * transcript is ~/.claude/projects/<cwd with non-alphanumerics replaced by "-">/<sessionId>.jsonl.
 */

export type ContextUsage = { tokens: number; window: number; percent: number; model: string | null };

const CLAUDE_DIR = join(homedir(), ".claude");
/** Only the end of the transcript is read; the last assistant message is always near it. */
const TAIL_BYTES = 512 * 1024;

/** Context window by model; current Claude models have 1M tokens, older ones and Haiku 200k. */
export function contextWindow(model: string | null, tokens: number): number {
	const m = model ?? "";
	const window = /\[1m\]/i.test(m) || /claude-(opus|sonnet|fable)-[5-9]/.test(m) ? 1_000_000 : 200_000;
	return tokens > window ? 1_000_000 : window;
}

export function transcriptDir(cwd: string): string {
	return join(CLAUDE_DIR, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

type Usage = { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };

/** Parses the last main-thread assistant message with usage from JSONL text. */
export function contextFromTranscript(text: string): ContextUsage | null {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line.includes('"usage"')) continue;
		let entry: { type?: string; isSidechain?: boolean; message?: { model?: string; usage?: Usage } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // first line of the tail may be cut
		}
		const usage = entry.message?.usage;
		if (entry.type !== "assistant" || entry.isSidechain || !usage) continue;
		const tokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
		const model = entry.message?.model ?? null;
		const window = contextWindow(model, tokens);
		return { tokens, window, percent: Math.min(100, (tokens / window) * 100), model };
	}
	return null;
}

async function readTail(path: string): Promise<string> {
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		const length = Math.min(size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		await file.read(buffer, 0, length, size - length);
		return buffer.toString("utf8");
	} finally {
		await file.close();
	}
}

/** Session id of the most recently active live Claude Code session running in `cwd`. */
async function liveSessionId(cwd: string): Promise<string | null> {
	const dir = join(CLAUDE_DIR, "sessions");
	const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
	let best: { id: string; at: number } | null = null;
	for (const f of files) {
		try {
			const s = JSON.parse(await readFile(join(dir, f), "utf8")) as { cwd?: string; sessionId?: string; updatedAt?: number };
			if (s.cwd !== cwd || !s.sessionId) continue;
			const at = s.updatedAt ?? 0;
			if (!best || at > best.at) best = { id: s.sessionId, at };
		} catch {
			// ignore unreadable entries
		}
	}
	return best?.id ?? null;
}

export async function contextForWorktree(cwd: string): Promise<ContextUsage | null> {
	const sessionId = await liveSessionId(cwd);
	if (!sessionId) return null;
	const text = await readTail(join(transcriptDir(cwd), `${sessionId}.jsonl`)).catch(() => null);
	return text ? contextFromTranscript(text) : null;
}
