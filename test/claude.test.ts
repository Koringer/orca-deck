import assert from "node:assert/strict";
import { test } from "node:test";

import { contextFromTranscript, contextWindow, transcriptDir } from "../src/claude/context.ts";
import { formatMoney, parseUsage } from "../src/claude/usage.ts";

test("usage: 5h/7d windows (Max plan, extra credits disabled)", () => {
	const u = parseUsage({
		five_hour: { utilization: 2, resets_at: "2026-10-06T18:40:00.350796+00:00" },
		seven_day: { utilization: 4, resets_at: "2026-10-06T18:00:00+00:00" },
		spend: { used: { amount_minor: 0, currency: "EUR", exponent: 2 }, limit: { amount_minor: 8500, currency: "EUR", exponent: 2 }, percent: 0, enabled: false },
	});
	assert.equal(u.session?.usedPercent, 2);
	assert.equal(u.weekly?.usedPercent, 4);
	assert.equal(u.monthly, null);
});

test("usage: organization plan with a monthly spend cap only", () => {
	const u = parseUsage({
		five_hour: null,
		seven_day: null,
		spend: { used: { amount_minor: 3600, currency: "USD", exponent: 2 }, limit: { amount_minor: 10000, currency: "USD", exponent: 2 }, percent: 36, enabled: true },
	});
	assert.equal(u.session, null);
	assert.equal(u.monthly?.usedPercent, 36);
	assert.equal(`${formatMoney(u.monthly!.used)} / ${formatMoney(u.monthly!.limit)}`, "$36 / $100");
});

test("context: last main-thread assistant message, like the status line", () => {
	const lines = [
		'{"type":"assistant","message":{"model":"claude-opus-5-5","usage":{"input_tokens":5,"cache_read_input_tokens":1000}}}',
		'{"type":"assistant","isSidechain":true,"message":{"model":"claude-haiku-4-5","usage":{"input_tokens":999999}}}',
		'{"type":"assistant","message":{"model":"claude-opus-5-5","usage":{"input_tokens":2,"cache_creation_input_tokens":26873,"cache_read_input_tokens":25144,"output_tokens":142}}}',
		'{"type":"user","message":{"content":"hi"}}',
	];
	const c = contextFromTranscript(`cut-off partial line"}\n${lines.join("\n")}\n`);
	assert.equal(c?.tokens, 52019);
	assert.equal(c?.window, 1_000_000);
	assert.equal(Math.floor(c!.percent), 5, "matches the 5% Claude Code's status line showed");
});

test("context window by model and transcript folder naming", () => {
	assert.equal(contextWindow("claude-haiku-4-5-20251001", 10), 200_000);
	assert.equal(contextWindow("claude-sonnet-5-5", 10), 1_000_000);
	assert.equal(contextWindow("claude-haiku-4-5", 300_000), 1_000_000);
	assert.match(transcriptDir("/Users/me/Desktop/Stream deck Agent"), /-Users-me-Desktop-Stream-deck-Agent$/);
});
