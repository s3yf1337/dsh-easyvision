#!/usr/bin/env node
/**
 * Expose the dsh-easyvision settings namespace to the Web configuration
 * client by adding it to `WEB_SETTINGS_NAMESPACES` in the installed
 * `@deepseek-ai/dsh-host-apiproxy`.
 *
 * The harness's API gateway deliberately serves only an explicit allowlist
 * of settings namespaces to the browser; there is no plugin seam for it yet
 * (the harness code itself marks moving that declaration to
 * `settings.register()` as deferred work). Until then, third-party settings
 * pages need this one-line, idempotent patch to the installed package.
 *
 * Run: node scripts/patch-dsh-host.mjs
 * (re-run after every dsh upgrade; it is a no-op when already applied)
 */
import { createRequire } from "node:module";
import { access, realpath, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const NAMESPACE = "easyvision";
const BLOCK_START = "const WEB_SETTINGS_NAMESPACES = [";
const PACKAGE = "@deepseek-ai/dsh-host-apiproxy";

/** Locate the installed dsh-host-apiproxy package directory. */
async function resolvePackageDir() {
	const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
	// 1. The profiles module fallback symlink (created by the dsh launcher).
	const fallback = join(dshHome, "profiles", "node_modules", PACKAGE);
	try {
		await access(fallback);
		return await realpath(fallback);
	} catch {
		// fall through
	}
	// 2. The dsh CLI installation's bundled node_modules.
	const binPath = spawnSync("which", ["dsh"], { encoding: "utf8" }).stdout.trim();
	if (binPath !== "") {
		const candidate = join(dirname(await realpath(binPath)), "node_modules", PACKAGE);
		try {
			await access(candidate);
			return await realpath(candidate);
		} catch {
			// fall through
		}
	}
	// 3. This script's own module tree (works when the repo is installed in
	// a tree that carries the harness packages).
	const require = createRequire(import.meta.url);
	try {
		return dirname(require.resolve(`${PACKAGE}/package.json`));
	} catch {
		// fall through
	}
	throw new Error(
		`cannot locate ${PACKAGE}; pass DSH_HOME or install dsh first`
	);
}

const pkgDir = await resolvePackageDir();
const target = join(pkgDir, "lib", "index.js");
const source = await readFile(target, "utf8");

const start = source.indexOf(BLOCK_START);
if (start === -1) {
	throw new Error(`cannot find ${BLOCK_START} in ${target}; the installed dsh version may have changed`);
}
const end = source.indexOf("];", start);
if (end === -1) {
	throw new Error(`cannot find the closing "];" of ${BLOCK_START} in ${target}`);
}
const block = source.slice(start, end + 2);

if (block.includes(`"${NAMESPACE}"`)) {
	console.log(`already patched: ${NAMESPACE} is in WEB_SETTINGS_NAMESPACES at ${target}`);
	process.exit(0);
}

const patchedBlock = `${block.slice(0, -2).trimEnd()},
\t"${NAMESPACE}"
];`;
const patched = source.slice(0, start) + patchedBlock + source.slice(end + 2);
await writeFile(target, patched);

// Sanity-check the edited file parses.
const check = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
if (check.status !== 0) {
	throw new Error(`patched file fails node --check:\n${check.stderr}`);
}

console.log(`patched ${target}`);
console.log(`- ${NAMESPACE} added to WEB_SETTINGS_NAMESPACES (idempotent)`);
console.log("restart the harness (pkill -f 'dsh --profile desktop' && dsh --profile desktop) for the change to take effect");
