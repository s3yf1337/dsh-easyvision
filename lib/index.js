import { basename, extname } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { AttachmentError } from "@deepseek-ai/dsh-attachment";
import { FsError } from "@deepseek-ai/dsh-fs";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

/**
 * @deepseek-ai/dsh-easyvision — describe images through a dedicated vision model.
 *
 * The main conversation model is usually text-only, so image files cannot be
 * handed to it directly. This plugin registers one model-facing tool
 * (`describe_image` by default) that reads image files through the harness's
 * own filesystem seam, commits them through the durable attachment service,
 * and sends them to a vision-capable model from the dsh model list over
 * `ctx.llm` — the exact same LLM runtime the agent loop itself uses. The
 * vision model's description comes back as plain text the main model can
 * read, so a text-only conversation can still "see" pictures.
 *
 * The vision model is chosen through the `easyvision` settings namespace
 * (Settings → EasyVision in the web UI, or the `easyvision:` section of
 * `settings.yaml`); the plugin's own entry config supplies the composition
 * base layer, so a profile without a settings service keeps working exactly
 * as composed. Changes apply live — the tool reads the resolved value on
 * every call.
 *
 * The tool registers only while a durable attachment store is mounted, mirror
 * the `read_image` convention: without one the harness cannot commit image
 * bytes. Execution refuses when the configured model does not declare image
 * input, before any filesystem I/O.
 *
 * @module dsh-easyvision
 */

/** Stable Cordis plugin name used by loader diagnostics. */
const name = "easyvision";

/** Services required by this plugin. `attachments`/`settings` are optional and wired per-registration. */
const inject = ["tools", "llm", "fs", "systemPrompt"];

/** Media type by lowercase extension; anything else is not a supported image. */
const IMAGE_MEDIA_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif"
};

const Config = z.object({
	/** Provider route owning the vision model (as listed by dsh's model list). */
	provider: z.string().default("opencode-go"),
	/**
	 * Model id from that provider's model list, must declare image input.
	 * Defaults to qwen3.7-plus: cheap and a large request quota. mimo-v2.5 is
	 * even cheaper on quota but the opencode-go upstream currently rejects it.
	 */
	model: z.string().default("qwen3.7-plus"),
	/** Optional output cap for the vision call; omitted leaves the adapter default. */
	maxTokens: z.natural().min(1),
	/** Model-facing tool name. */
	toolName: z.string().default("describe_image"),
	/** System prompt sent to the vision model. */
	systemPrompt: z.string().default("You are a helpful vision assistant. Look carefully at the provided image(s) and answer the user's question accurately and concisely."),
	/** Question used when the model calls the tool without an explicit prompt. */
	defaultPrompt: z.string().default("Describe what you see in this image in detail: the main subjects, the setting, any visible text, and notable details.")
});

/** Settings namespace carrying the vision model selection (Settings → EasyVision). */
const SETTINGS_NAMESPACE = settingsNamespace("easyvision");
/** Schema of the EasyVision settings section (no defaults: the entry config is the base layer). */
const SETTINGS_SCHEMA = z.object({
	provider: z.string(),
	model: z.string(),
	maxTokens: z.natural().min(1),
	systemPrompt: z.string(),
	defaultPrompt: z.string()
});

/** Model-facing wording for the tool description (deliberately model-agnostic). */
function toolDescription() {
	return "Send one or more image files to the dedicated vision model configured in Settings → EasyVision and return its description as text. Your own model is text-only and cannot see images, so use this tool whenever you need to know what is in an image file.";
}

/** Resolve the declared media type from a path, or `undefined` for unsupported extensions. */
function mediaTypeForPath(path) {
	return IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
}

/**
 * Effective configuration for one tool call: the live settings-resolved value
 * when a settings service is mounted (layered as schema defaults ← entry base
 * ← user section), falling back to the entry config per field.
 */
function effectiveConfig(config, settingsSource) {
	const settings = settingsSource();
	if (settings === void 0 || typeof settings !== "object" || settings === null) return config;
	return {
		provider: typeof settings.provider === "string" && settings.provider !== "" ? settings.provider : config.provider,
		model: typeof settings.model === "string" && settings.model !== "" ? settings.model : config.model,
		maxTokens: typeof settings.maxTokens === "number" ? settings.maxTokens : config.maxTokens,
		systemPrompt: typeof settings.systemPrompt === "string" ? settings.systemPrompt : config.systemPrompt,
		defaultPrompt: typeof settings.defaultPrompt === "string" ? settings.defaultPrompt : config.defaultPrompt
	};
}

/** Validate the tool arguments: non-empty, extension-checked paths and a prompt string. */
function parseArgs(args, resolved) {
	const filePaths = Array.isArray(args.file_paths) ? args.file_paths : [];
	if (filePaths.length === 0) throw new Error("file_paths must be a non-empty array of image paths");
	for (const path of filePaths) {
		if (typeof path !== "string" || path.trim().length === 0) throw new Error("file_paths must contain only non-empty string paths");
	}
	const prompt = typeof args.prompt === "string" && args.prompt.trim().length > 0 ? args.prompt.trim() : resolved.defaultPrompt;
	return { filePaths, prompt };
}

/** Resolution options matching the model-facing fs tools (session cwd + cancellation). */
function sessionResolveOptions(exec) {
	const cwd = exec.agent?.session?.header?.cwd;
	return {
		...cwd !== void 0 ? { cwd } : {},
		signal: exec.signal
	};
}

/**
 * Resolve one model-supplied path, observe absence, and require a regular file —
 * the same contract the shipped fs tools use.
 */
async function resolveRegularReadTarget(ctx, exec, requestedPath) {
	const target = await ctx.fs.resolve(requestedPath, sessionResolveOptions(exec));
	const info = await ctx.fs.stat(target, exec.signal);
	if (info === void 0) {
		ctx.emit("fs/observed", target, { kind: "absent" }, exec);
		throw new FsError(`cannot read "${target.displayPath}": not found`, "FS_NOT_FOUND");
	}
	if (info.type !== "file") throw new FsError(`cannot read "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
	return { target, info };
}

/**
 * Verify the configured vision model exists and declares image input, so a
 * text-only route fails before any filesystem or attachment work. Unknown
 * provider/model rethrow with the currently registered providers, so a
 * misconfiguration is self-explanatory to the main model.
 */
async function assertImageCapableModel(ctx, resolved, signal) {
	let info;
	try {
		info = await ctx.llm.resolveModelInfo(resolved.provider, resolved.model, signal);
	} catch (error) {
		const available = ctx.llm.listProviders().map((entry) => `${entry.name} (${entry.id})`).join(", ") || "none";
		throw new Error(`easyvision: vision model "${resolved.model}" on provider "${resolved.provider}" is not in the dsh model list for that provider; add it in Settings → Models or pick another model in Settings → EasyVision (registered providers: ${available})`, { cause: error });
	}
	const modalities = info.inputModalities;
	if (modalities !== void 0 && !modalities.includes("image")) {
		throw new Error(`easyvision: model "${resolved.model}" on provider "${resolved.provider}" does not declare image input; pick a vision-capable model in Settings → EasyVision`);
	}
	return info;
}

/**
 * Run one vision-model call and return the assembled text.
 * @returns `{ description, truncated }`.
 */
async function describeWithVisionModel(ctx, resolved, message, signal) {
	const assembler = new BlockAssembler();
	const stream = ctx.llm.stream({
		provider: resolved.provider,
		model: resolved.model,
		messages: [message],
		system: resolved.systemPrompt,
		...resolved.maxTokens === void 0 ? {} : { maxTokens: resolved.maxTokens },
		signal
	});
	try {
		for await (const chunk of stream) assembler.push(chunk);
	} catch (error) {
		throw new Error(`easyvision: vision model call failed: ${String(error)}`, { cause: error });
	}
	const finish = assembler.finish;
	if (finish.kind === "error" || finish.kind === "aborted") {
		const failure = finish.failure;
		throw new Error(`easyvision: vision model call failed: ${failure.message}${failure.code ? ` (${failure.code})` : ""}`);
	}
	const description = assembler.blocks().filter((block) => block.type === "text").map((block) => block.text).join("").trim();
	if (description.length === 0) throw new Error("easyvision: vision model returned no text");
	return {
		description,
		truncated: finish.kind === "max-tokens"
	};
}

/** Register the `describe_image` tool and its system-prompt guidance. */
function applyDescribeImageTool(ctx, config, settingsSource) {
	ctx.systemPrompt.section({
		name: `tool:${config.toolName}`,
		order: 115,
		text: `Your own model is text-only: it cannot see images. To inspect image files, call ${config.toolName} — it sends them to the dedicated vision model configured in Settings → EasyVision and returns its description as text.`
	});
	ctx.tools.register(defineTool({
		name: config.toolName,
		description: toolDescription(),
		parameters: {
			file_paths: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "Paths to the image files (PNG/JPEG/WebP/GIF), resolved by the filesystem backend."
			},
			prompt: {
				type: "string",
				description: "Optional question about the image(s). Defaults to the configured EasyVision default prompt."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					provider: { type: "string", required: true },
					model: { type: "string", required: true },
					images: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								path: { type: "string", required: true },
								width: { type: "integer", required: true },
								height: { type: "integer", required: true },
								bytes: { type: "integer", required: true }
							}
						}
					},
					description: { type: "string", required: true },
					truncated: { type: "boolean" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.truncated === true ? `${value.description}\n\n(Note: the vision model hit its token limit; the description above may be cut short.)` : value.description
			}],
			presentationMeta: (args, value) => ({
				provider: value.provider,
				model: value.model,
				images: value.images,
				truncated: value.truncated === true
			})
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const resolved = effectiveConfig(config, settingsSource);
			const input = parseArgs(args, resolved);
			const attachments = ctx.get("attachments");
			if (attachments === void 0) throw new Error(`easyvision: ${config.toolName} requires a durable attachment service to be mounted`);
			await assertImageCapableModel(ctx, resolved, exec.signal);
			const images = [];
			for (const path of input.filePaths) {
				const mediaType = mediaTypeForPath(path);
				if (mediaType === void 0) throw new Error(`cannot read "${path}": easyvision only accepts PNG/JPEG/WebP/GIF paths`);
				if (!attachments.imageLimits.mediaTypes.includes(mediaType)) throw new Error(`cannot read "${path}": ${mediaType} images are not accepted by this deployment`);
				const { target, info } = await resolveRegularReadTarget(ctx, exec, path);
				const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes);
				const data = await ctx.fs.readBytes(target, exec.signal, byteCap);
				let ref;
				try {
					ref = await attachments.saveImage({
						data,
						mediaType,
						name: basename(target.displayPath)
					});
				} catch (error) {
					if (!(error instanceof AttachmentError) || error.code !== "IMAGE_TYPE_MISMATCH") throw error;
					const extension = extname(target.displayPath).toLowerCase();
					throw new Error(`cannot read "${target.displayPath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`, { cause: error });
				}
				ctx.emit("fs/observed", target, { kind: "present", version: info.version }, exec);
				images.push({ ref, path: target.displayPath });
			}
			const message = createUserMessage({
				content: [
					...images.map(({ ref }) => ({ type: "image", attachment: ref })),
					{ type: "text", text: input.prompt }
				],
				source: { kind: "plugin", plugin: "easyvision" }
			});
			const { description, truncated } = await describeWithVisionModel(ctx, resolved, message, exec.signal);
			return {
				provider: resolved.provider,
				model: resolved.model,
				images: images.map(({ ref, path }) => ({
					path,
					width: ref.width,
					height: ref.height,
					bytes: ref.bytes
				})),
				description,
				...truncated ? { truncated: true } : {}
			};
		},
		presentCall(args) {
			const files = Array.isArray(args?.file_paths) ? args.file_paths : [];
			return {
				card: "generic",
				title: `Describe image${files.length === 1 ? "" : "s"}: ${files.join(", ")}`,
				kind: "vision"
			};
		}
	}));
}

/**
 * Register the vision tool suite while a durable attachment store is mounted,
 * and expose the `easyvision` settings namespace (Settings → EasyVision) with
 * the entry config as its composition base when a settings service exists.
 */
function apply(ctx, config) {
	const entry = {
		provider: config.provider,
		model: config.model,
		...config.maxTokens === void 0 ? {} : { maxTokens: config.maxTokens },
		systemPrompt: config.systemPrompt,
		defaultPrompt: config.defaultPrompt
	};
	// The settings section may mount AFTER the attachment store (loader
	// entries mount concurrently), so the tool must read the current source
	// through a live getter instead of a value captured at registration time.
	let settingsSource = () => entry;
	installSettingsSection(ctx, SETTINGS_NAMESPACE, SETTINGS_SCHEMA, entry, {
		setSource: (current) => {
			settingsSource = current;
		},
		onChange: () => {}
	});
	ctx.inject(["attachments"], (imageCtx) => {
		applyDescribeImageTool(imageCtx, config, () => settingsSource());
	});
}

export { Config, apply, inject, name };
