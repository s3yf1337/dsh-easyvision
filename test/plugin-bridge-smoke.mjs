// Smoke test for the dsh-easyvision image-admission bridge (lib/index.js).
//
// Layers:
//  1. `checkPromptContent` — the admission health check the patched host
//     calls: silent when the plugin resolves a vision-capable model, coded
//     EasyVisionBridgeError otherwise.
//  2. `transformRequest` — the request-time transform: image blocks in user
//     messages are replaced by the EasyVision description only when the
//     REQUEST's model is text-only; vision-capable models and image-free
//     requests pass through untouched; failures degrade to a note; repeated
//     requests hit the cache.
//  3. `installRequestTransform` — against a REAL Cordis context with a fake
//     llm service carrying a Cordis tracker: both dispatch paths
//     (`prepareCall(...).stream(request)` and `stream(request)`) hand the
//     adapter the transformed request, and the disposer restores the
//     originals.
//  4. Service registration on a real Cordis context: active plugin answers
//     `ctx.get("easyvision")`, a stopped plugin disappears.
//
// Run: node test/plugin-bridge-smoke.mjs  (set DSH_NM when dsh lives
// elsewhere than the default below)
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DSH_NM = process.env.DSH_NM || "/home/seyf/.local/lib/node_modules/@deepseek-ai/dsh/node_modules";
const { Context, Service } = require(DSH_NM + "/@deepseek-ai/cordis");

const plugin = await import("../lib/index.js");
const { checkPromptContent, transformRequest, installRequestTransform, EasyVisionBridgeError } = plugin;

// ── shared fakes ──────────────────────────────────────────────────────────
const REF = { attachmentId: "att-1", mediaType: "image/png", bytes: 64, width: 640, height: 480 };
const IMAGE_BLOCK = { type: "image", attachment: REF };
const TEXT_BLOCK = { type: "text", text: "what's in this picture?" };
const USER_MESSAGE = { id: "msg-1", role: "user", content: [TEXT_BLOCK, IMAGE_BLOCK], source: { kind: "user" } };

/** A vision stream: one text block then a clean finish. */
async function* visionStream(description) {
	yield { type: "block-start", index: 0, blockType: "text" };
	yield { type: "text-delta", index: 0, text: description };
	yield { type: "block-end", index: 0, block: { type: "text", text: description } };
	yield { type: "finish", reason: { kind: "complete" } };
}

function fakeCtx({ requestModels = {}, streamImpl = () => visionStream("A red car on a sunny street.") } = {}) {
	const seen = { streamOptions: [] };
	return {
		get: () => void 0,
		llm: {
			async resolveModelInfo(provider, model) {
				const info = requestModels[provider]?.[model];
				if (info === void 0) throw new Error(`unknown model ${provider}/${model}`);
				return info;
			},
			stream(options) {
				seen.streamOptions.push(options);
				return streamImpl(options);
			}
		},
		seen
	};
}

const config = { provider: "opencode-go", model: "qwen3.7-plus", systemPrompt: "You are a vision assistant.", defaultPrompt: "Describe what you see." };
const settingsSource = () => void 0; // entry base layer only

const MODELS = {
	"opencode-go": {
		"qwen3.7-plus": { inputModalities: ["text", "image"] },
		"deepseek-v4-flash": { inputModalities: ["text"] }
	}
};

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

// ── 1. checkPromptContent: admission health check ─────────────────────────
{
	const healthy = fakeCtx({ requestModels: MODELS });
	await checkPromptContent(healthy, config, settingsSource, [TEXT_BLOCK, IMAGE_BLOCK]);
	console.log("checkPromptContent healthy OK (no throw)");
}
{
	const ctx = fakeCtx({ requestModels: MODELS });
	let caught;
	try {
		await checkPromptContent(ctx, { ...config, model: "mimo-v2.5" }, settingsSource, [IMAGE_BLOCK]);
	} catch (error) {
		caught = error;
	}
	assert(caught instanceof EasyVisionBridgeError && caught.code === "easyvision-not-configured", `expected easyvision-not-configured, got ${caught?.code ?? "no throw"}`);
	assert(caught.message.includes("Settings → EasyVision"), "message must point at Settings → EasyVision");
	console.log("checkPromptContent unknown-model code OK");
}
{
	const ctx = fakeCtx({ requestModels: MODELS });
	let caught;
	try {
		await checkPromptContent(ctx, { ...config, model: "deepseek-v4-flash" }, settingsSource, [IMAGE_BLOCK]);
	} catch (error) {
		caught = error;
	}
	assert(caught instanceof EasyVisionBridgeError && caught.code === "easyvision-model-text-only", `expected easyvision-model-text-only, got ${caught?.code ?? "no throw"}`);
	console.log("checkPromptContent text-only-pick code OK");
}

// ── 2. transformRequest: happy path (text-only request model) ─────────────
{
	const ctx = fakeCtx({ requestModels: MODELS });
	const assistant = { id: "msg-0", role: "assistant", content: [{ type: "text", text: "ok" }], source: { kind: "model" } };
	const request = { provider: "opencode-go", model: "deepseek-v4-flash", messages: [assistant, USER_MESSAGE] };
	const out = await transformRequest(ctx, config, settingsSource, request, new Map());
	assert(out !== request, "a changed request must be a new object");
	assert(out.messages[0] === assistant, "image-free messages must pass through untouched");
	const described = out.messages[1];
	assert(described.content.every((block) => block.type === "text"), "image blocks must be replaced by text");
	const marker = described.content.find((block) => block.text.startsWith("[Attached image —"));
	assert(marker !== void 0 && marker.text.includes("A red car on a sunny street."), "description marker expected");
	assert(marker.text.includes("opencode-go/qwen3.7-plus"), "marker must name the vision model");
	// the vision message must carry the SAME durable refs and the user text as prompt
	const visionMessage = ctx.seen.streamOptions[0].messages[0];
	assert(visionMessage.content.some((block) => block.type === "image" && block.attachment.attachmentId === "att-1"), "vision message must carry the durable image ref");
	const promptBlock = visionMessage.content.find((block) => block.type === "text");
	assert(promptBlock.text === TEXT_BLOCK.text, "user text must be the vision prompt");
	console.log("transformRequest happy path OK (image → description for text-only model)");
}

// ── 3. transformRequest: vision-capable model → untouched ─────────────────
{
	const ctx = fakeCtx({ requestModels: MODELS });
	const request = { provider: "opencode-go", model: "qwen3.7-plus", messages: [USER_MESSAGE] };
	const out = await transformRequest(ctx, config, settingsSource, request, new Map());
	assert(out === request, "vision-capable model request must be the same object");
	console.log("transformRequest vision-capable passthrough OK");
}

// ── 4. transformRequest: no images → untouched ────────────────────────────
{
	const ctx = fakeCtx({ requestModels: MODELS });
	const request = { provider: "opencode-go", model: "deepseek-v4-flash", messages: [{ id: "m", role: "user", content: [{ type: "text", text: "hi" }] }] };
	const out = await transformRequest(ctx, config, settingsSource, request, new Map());
	assert(out === request, "image-free request must be the same object");
	console.log("transformRequest image-free passthrough OK");
}

// ── 5. transformRequest: vision failure → graceful note ───────────────────
{
	async function* failingVisionStream() {
		yield { type: "block-start", index: 0, blockType: "text" };
		yield { type: "finish", reason: { kind: "error", failure: { code: "AUTH", message: "403 upstream" } } };
	}
	const ctx = fakeCtx({ requestModels: MODELS, streamImpl: failingVisionStream });
	const request = { provider: "opencode-go", model: "deepseek-v4-flash", messages: [USER_MESSAGE] };
	const out = await transformRequest(ctx, config, settingsSource, request, new Map());
	assert(out !== request, "transform must still produce a request");
	const note = out.messages[0].content[0].text;
	assert(note.startsWith("[Image attached but EasyVision could not describe it:"), `expected failure note, got ${note}`);
	assert(note.includes("AUTH"), "the upstream failure must surface in the note");
	console.log("transformRequest vision-failure note OK");
}

// ── 6. transformRequest: cache across repeated requests ───────────────────
{
	let calls = 0;
	const ctx = fakeCtx({ requestModels: MODELS, streamImpl: () => { calls += 1; return visionStream("cached"); } });
	const cache = new Map();
	const request = { provider: "opencode-go", model: "deepseek-v4-flash", messages: [USER_MESSAGE] };
	await transformRequest(ctx, config, settingsSource, request, cache);
	await transformRequest(ctx, config, settingsSource, request, cache);
	assert(calls === 1, `vision call must run once, ran ${calls} times`);
	console.log("transformRequest cache OK");
}

// ── 7. installRequestTransform on a real Cordis context ───────────────────
{
	const app = new Context();
	class FakeLlm extends Service {
		constructor(ctx) {
			super(ctx, "llm");
			this.seen = { prepareStreamOptions: [], streamOptions: [] };
		}
		async resolveModelInfo(provider, model) {
			// The fake harness knows the real catalog shapes: the vision model
			// is image-capable, the conversation model is text-only.
			return { inputModalities: model === "qwen3.7-plus" ? ["text", "image"] : ["text"] };
		}
		async prepareCall() {
			return {
				config: { provider: "opencode-go", model: "deepseek-v4-flash" },
				stream: (options) => {
					this.seen.prepareStreamOptions.push(options);
					return visionStream("A red car on a sunny street.");
				}
			};
		}
		stream(options) {
			this.seen.streamOptions.push(options);
			return visionStream("A red car on a sunny street.");
		}
	}
	const llm = new FakeLlm(app);
	const dispose = installRequestTransform(app, config, settingsSource);
	const request = { provider: "opencode-go", model: "deepseek-v4-flash", messages: [USER_MESSAGE] };

	const prepared = await app.llm.prepareCall({ provider: "opencode-go", model: "deepseek-v4-flash" });
	const preparedStream = prepared.stream(request);
	for await (const chunk of preparedStream) { /* drain */ }
	assert(llm.seen.prepareStreamOptions.length === 1, "prepareCall stream must receive the request");
	const preparedMessages = llm.seen.prepareStreamOptions[0].messages;
	assert(preparedMessages[0].content.every((block) => block.type === "text"), "prepareCall path must hand the adapter text-only messages");
	assert(preparedMessages[0].content.some((block) => block.text.includes("A red car")), "prepareCall path must include the description");

	const directBefore = llm.seen.streamOptions.length;
	const directStream = app.llm.stream(request);
	for await (const chunk of directStream) { /* drain */ }
	// The description is already cached from the prepareCall path, so only the
	// main request reaches the adapter again.
	assert(llm.seen.streamOptions.length === directBefore + 1, "direct path must stream the main request");
	const directMain = llm.seen.streamOptions[llm.seen.streamOptions.length - 1];
	assert(directMain.messages[0].content.some((block) => block.text.includes("A red car")), "direct stream path must include the description");
	console.log("installRequestTransform OK (both dispatch paths transform, adapter sees text)");

	dispose();
	const prepared2 = await app.llm.prepareCall({ provider: "opencode-go", model: "deepseek-v4-flash" });
	const stream2 = prepared2.stream(request);
	for await (const chunk of stream2) { /* drain */ }
	assert(llm.seen.prepareStreamOptions.length === 2, "disposed transform must restore the original prepareCall");
	const restoredMessages = llm.seen.prepareStreamOptions[1].messages;
	assert(restoredMessages[0].content.some((block) => block.type === "image"), "restored prepareCall must hand the adapter the ORIGINAL image blocks");
	console.log("installRequestTransform disposer OK (originals restored)");
	// The app and its fake llm service die with the process; nothing else to unwind.
}

// ── 8. service registration on a real Cordis context ──────────────────────
{
	const app = new Context();
	class FakeLlm extends Service {
		constructor(ctx) {
			super(ctx, "llm");
		}
		async resolveModelInfo() { return { inputModalities: ["text", "image"] }; }
		stream() { throw new Error("not used"); }
		listProviders() { return []; }
		prepareCall() { throw new Error("not used"); }
	}
	new FakeLlm(app);
	app.provide("tools", { register() {} });
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
	assert(service !== void 0 && typeof service.checkPromptContent === "function", "ctx.get(\"easyvision\") must resolve the bridge service with checkPromptContent");
	console.log("bridge service registration OK (active plugin resolves ctx.get(\"easyvision\"))");
	await fiber.dispose();
	const after = app.get("easyvision");
	assert(after === void 0, "ctx.get(\"easyvision\") must be undefined after the plugin stops");
	console.log("bridge service unregistration OK (stopped plugin disappears from ctx.get)");
}

console.log("plugin bridge smoke test PASSED");
