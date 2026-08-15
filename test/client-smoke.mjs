// Smoke test for the dsh-easyvision browser plugin (lib/client.js).
//
// Loads the REAL client.js module against real react, with
// @deepseek-ai/dsh-client-ui-primitives STUBBED, runs its apply() with a mock
// plugin context (slots registry + settingsScope binder backed by a memory
// store), then server-renders the EasyVision settings section with a ready
// snapshot. This checks the import-name contract of the primitives, the slot
// registration contract, and that the section renders.
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
const mockCtx = {
	slots: {
		inject: (name, factory) => {
			const registration = factory();
			registrations.push({ slot: registration.name, id: registration.id, order: registration.order, label: registration.label(), component: registration.component });
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
		return void 0;
	}
};
plugin.apply(mockCtx);

const section = registrations.find((r) => r.slot === "settings.section" && r.id === "easyvision");
if (!section) throw new Error("settings.section registration missing");
console.log("settings.section registered:", JSON.stringify({ id: section.id, order: section.order, label: section.label }));

// ── render the section with the injected scope ───────────────────────────
const Section = section.component;
const html = renderToString(h(Section, { scope, close: () => {} }));
for (const expected of ["EasyVision", "opencode-go", "qwen3.7-plus", "4096", "You are a helpful vision assistant.", "Describe what you see.", "Vision model", "Provider", "Max tokens", "System prompt", "Default prompt"]) {
	if (!html.includes(expected)) throw new Error(`rendered section missing "${expected}"`);
}
console.log("section renders all fields with committed values OK");

// ── interactions: write through the scope and re-render ──────────────────
scope.set("model", "mimo-v2.5").then(async () => {
	await scope.set("provider", "opencode-go");
	const html2 = renderToString(h(Section, { scope, close: () => {} }));
	if (!html2.includes("mimo-v2.5")) throw new Error("re-render did not pick up the model write");
	console.log("section re-renders after settings write OK");
	console.log("client smoke test PASSED");
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
