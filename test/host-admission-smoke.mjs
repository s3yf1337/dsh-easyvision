// Smoke test for the dsh-easyvision image-admission host patch.
//
// Imports the REAL installed (patched) @deepseek-ai/dsh-host-apiproxy and
// drives `api.sessions.prompt` through createApiProxy with a fake host
// context, verifying the admission contract:
//
//   image-capable model  → prompt admitted with the image content (bridge
//                          never consulted)
//   text-only model      → bridge consulted:
//     plugin service absent        → easyvision-unavailable error
//     service transforms content   → prompt ADMITTED with the described text
//     service throws a code        → that code surfaces with the message
//
// Run: node test/host-admission-smoke.mjs  (set DSH_NM when dsh lives
// elsewhere than the default below; run scripts/patch-dsh-host.mjs first)
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DSH_NM = process.env.DSH_NM || "/home/seyf/.local/lib/node_modules/@deepseek-ai/dsh/node_modules";
const { createApiProxy } = require(DSH_NM + "/@deepseek-ai/dsh-host-apiproxy");

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const TEXT_ONLY = { inputModalities: ["text"] };
const IMAGE_CAPABLE = { inputModalities: ["text", "image"] };

const TEXT_PART = { type: "text", text: "what's in this picture?" };
const IMAGE_PART = { type: "image", mediaType: "image/png", data: Buffer.from("fake-png-bytes").toString("base64"), name: "shot.png" };

/** Build a fake host ctx + agent; returns { api, agent, calls, provideVision }. */
function harness({ modelInfo = TEXT_ONLY, vision = void 0, provider = "opencode-go", model = "deepseek-v4-flash" } = {}) {
	const calls = { followup: [], steer: [], visionCalls: 0 };
	const agent = {
		id: "session-1",
		status: "idle",
		ctx: { on: () => () => {} },
		session: {
			id: "session-1",
			header: { cwd: "/tmp" },
			requestHeader: () => void 0
		},
		inbox: { nextTurn: [], nextStep: [] },
		followup(message) { calls.followup.push(message); },
		steer(message) { calls.steer.push(message); }
	};
	const attachments = {
		imageLimits: { maxImagesPerMessage: 4, maxImageBytes: 10 * 1024 * 1024, maxMessageImageBytes: 20 * 1024 * 1024, mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
		async validateImage() {},
		async saveImage(input) {
			return { attachmentId: "att-1", mediaType: input.mediaType, bytes: input.data.byteLength, width: 640, height: 480 };
		}
	};
	const services = {
		llm: {
			async resolveModelInfo() { return modelInfo; },
			listProviders: () => [{ id: provider, name: provider }]
		},
		attachments
	};
	const ctx = {
		agents: {
			get: (id) => id === agent.id ? agent : void 0,
			isOwnedBy: () => false
		},
		sessions: { get: () => void 0 },
		// createApiProxy subscribes to host events at construction; the fake
		// accepts listeners and never fires them.
		on: () => () => {},
		effect: () => () => {},
		userQuestions: { registerProvider: () => () => {} },
		// createApiRemoteAgentResolver defers its typert wiring until the
		// "typert" service mounts; nothing in this harness provides it.
		inject: () => ({ dispose: () => {} }),
		llm: services.llm,
		attachments,
		get: (name) => {
			if (name === "easyvision") return vision;
			return services[name];
		}
	};
	const api = createApiProxy(ctx, {
		defaultModelSelection: () => ({ provider, model }),
		cwd: "/tmp"
	});
	return { api, agent, calls, provideVision: (service) => { services.easyvision = service; } };
}

const request = (content, mode = "queue") => ({
	rpcId: "rpc-1",
	payload: { sessionId: "session-1", mode, content }
});

// ── 1. image-capable model: admitted untouched, bridge never consulted ─────
{
	let consulted = false;
	const vision = { checkPromptContent: () => { consulted = true; throw new Error("must not be called"); } };
	const { api, agent, calls } = harness({ modelInfo: IMAGE_CAPABLE, vision, model: "qwen3.7-plus" });
	const response = await api.sessions.prompt(request([TEXT_PART, IMAGE_PART]));
	assert(response.result.ok === true && response.result.value.accepted === true, `image-capable model must admit, got ${JSON.stringify(response.result)}`);
	assert(calls.followup.length === 1, "followup must be called");
	const content = calls.followup[0].content;
	assert(content.some((block) => block.type === "image"), "image block must stay in the message for a vision-capable model");
	assert(!consulted, "bridge must not be consulted for an image-capable model");
	console.log("image-capable model path OK (admitted with image blocks, no bridge)");
}

// ── 2. text-only model + NO plugin: actionable error, nothing admitted ────
{
	const { api, calls } = harness({ modelInfo: TEXT_ONLY, vision: void 0 });
	const response = await api.sessions.prompt(request([TEXT_PART, IMAGE_PART]));
	assert(response.result.ok === false, "must refuse without the plugin");
	const error = response.result.error;
	assert(error.code === "easyvision-unavailable", `expected easyvision-unavailable, got ${error.code}`);
	assert(error.message.includes("dsh-easyvision plugin is not active"), "message must name the plugin");
	assert(error.message.includes("Settings → EasyVision"), "message must point at Settings → EasyVision");
	assert(calls.followup.length === 0, "nothing must be admitted");
	console.log("text-only + plugin absent OK (easyvision-unavailable, actionable message)");
}

// ── 3. text-only model + healthy plugin: admitted WITH the image blocks ───
{
	let checked = 0;
	const vision = {
		async checkPromptContent() { checked += 1; }
	};
	const { api, agent, calls } = harness({ modelInfo: TEXT_ONLY, vision });
	const response = await api.sessions.prompt(request([TEXT_PART, IMAGE_PART]));
	assert(response.result.ok === true && response.result.value.accepted === true, `healthy bridge must admit, got ${JSON.stringify(response.result)}`);
	assert(checked === 1, "checkPromptContent must be consulted");
	assert(calls.followup.length === 1, "followup must be called with the message");
	const content = calls.followup[0].content;
	assert(content.some((block) => block.type === "image"), "the admitted message must KEEP the image block (the chat shows the picture)");
	assert(content.some((block) => block.type === "text" && block.text === TEXT_PART.text), "the user text must be preserved");
	console.log("text-only + healthy plugin OK (admitted with the real image blocks, no text dump)");
}

// ── 4. text-only model + steer mode: steer receives the message ───────────
{
	const vision = { async checkPromptContent() {} };
	const { api, calls } = harness({ modelInfo: TEXT_ONLY, vision });
	const response = await api.sessions.prompt(request([IMAGE_PART], "steer"));
	assert(response.result.ok === true, "steer must admit too");
	assert(calls.steer.length === 1 && calls.followup.length === 0, "steer message must go to steer()");
	console.log("text-only + healthy plugin steer mode OK");
}

// ── 5. text-only model + broken plugin: the bridge's wire code surfaces ───
{
	const vision = {
		checkPromptContent() {
			const error = new Error("the model picked in Settings → EasyVision does not accept images; pick a vision-capable model there");
			error.code = "easyvision-model-text-only";
			throw error;
		}
	};
	const { api, calls } = harness({ modelInfo: TEXT_ONLY, vision });
	const response = await api.sessions.prompt(request([TEXT_PART, IMAGE_PART]));
	assert(response.result.ok === false, "must refuse when the bridge fails");
	const error = response.result.error;
	assert(error.code === "easyvision-model-text-only", `bridge code must surface, got ${error.code}`);
	assert(error.message.includes("Settings → EasyVision"), "the message must stay actionable");
	assert(calls.followup.length === 0, "nothing must be admitted");
	console.log("text-only + unhealthy plugin OK (bridge wire code + actionable message)");
}

console.log("host admission smoke test PASSED");
