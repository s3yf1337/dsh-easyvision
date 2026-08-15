#!/usr/bin/env node
/**
 * Patch the installed `@deepseek-ai/dsh-host-apiproxy` so dsh-easyvision
 * integrates with the host's image admission. Two idempotent edits:
 *
 * 1. Settings visibility: add `easyvision` to `WEB_SETTINGS_NAMESPACES` so
 *    the Settings page can expose the EasyVision section. The harness's API
 *    gateway deliberately serves only an explicit allowlist of settings
 *    namespaces to the browser; there is no plugin seam for it yet (the
 *    harness code itself marks moving that declaration to
 *    `settings.register()` as deferred work).
 *
 * 2. Image admission: in `session.prompt`, when the session's model is
 *    text-only and the user attached images, consult the `easyvision`
 *    service instead of rejecting unconditionally:
 *      - plugin active + configured + vision-capable → the bridge describes
 *        the images through the vision model and the prompt is ADMITTED as
 *        text (the image is "sent" as its description);
 *      - plugin absent or unhealthy → the client receives an actionable
 *        configuration error instead of the generic "switch to a model that
 *        supports images" refusal.
 *
 * Run: node scripts/patch-dsh-host.mjs
 * (re-run after every dsh upgrade; both steps are no-ops when already applied)
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
let source = await readFile(target, "utf8");

// ── step 1: expose the settings namespace to the web client ───────────────
{
	const start = source.indexOf(BLOCK_START);
	if (start === -1) {
		throw new Error(`cannot find ${BLOCK_START} in ${target}; the installed dsh version may have changed`);
	}
	const end = source.indexOf("];", start);
	if (end === -1) {
		throw new Error(`cannot find the closing "];" of ${BLOCK_START} in ${target}`);
	}
	const block = source.slice(start, end + 2);
	if (!block.includes(`"${NAMESPACE}"`)) {
		const patchedBlock = `${block.slice(0, -2).trimEnd()},
\t"${NAMESPACE}"
];`;
		source = source.slice(0, start) + patchedBlock + source.slice(end + 2);
		console.log(`step 1: added "${NAMESPACE}" to WEB_SETTINGS_NAMESPACES`);
	} else {
		console.log(`step 1: already patched ("${NAMESPACE}" is in WEB_SETTINGS_NAMESPACES)`);
	}
}

// ── step 2: image admission bridge in session.prompt ──────────────────────
{
	// Marker of an applied bridge patch (also used as the error code).
	if (source.includes("easyvision-unavailable")) {
		console.log("step 2: already patched (image-admission bridge is applied)");
	} else {
		const destructure = "const { sessionId, mode, content, clientTimeZone } = request.payload;";
		const destructureAt = source.indexOf(destructure);
		if (destructureAt === -1) {
			throw new Error(`cannot find the session.prompt payload destructure in ${target}; the installed dsh version may have changed`);
		}
		const reasonMarker = 'details: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" }';
		const reasonAt = source.indexOf(reasonMarker);
		if (reasonAt === -1) {
			throw new Error(`cannot find the MODEL_DOES_NOT_SUPPORT_IMAGES refusal in ${target}; the installed dsh version may have changed`);
		}
		const rawStart = source.lastIndexOf("if (hasImage) {", reasonAt);
		if (rawStart === -1 || rawStart < destructureAt) {
			throw new Error(`cannot delimit the image-admission block in ${target}; the installed dsh version may have changed`);
		}
		// Replace whole lines: the block starts at the head of the line that
		// opens `if (hasImage) {` and ends after the line that closes it.
		const blockStart = source.lastIndexOf("\n", rawStart) + 1;
		const errClose = source.indexOf("});", reasonAt);
		if (errClose === -1) {
			throw new Error(`cannot delimit the image-admission block close in ${target}; the installed dsh version may have changed`);
		}
		const closeLineStart = source.indexOf("\n", errClose) + 1;
		const blockEnd = source.indexOf("\n", closeLineStart) + 1;
		if (blockEnd === 0) {
			throw new Error(`cannot find the image-admission block end in ${target}; the installed dsh version may have changed`);
		}

		// `content` becomes writable so the bridge can replace the parts.
		const destructured = "const { sessionId, mode, clientTimeZone } = request.payload;\n\t\t\t\tlet content = request.payload.content;";
		source = source.slice(0, destructureAt) + destructured + source.slice(destructureAt + destructure.length);

		const bridgeBlock = `\t\t\t\t\t\tif (hasImage) {
\t\t\t\t\t\t\tconst current = selectionFor(agent).current;
\t\t\t\t\t\t\tconst modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model);
\t\t\t\t\t\t\tif (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) {
\t\t\t\t\t\t\t\t// dsh-easyvision bridge (applied by scripts/patch-dsh-host.mjs): a
\t\t\t\t\t\t\t\t// text-only model cannot take image blocks, but the easyvision
\t\t\t\t\t\t\t\t// plugin can describe them. The prompt is admitted only when the
\t\t\t\t\t\t\t\t// plugin is active and its vision model resolves; otherwise the
\t\t\t\t\t\t\t\t// client gets an actionable configuration error instead of the
\t\t\t\t\t\t\t\t// generic "switch to a model that supports images" refusal.
\t\t\t\t\t\t\t\tconst vision = ctx.get("easyvision");
\t\t\t\t\t\t\t\tif (vision === void 0 || typeof vision.describePromptContent !== "function") return err(request, {
\t\t\t\t\t\t\t\t\tcode: "easyvision-unavailable",
\t\t\t\t\t\t\t\t\tmessage: "Images cannot be sent to this text-only model: the dsh-easyvision plugin is not active. Install it and configure a vision model in Settings → EasyVision, or switch to a model that supports images.",
\t\t\t\t\t\t\t\t\tdetails: {}
\t\t\t\t\t\t\t\t});
\t\t\t\t\t\t\t\ttry {
\t\t\t\t\t\t\t\t\tcontent = await vision.describePromptContent(content);
\t\t\t\t\t\t\t\t} catch (error) {
\t\t\t\t\t\t\t\t\treturn err(request, {
\t\t\t\t\t\t\t\t\t\tcode: error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "easyvision-rejected",
\t\t\t\t\t\t\t\t\t\tmessage: \`Images cannot be sent to this text-only model: \${error instanceof Error ? error.message : String(error)}. Fix the EasyVision configuration in Settings → EasyVision, or switch to a model that supports images.\`,
\t\t\t\t\t\t\t\t\t\tdetails: {}
\t\t\t\t\t\t\t\t\t});
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}
`;
		// Re-find the block in the mutated source (the destructure edit shifted offsets).
		const shiftedReason = source.indexOf(reasonMarker);
		const shiftedRawStart = source.lastIndexOf("if (hasImage) {", shiftedReason);
		const shiftedBlockStart = source.lastIndexOf("\n", shiftedRawStart) + 1;
		const shiftedErrClose = source.indexOf("});", shiftedReason);
		const shiftedCloseLine = source.indexOf("\n", shiftedErrClose) + 1;
		const shiftedBlockEnd = source.indexOf("\n", shiftedCloseLine) + 1;
		source = source.slice(0, shiftedBlockStart) + bridgeBlock + source.slice(shiftedBlockEnd);
		console.log("step 2: image-admission bridge applied to session.prompt");
	}
}

await writeFile(target, source);

// Sanity-check the edited file parses.
const check = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
if (check.status !== 0) {
	throw new Error(`patched file fails node --check:\n${check.stderr}`);
}

console.log(`patched ${target}`);
console.log("- easyvision settings namespace exposed to the Settings page (idempotent)");
console.log("- session.prompt admits images through the easyvision bridge when the model is text-only (idempotent)");
console.log("restart the harness (pkill -f 'dsh --profile desktop' && dsh --profile desktop) for the change to take effect");
