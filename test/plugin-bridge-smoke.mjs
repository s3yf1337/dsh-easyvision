// Smoke test for the dsh-easyvision image-admission bridge (lib/index.js).
//
// Two layers:
//  1. The exported `describePromptContent` is exercised directly against a
//     fake harness ctx (llm/attachments): happy path (images described, the
//     returned content is text-only, the user text is used as the vision
//     prompt), and every failure path maps to a stable EasyVisionBridgeError
//     wire code.
//  2. The `easyvision` service registration is checked against a REAL Cordis
//     context (from the dsh install): loading the plugin provides the
//     service, `ctx.get("easyvision")` resolves it while the plugin is
//     active, and unregistering (plugin stop) makes the strict get answer
//     `undefined` again — the exact contract the patched host relies on.
//
// Run: node test/plugin-bridge-smoke.mjs  (set DSH_NM when dsh lives
// elsewhere than the default below)
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DSH_NM = process.env.DSH_NM || "/home/seyf/.local/lib/node_modules/@deepseek-ai/dsh/node_modules";
const { Context } = require(DSH_NM + "/@deepseek-ai/cordis");

const plugin = await import("../lib/index.js");
const { describePromptContent, EasyVisionBridgeError } = plugin;

// ── shared fakes ──────────────────────────────────────────────────────────
const IMAGE_PART = { type: "image", mediaType: "image/png", data: Buffer.from("fake-png-bytes").toString("base64"), name: "shot.png" };
const TEXT_PART = { type: "text", text: "what's in this picture?" };

/** A vision stream: one text block then a clean finish. */
async function* visionStream(description) {
	yield { type: "block-start", index: 0, blockType: "text" };
	yield { type: "text-delta", index: 0, text: description };
	yield { type: "block-end", index: 0, block: { type: "text", text: description } };
	yield { type: "finish", reason: { kind: "complete" } };
}

function fakeCtx({ models, streamImpl = () => visionStream("A red car on a sunny street."), limits, failSave = false } = {}) {
	const seen = { streamOptions: [] };
	const attachments = {
		imageLimits: limits ?? { maxImagesPerMessage: 4, maxImageBytes: 10 * 1024 * 1024, maxMessageImageBytes: 20 * 1024 * 1024, mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
		async validateImage() {},
		async saveImage(input) {
			if (failSave) throw new Error("durable store exploded");
			seen.saved = input;
			return { attachmentId: "att-1", mediaType: input.mediaType, bytes: input.data.byteLength, width: 640, height: 480 };
		}
	};
	return {
		get: (name) => name === "attachments" ? attachments : void 0,
		llm: {
			async resolveModelInfo(provider, model) {
				if (!(provider in models)) throw new Error(`unknown provider ${provider}`);
				const info = models[provider][model];
				if (info === void 0) throw new Error(`unknown model ${model}`);
				return info;
			},
			stream(options) {
				seen.streamOptions.push(options);
				return streamImpl(options);
			}
		},
		attachments,
		seen
	};
}

const config = { provider: "opencode-go", model: "qwen3.7-plus", systemPrompt: "You are a vision assistant.", defaultPrompt: "Describe what you see." };
const settingsSource = () => void 0; // entry base layer only

const VISION_MODELS = {
	"opencode-go": {
		"qwen3.7-plus": { inputModalities: ["text", "image"] },
		"deepseek-v4-flash": { inputModalities: ["text"] }
	}
};

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

// ── 1. happy path ─────────────────────────────────────────────────────────
{
	const ctx = fakeCtx({ models: VISION_MODELS });
	const out = await describePromptContent(ctx, config, settingsSource, [TEXT_PART, IMAGE_PART]);
	assert(out.length === 2, `expected 2 text parts, got ${JSON.stringify(out.length)}`);
	assert(out[0].type === "text" && out[0].text === TEXT_PART.text, "user text must be preserved");
	assert(out[1].type === "text", "description part must be text");
	assert(out[1].text.includes("A red car on a sunny street."), "description must be embedded");
	assert(out[1].text.includes("opencode-go/qwen3.7-plus"), "description must name the vision model");
	assert(out[1].text.startsWith("[Attached image —"), "single-image label expected");
	// the vision message must carry the image refs and the USER text as prompt
	const visionMessage = ctx.seen.streamOptions[0].messages[0];
	const imageBlocks = visionMessage.content.filter((block) => block.type === "image");
	assert(imageBlocks.length === 1 && imageBlocks[0].attachment.attachmentId === "att-1", "vision message must carry the saved image ref");
	const promptBlock = visionMessage.content.find((block) => block.type === "text");
	assert(promptBlock.text === TEXT_PART.text, "user text must be the vision prompt");
	console.log("bridge happy path OK (text preserved, image described, vision prompt = user text)");
}

// ── 2. no user text → default prompt is the vision question ───────────────
{
	const ctx = fakeCtx({ models: VISION_MODELS });
	const out = await describePromptContent(ctx, config, settingsSource, [IMAGE_PART]);
	assert(out.length === 1 && out[0].type === "text", "image-only message must yield one text part");
	const visionMessage = ctx.seen.streamOptions[0].messages[0];
	const promptBlock = visionMessage.content.find((block) => block.type === "text");
	assert(promptBlock.text === config.defaultPrompt, "default prompt must be used without user text");
	console.log("bridge default-prompt fallback OK");
}

// ── 3. multiple images → aggregate label ──────────────────────────────────
{
	const ctx = fakeCtx({ models: VISION_MODELS });
	const out = await describePromptContent(ctx, config, settingsSource, [IMAGE_PART, { ...IMAGE_PART, name: "second.png" }]);
	assert(out.length === 1 && out[0].text.startsWith("[Attached images (2) —"), "multi-image label expected");
	assert(ctx.seen.saved !== void 0, "images must be committed through saveImage");
	console.log("bridge multi-image label OK");
}

// ── 4. model not in the list → easyvision-not-configured ──────────────────
{
	const ctx = fakeCtx({ models: VISION_MODELS });
	let caught;
	try {
		await describePromptContent(ctx, { ...config, model: "mimo-v2.5" }, settingsSource, [IMAGE_PART]);
	} catch (error) {
		caught = error;
	}
	assert(caught instanceof EasyVisionBridgeError && caught.code === "easyvision-not-configured", `expected easyvision-not-configured, got ${caught?.code ?? "no throw"}`);
	assert(caught.message.includes("Settings → EasyVision"), "message must point at Settings → EasyVision");
	console.log("bridge unknown-model error code OK");
}

// ── 5. text-only vision pick → easyvision-model-text-only ─────────────────
{
	const ctx = fakeCtx({ models: VISION_MODELS });
	let caught;
	try {
		await describePromptContent(ctx, { ...config, model: "deepseek-v4-flash" }, settingsSource, [IMAGE_PART]);
	} catch (error) {
		caught = error;
	}
	assert(caught instanceof EasyVisionBridgeError && caught.code === "easyvision-model-text-only", `expected easyvision-model-text-only, got ${caught?.code ?? "no throw"}`);
	console.log("bridge text-only-pick error code OK");
}

// ── 6. image-count limit → easyvision-image-invalid ───────────────────────
{
	const ctx = fakeCtx({ models: VISION_MODELS, limits: { maxImagesPerMessage: 1, maxImageBytes: 10 * 1024 * 1024, maxMessageImageBytes: 20 * 1024 * 1024 } });
	let caught;
	try {
		await describePromptContent(ctx, config, settingsSource, [IMAGE_PART, { ...IMAGE_PART, name: "b.png" }]);
	} catch (error) {
		caught = error;
	}
	assert(caught instanceof EasyVisionBridgeError && caught.code === "easyvision-image-invalid", `expected easyvision-image-invalid, got ${caught?.code ?? "no throw"}`);
	console.log("bridge image-count limit OK");
}

// ── 7. vision call failure → easyvision-vision-failed ─────────────────────
{
	async function* failingStream() {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "finish", reason: { kind: "error", failure: { code: "AUTH", message: "403 upstream" } } };
	}
	const ctx = fakeCtx({ models: VISION_MODELS, streamImpl: failingStream });
	let caught;
	try {
		await describePromptContent(ctx, config, settingsSource, [IMAGE_PART]);
	} catch (error) {
		caught = error;
	}
	assert(caught instanceof EasyVisionBridgeError && caught.code === "easyvision-vision-failed", `expected easyvision-vision-failed, got ${caught?.code ?? "no throw"}`);
	assert(caught.message.includes("AUTH"), "the upstream failure must surface in the message");
	console.log("bridge vision-failure error code OK");
}

// ── 8. registration on a real Cordis context ──────────────────────────────
{
	const app = new Context();
	app.provide("tools", { register() {} });
	app.provide("llm", { async resolveModelInfo() { return { inputModalities: ["text", "image"] }; }, stream() { throw new Error("not used"); }, listProviders() { return []; } });
	app.provide("fs", {});
	app.provide("systemPrompt", { section() {} });
	app.provide("settings", {});
	const fiber = app.plugin({
		name: "easyvision",
		apply: plugin.apply,
		Config: plugin.Config,
		inject: plugin.inject
	}, {});
	await fiber;
	const service = app.get("easyvision");
	assert(service !== void 0 && typeof service.describePromptContent === "function", "ctx.get(\"easyvision\") must resolve the bridge service while the plugin is active");
	const appCtx = app; // root context reads the same shared store
	assert(appCtx.get("easyvision") === service, "root context must see the same service");
	console.log("bridge service registration OK (active plugin resolves ctx.get(\"easyvision\"))");
	await fiber.dispose();
	const after = app.get("easyvision");
	assert(after === void 0, "ctx.get(\"easyvision\") must be undefined after the plugin stops");
	console.log("bridge service unregistration OK (stopped plugin disappears from ctx.get)");
}

console.log("plugin bridge smoke test PASSED");
