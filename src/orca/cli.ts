import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Error returned by the Orca CLI (`{ ok: false, error: { code, message } }`) or by spawning it. */
export class OrcaError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/**
 * Finds the `orca` executable. Checked in order: explicit override, PATH, then the default
 * install locations of the desktop app on macOS / Windows / Linux, so the plugin works on any
 * machine with Orca installed without configuration.
 */
export function resolveOrcaBinary(override?: string): string | null {
	if (override && existsSync(override)) return override;

	const isWin = process.platform === "win32";
	const names = isWin ? ["orca.cmd", "orca.exe", "orca"] : ["orca"];
	// The Stream Deck app launches plugins with a minimal PATH, so add the usual shell locations.
	const pathDirs = [
		...(process.env.PATH ?? "").split(delimiter),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		join(homedir(), ".local/bin"),
	];
	for (const dir of pathDirs) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (dir && existsSync(candidate)) return candidate;
		}
	}

	const appCandidates = isWin
		? [
				join(process.env.LOCALAPPDATA ?? "", "Programs/Orca/resources/bin/orca.cmd"),
				join(process.env.PROGRAMFILES ?? "C:/Program Files", "Orca/resources/bin/orca.cmd"),
			]
		: [
				"/Applications/Orca.app/Contents/Resources/bin/orca",
				join(homedir(), "Applications/Orca.app/Contents/Resources/bin/orca"),
				"/opt/Orca/resources/bin/orca",
				"/usr/lib/orca/resources/bin/orca",
			];
	return appCandidates.find((c) => existsSync(c)) ?? null;
}

const READ_ONLY = new Set(["worktree ps", "terminal list", "account list", "repo list"]);

export class OrcaCli {
	private readonly getBinary: () => string | null;
	private readonly onCommand: (args: string[]) => void;

	/** `onCommand` is told about every command that changes something in Orca (not the polling reads). */
	constructor(getBinary: () => string | null, onCommand: (args: string[]) => void = () => {}) {
		this.getBinary = getBinary;
		this.onCommand = onCommand;
	}

	/** Runs `orca <args> --json` and returns `result`, throwing {@link OrcaError} on failure. */
	run<T = unknown>(args: string[], timeoutMs = 15_000): Promise<T> {
		const bin = this.getBinary();
		if (!bin) return Promise.reject(new OrcaError("cli_not_found", "Orca CLI not found"));
		if (!READ_ONLY.has(args.slice(0, 2).join(" "))) this.onCommand(args);

		return new Promise((resolve, reject) => {
			execFile(
				bin,
				[...args, "--json"],
				{ timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: bin.endsWith(".cmd") },
				(err, stdout) => {
					let parsed: { ok?: boolean; result?: T; error?: { code?: string; message?: string } } | null = null;
					try {
						parsed = JSON.parse(stdout);
					} catch {
						// fall through
					}
					if (parsed?.ok) return resolve(parsed.result as T);
					if (parsed?.error) {
						return reject(new OrcaError(parsed.error.code ?? "orca_error", parsed.error.message ?? "Orca error"));
					}
					reject(new OrcaError("cli_failed", err?.message ?? "Unexpected Orca CLI output"));
				},
			);
		});
	}
}
