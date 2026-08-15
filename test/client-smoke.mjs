// Smoke test for the dsh-easyvision browser plugin (lib/client.js).
//
// Loads the REAL client.js module against real react, with
// @deepseek-ai/dsh-client-ui-primitives STUBBED, runs its apply() with a mock
// plugin context (slots registry + settingsScope binder backed by a memory
// store + connection/remote for the model catalog), then server-renders the
// EasyVision settings section with a ready snapshot. This checks the
// import-name contract of the primitives, the slot registration contract,
// and that the section renders. The picker's option builder is a pure
// function and is exercised directly against a fake catalog (SSR cannot run
// the async catalog effect).
//
// Run: node test/client-smoke.mjs  (set DSH_NM to the dsh install when dsh
// lives elsewhere than the default below)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const DSH_NM = process.env.DSH_NM || "/home/seyf/.local/lib/node_modules/@deepseek-ai/dsh/node_modules";
const react = require(DSH_NM + "/react");
const { renderToString } = require(DSH_NM + "/react-dom/server");
const h = react.createElement;

// ── shims ────────────────────────────────────────────────────────────────
const Primitive = ({ icon, children, ...rest }) => h("button", rest, icon, children);
const primitivesStub = {};
for (const name of [
	"IconDownloadOutline16", "IconRefreshOutline14", "IconGlobeOutline14",
	"IconSettingsOutline16", "IconFolderOpenOutline16", "IconFolderOpen16",
	"IconChevronLeftOutline14", "IconChevronRightOutline14", "IconCloseOutline16"
]) {
	primitivesStub[name] = () => h("svg", { "data-icon": name });
}
primitivesStub.Button = Primitive;
primitivesStub.Input = Primitive;
primitivesStub.Pill = Primitive;
primitivesStub.StateDot = () => null;
primitivesStub.Menu = () => null;
primitivesStub.Modal = () => null;

globalThis.window = {
	__ModuleLoader__: {
		load: (definition) => {
			const fakeRequire = (spec) => {
				if (spec === "react") return react;
				if (spec === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
				throw new Error("unexpected require: " + spec);
			};
			window.__MODULE_EXPORTS__ = definition.factory(fakeRequire);
		}
	}
};

// Load the real client.js text and evaluate it in this realm.
const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const evalClient = new Function(clientSource);
evalClient();

const plugin = window.__MODULE_EXPORTS__;
if (!plugin || typeof plugin.apply !== "function" || !Array.isArray(plugin.inject)) {
	throw new Error("client.js did not export apply/inject");
}
console.log("client.js loaded; inject =", JSON.stringify(plugin.inject));

// ── mock settings scope over a memory store ──────────────────────────────
// A CLASS with prototype methods backed by `this.store`, exactly like the
// real SettingsScopeController — this catches unbound-method regressions
// (`this.store` crashes) when the section hands methods to React.
class MemoryScope {
	constructor(initial) {
		this.store = { value: { ...initial } };
		this.listeners = new Set();
	}
	getSnapshot() {
		return {
			status: "ready",
			value: { ...this.store.value },
			base: { ...this.store.value },
			user: {},
			revision: 0,
			writable: true,
			mode: "host"
		};
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async set(field, v) {
		this.store.value[field] = v;
		for (const l of this.listeners) l();
	}
	async unset(field) {
		delete this.store.value[field];
		for (const l of this.listeners) l();
	}
	async load() {}
	async dispose() {}
}

// ── mock plugin context ──────────────────────────────────────────────────
const registrations = [];
const scope = new MemoryScope({
	provider: "opencode-go",
	model: "qwen3.7-plus",
	maxTokens: 4096,
	systemPrompt: "You are a helpful vision assistant.",
	defaultPrompt: "Describe what you see."
});
const CATALOG = {
	result: {
		ok: true,
		value: {
			groups: [
				{ id: "opencode-go", name: "opencode-go", models: [
					{ id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
					{ id: "kimi-k2.6", name: "Kimi K2.6" },
					{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }
				] },
				{ id: "deepseek-official", name: "DeepSeek Official", models: [
					{ id: "deepseek-v3.2", name: "DeepSeek V3.2" }
				] }
			],
			failures: []
		}
	}
};
const mockCtx = {
	slots: {
		inject: (name, factory) => {
			const registration = factory();
			registrations.push({ slot: registration.name, id: registration.id, order: registration.order, label: registration.label(), component: registration.component, injected: registration.inject() });
		},
		register: (...args) => ({ ...args[0], component: args[1] })
	},
	get: (key) => {
		if (key === "settingsScope") return {
			bind: (spec) => {
				if (spec.namespace !== "easyvision") throw new Error("unexpected namespace: " + spec.namespace);
				return scope;
			}
		};
		if (key === "connection") return {
			api: {
				llm: {
					models: async () => JSON.parse(JSON.stringify(CATALOG))
				}
			}
		};
		if (key === "remote") return {
			$on: () => () => {}
		};
		return void 0;
	}
};
plugin.apply(mockCtx);

const section = registrations.find((r) => r.slot === "settings.section" && r.id === "easyvision");
if (!section) throw new Error("settings.section registration missing");
console.log("settings.section registered:", JSON.stringify({ id: section.id, order: section.order, label: section.label }));

// ── picker option builder (pure) ─────────────────────────────────────────
const groups = CATALOG.result.value.groups;
const opts = plugin.pickerOptions(
	{ status: "ready" },
	groups,
	"opencode-go",
	"qwen3.7-plus",
	true,
	"opencode-go\u0000qwen3.7-plus"
);
if (opts.length !== 2) throw new Error(`expected 2 optgroups, got ${opts.length}`);
if (opts[0].type !== "optgroup" || opts[0].props.label !== "opencode-go") throw new Error("first optgroup label mismatch");
const qwen = opts[0].props.children.find((o) => o.props.value === "opencode-go\u0000qwen3.7-plus");
if (!qwen || !qwen.props.children.includes("Qwen3.7 Plus")) throw new Error("qwen3.7-plus option missing from picker");
const flash = opts[0].props.children.find((o) => o.props.value === "opencode-go\u0000deepseek-v4-flash");
if (!flash) throw new Error("deepseek-v4-flash option missing from picker");
// Fallback option for a selection absent from the catalog.
const fallback = plugin.pickerOptions({ status: "ready" }, groups, "opencode-go", "mimo-v2.5", false, "opencode-go\u0000mimo-v2.5");
if (fallback[0].props.value !== "opencode-go\u0000mimo-v2.5" || !String(fallback[0].props.children).includes("not in the model list")) {
	throw new Error("fallback option for a missing model missing");
}
console.log("picker option builder OK (optgroups, models, fallback for unlisted model)");

// ── render the section with the injected scope ───────────────────────────
const Section = section.component;
const injected = section.injected;
const html = renderToString(h(Section, { ...injected, close: () => {} }));
for (const expected of ["EasyVision", "Vision model", "Advanced", "Max tokens", "System prompt", "Default prompt", "live"]) {
	if (!html.includes(expected)) throw new Error(`rendered section missing "${expected}"`);
}
console.log("section renders picker + advanced fold OK");

// ── interactions: write through the scope and re-render ──────────────────
scope.set("model", "mimo-v2.5").then(async () => {
	await scope.set("provider", "opencode-go");
	const html2 = renderToString(h(Section, { ...injected, close: () => {} }));
	if (!html2.includes("mimo-v2.5")) throw new Error("re-render did not pick up the model write");
	console.log("section re-renders after settings write OK");
	console.log("client smoke test PASSED");
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
