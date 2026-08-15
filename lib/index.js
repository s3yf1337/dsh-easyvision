import { basename, extname } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { AttachmentError } from "@deepseek-ai/dsh-attachment";
import { FsError } from "@deepseek-ai/dsh-fs";

/**
 * @deepseek-ai/dsh-easyvision — describe images through a dedicated vision model.
 *
 * The main conversation model is usually text-only, so image files cannot be
 * handed to it directly. This plugin registers one model-facing tool
 * (`describe_image` by default) that reads image files through the harness's
 * own filesystem seam, commits them through the durable attachment service,
 * and sends them to a vision-capable model from the dsh model list (provider +
 * model are plugin config, defaulting to `opencode-go` / `qwen3.7-plus`) over
 * `ctx.llm` — the exact same LLM runtime the agent loop itself uses. The
 * vision model's description comes back as plain text the main model can
 * read, so a text-only conversation can still "see" pictures.
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

/** Services required by this plugin. `attachments` is optional and injected per-registration. */
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

/** Model-facing wording for the tool description. */
function toolDescription(config) {
	return `Send one or more image files to a dedicated vision model (${config.provider}/${config.model}) from the dsh model list and return its description as text. Your own model is text-only and cannot see images, so use this tool whenever you need to know what is in an image file.`;
}

/** Resolve the declared media type from a path, or `undefined` for unsupported extensions. */
function mediaTypeForPath(path) {
	return IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
}

/** Validate the tool arguments: non-empty, extension-checked paths and a prompt string. */
function parseArgs(args, config) {
	const filePaths = Array.isArray(args.file_paths) ? args.file_paths : [];
	if (filePaths.length === 0) throw new Error("file_paths must be a non-empty array of image paths");
	for (const path of filePaths) {
		if (typeof path !== "string" || path.trim().length === 0) throw new Error("file_paths must contain only non-empty string paths");
	}
	const prompt = typeof args.prompt === "string" && args.prompt.trim().length > 0 ? args.prompt.trim() : config.defaultPrompt;
	return { filePaths, prompt };
}

/** Resolution options matching the model-facing fs tools (session cwd + cancellation). */
function sessionResolveOptions(exec, requestedPath) {
	const raw = exec.agent?.session?.header?.cwd;
	const cwd = raw === void 0 ? void 0 : raw;
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
	const target = await ctx.fs.resolve(requestedPath, sessionResolveOptions(exec, requestedPath));
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
 * text-only route fails before any filesystem or attachment work. The result
 * is cached per plugin instance: provider routes only change through
 * configuration, which re-applies the plugin. Failures (unknown provider or
 * model) rethrow with the currently registered providers and their models,
 * so a misconfiguration is self-explanatory to the main model.
 */
function assertImageCapableModel(ctx, config, signal) {
	let pending;
	const check = async () => {
		let info;
		try {
			info = await ctx.llm.resolveModelInfo(config.provider, config.model, signal);
		} catch (error) {
			const available = ctx.llm.listProviders().map((entry) => `${entry.name} (${entry.id})`).join(", ") || "none";
			throw new Error(`easyvision: vision model "${config.model}" on provider "${config.provider}" is not in the dsh model list for that provider; add it in Settings → Models or configure an existing model id (registered providers: ${available})`, { cause: error });
		}
		const modalities = info.inputModalities;
		if (modalities !== void 0 && !modalities.includes("image")) {
			throw new Error(`easyvision: model "${config.model}" on provider "${config.provider}" does not declare image input; pick a vision-capable model from the dsh model list`);
		}
		return info;
	};
	return async () => {
		if (pending === void 0) pending = check().catch((error) => {
			pending = void 0;
			throw error;
		});
		return pending;
	};
}

/**
 * Run one vision-model call and return the assembled text.
 * @returns `{ description, truncated }`.
 */
async function describeWithVisionModel(ctx, config, message, signal) {
	const assembler = new BlockAssembler();
	const stream = ctx.llm.stream({
		provider: config.provider,
		model: config.model,
		messages: [message],
		system: config.systemPrompt,
		...config.maxTokens === void 0 ? {} : { maxTokens: config.maxTokens },
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
function applyDescribeImageTool(ctx, config) {
	ctx.systemPrompt.section({
		name: `tool:${config.toolName}`,
		order: 115,
		text: `Your own model is text-only: it cannot see images. To inspect image files, call ${config.toolName} — it sends them to the dedicated vision model (${config.provider}/${config.model}) and returns its description as text.`
	});
	ctx.tools.register(defineTool({
		name: config.toolName,
		description: toolDescription(config),
		parameters: {
			file_paths: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "Paths to the image files (PNG/JPEG/WebP/GIF), resolved by the filesystem backend."
			},
			prompt: {
				type: "string",
				description: `Optional question about the image(s). Defaults to: ${config.defaultPrompt}`
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
			const input = parseArgs(args, config);
			const attachments = ctx.get("attachments");
			if (attachments === void 0) throw new Error(`easyvision: ${config.toolName} requires a durable attachment service to be mounted`);
			const assertCapable = assertImageCapableModel(ctx, config, exec.signal);
			await assertCapable();
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
			const { description, truncated } = await describeWithVisionModel(ctx, config, message, exec.signal);
			return {
				provider: config.provider,
				model: config.model,
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

/** Register the vision tool suite while a durable attachment store is mounted. */
function apply(ctx, config) {
	ctx.inject(["attachments"], (imageCtx) => {
		applyDescribeImageTool(imageCtx, config);
	});
}

export { Config, apply, inject, name };
