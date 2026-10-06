import * as esbuild from "esbuild";
import { writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outdir = "dev.orcadeck.sdPlugin/bin";

const options = {
	entryPoints: ["src/plugin.ts"],
	outfile: `${outdir}/plugin.js`,
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	minify: !watch,
	sourcemap: watch,
	// Some dependencies use require() of node built-ins.
	banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
	logLevel: "info",
};

if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
} else {
	await esbuild.build(options);
}
writeFileSync(`${outdir}/package.json`, `{ "type": "module" }\n`);
