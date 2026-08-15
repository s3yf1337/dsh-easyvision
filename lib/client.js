window.__ModuleLoader__.load({
	id: "dsh-easyvision",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/**
		 * dsh-easyvision browser half: the "EasyVision" settings section.
		 *
		 * One main control — a model picker fed by the same `llm.models`
		 * catalog the composer's model selection uses, grouped by provider —
		 * and an "Advanced" fold for the token cap and prompt templates. The
		 * picker writes provider + model through `scope.set`; advanced fields
		 * commit on blur/Enter and clear (unset) back to the composition base.
		 * The tool on the host side reads the resolved section live, so every
		 * change applies immediately — no restart.
		 */
		const { createElement: h, useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } = react;
		const { Button, Input, Pill } = primitives;

		const NS = "easyvision";
		const inject = ["slots", "settingsScope", "connection", "remote"];

		/** Card / label / hint style tokens, following the dsh-desktop precedent. */
		const CARD = {
			display: "flex",
			flexDirection: "column",
			gap: 6,
			padding: 14,
			borderRadius: 10,
			border: "1px solid var(--dsw-alias-interactive-border)",
			background: "var(--dsw-alias-surface-raised, transparent)"
		};
		const LABEL = { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
		const HINT = { fontSize: 12, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)" };
		const H3 = { fontSize: 14, fontWeight: 700, color: "var(--dsw-alias-label-primary)", margin: 0 };
		const CONTROL = {
			width: "100%",
			padding: "6px 8px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-interactive-border)",
			background: "var(--dsw-alias-interactive-bg, transparent)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 13,
			boxSizing: "border-box"
		};

		/** Advanced fields: settings key, label, hint, and control kind. */
		const ADVANCED_FIELDS = [
			{ key: "maxTokens", label: "Max tokens", hint: "Optional output cap for the vision call; empty = adapter default.", type: "number" },
			{ key: "systemPrompt", label: "System prompt", hint: "System prompt sent to the vision model before every call.", type: "textarea" },
			{ key: "defaultPrompt", label: "Default prompt", hint: "Question used when describe_image is called without an explicit prompt.", type: "textarea" }
		];

		/** Draft strings for a resolved value (numbers rendered back as text). */
		function draftsFromValue(value) {
			const drafts = {};
			if (value === void 0) return drafts;
			for (const field of ADVANCED_FIELDS) {
				const committed = value[field.key];
				drafts[field.key] = field.type === "number" && typeof committed === "number" ? String(committed) : typeof committed === "string" ? committed : "";
			}
			return drafts;
		}

		/**
		 * The EasyVision settings section. Injected face: `scope` (bound
		 * settings namespace), `api` (connection RPC face for the model
		 * catalog), `remote` (pushed invalidation events).
		 */
		function EasyVisionSection({ scope, api, remote }) {
			if (scope === void 0) return null;
			// The scope is a class instance: its methods need `this`, so wrap
			// them instead of passing bare references (useSyncExternalStore
			// would otherwise call them unbound and crash on `this.store`).
			const scopeApi = useMemo(() => ({
				subscribe: (listener) => scope.subscribe(listener),
				getSnapshot: () => scope.getSnapshot()
			}), [scope]);
			const snapshot = useSyncExternalStore(scopeApi.subscribe, scopeApi.getSnapshot, scopeApi.getSnapshot);
			const value = snapshot.value;

			// ── model catalog (same source the composer picker uses) ────────
			const [catalog, setCatalog] = useState({ status: "loading", groups: [], failures: [], error: void 0 });
			const refreshCatalog = useCallback(() => {
				let cancelled = false;
				setCatalog((previous) => ({ ...previous, status: previous.groups.length > 0 ? previous.status : "loading" }));
				Promise.resolve(api.llm.models({})).then((response) => {
					if (cancelled) return;
					if (!response.result.ok) throw new Error(response.result.error?.message ?? "model catalog request failed");
					const catalogValue = response.result.value;
					setCatalog({
						status: "ready",
						groups: Array.isArray(catalogValue.groups) ? catalogValue.groups : [],
						failures: Array.isArray(catalogValue.failures) ? catalogValue.failures : [],
						error: void 0
					});
				}).catch((error) => {
					if (cancelled) return;
					setCatalog((previous) => ({
						...previous,
						status: "error",
						error: String(error instanceof Error ? error.message : error)
					}));
				});
				return () => {
					cancelled = true;
				};
			}, [api]);
			useEffect(() => {
				const disposers = [
					remote?.$on("llm/adapters-updated", refreshCatalog),
					remote?.$on("settings/document-updated", refreshCatalog)
				];
				refreshCatalog();
				return () => {
					for (const dispose of disposers) if (typeof dispose === "function") dispose();
				};
			}, [remote, refreshCatalog]);

			// ── drafts for the advanced fields ─────────────────────────────
			const [drafts, setDrafts] = useState(() => draftsFromValue(snapshot.value));
			const [dirty, setDirty] = useState({});
			const [feedback, setFeedback] = useState(null);
			const feedbackTimer = useRef(null);

			useEffect(() => {
				if (value === void 0) return;
				setDrafts((previous) => {
					let next = previous;
					for (const field of ADVANCED_FIELDS) {
						if (dirty[field.key] === true) continue;
						const committed = value[field.key];
						const raw = field.type === "number" && typeof committed === "number" ? String(committed) : typeof committed === "string" ? committed : "";
						if (previous[field.key] === raw) continue;
						if (next === previous) next = { ...previous };
						next[field.key] = raw;
					}
					return next;
				});
			}, [value, dirty]);

			const flash = useCallback((kind, text) => {
				setFeedback({ kind, text });
				if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
				feedbackTimer.current = setTimeout(() => setFeedback(null), 4000);
			}, []);
			useEffect(() => () => {
				if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
			}, []);

			/** Commit one advanced field: empty clears the override, valid values write. */
			const commit = useCallback((field, raw) => {
				let parsed = raw;
				if (field.type === "number") {
					if (raw.trim() === "") {
						parsed = void 0;
					} else {
						const n = Number.parseInt(raw, 10);
						if (!Number.isInteger(n) || n < 1) {
							flash("error", `${field.label} must be a positive integer (or empty for the default).`);
							setDrafts((previous) => ({ ...previous, [field.key]: value && typeof value[field.key] === "number" ? String(value[field.key]) : "" }));
							setDirty((previous) => ({ ...previous, [field.key]: false }));
							return;
						}
						parsed = n;
					}
				}
				setDirty((previous) => ({ ...previous, [field.key]: false }));
				const settle = (message) => {
					scope.load().then(() => flash("ok", message)).catch(() => flash("ok", message));
				};
				if (parsed === void 0) {
					scope.unset(field.key).then(() => settle(`${field.label}: default restored.`)).catch((error) => flash("error", `${field.label}: ${String(error?.message ?? error)}`));
				} else {
					scope.set(field.key, parsed).then(() => settle(`${field.label} saved.`)).catch((error) => flash("error", `${field.label}: ${String(error?.message ?? error)}`));
				}
			}, [scope, value, flash]);

			if (snapshot.status === "loading") {
				return h("div", { style: { ...HINT, padding: 16 } }, "Loading EasyVision settings…");
			}
			if (snapshot.status === "unavailable") {
				return h("div", { style: { ...CARD, borderColor: "var(--dsw-alias-state-error-primary)" } },
					h("div", { style: LABEL }, "EasyVision settings are unavailable on this connection."),
					h("div", { style: HINT }, "Either the connection is not loopback (the settings transport is loopback-only), or the harness's API gateway does not expose the easyvision namespace yet — run `node scripts/patch-dsh-host.mjs` from the plugin repo and restart the harness. The tool keeps using the profile's composed configuration."));
			}

			const user = typeof snapshot.user === "object" && snapshot.user !== null ? snapshot.user : {};
			const writable = snapshot.writable === true;
			const pickerOverridden = Object.prototype.hasOwnProperty.call(user, "provider") || Object.prototype.hasOwnProperty.call(user, "model");

			// Current selection, plus a fallback option when it is not in the
			// catalog (a model the provider stopped advertising stays visible).
			const currentProvider = typeof value?.provider === "string" ? value.provider : "";
			const currentModel = typeof value?.model === "string" ? value.model : "";
			const currentInCatalog = catalog.groups.some((group) => group.id === currentProvider && group.models.some((model) => model.id === currentModel));
			const groups = catalog.groups.filter((group) => group.models.length > 0);
			const pickerValue = `${currentProvider}\u0000${currentModel}`;

			const onPick = (event) => {
				const raw = event.target.value;
				if (raw === "") return;
				const [provider, model] = raw.split("\u0000");
				if (provider === void 0 || model === void 0) return;
				const settle = (message) => {
					scope.load().then(() => flash("ok", message)).catch(() => flash("ok", message));
				};
				Promise.all([scope.set("provider", provider), scope.set("model", model)])
					.then(() => settle(`${provider} / ${model} saved.`))
					.catch((error) => flash("error", String(error?.message ?? error)));
			};

			return h("div", { style: { width: "100%", maxWidth: 760, color: "var(--dsw-alias-label-primary)", display: "flex", flexDirection: "column", gap: 12 } },
				h("div", { style: { ...H3, fontSize: 16, marginBottom: 2 } }, "EasyVision"),
				h("div", { style: CARD },
					h("label", { style: LABEL }, "Vision model"),
					h("div", { style: HINT }, "The model describe_image sends images to. Pick any model from your dsh model list — only models that accept image input work; a text-only pick is refused by the tool with a clear message."),
					catalog.status === "error"
						? h("div", { style: { ...HINT, color: "var(--dsw-alias-state-error-primary)" } },
								`Could not load the model list: ${catalog.error}`,
								h(Button, { size: "sm", onClick: refreshCatalog, style: { marginLeft: 8 } }, "Retry"))
						: null,
					h("select", {
						value: pickerValue,
						disabled: !writable,
						onChange: onPick,
						style: { ...CONTROL, minHeight: 34 }
					},
						pickerOptions(catalog, groups, currentProvider, currentModel, currentInCatalog, pickerValue)),
					catalog.failures.length > 0
						? h("div", { style: HINT }, catalog.failures.map((failure) => `${failure.name || failure.id}: ${failure.message}`).join("; "))
						: null,
					h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 4 } },
						h(Pill, {}, `live · ${snapshot.mode === "memory" ? "memory" : "host"}`),
						pickerOverridden && writable
							? h(Button, { size: "sm", onClick: () => {
									Promise.all([scope.unset("provider"), scope.unset("model")])
										.then(() => flash("ok", "Model: default restored."))
										.catch((error) => flash("error", String(error?.message ?? error)));
								} }, "Reset to default")
							: null,
						feedback
							? h("span", { style: { fontSize: 12, color: feedback.kind === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-state-success-primary)" } }, feedback.text)
							: null)
				),
				h("details", { style: CARD },
					h("summary", { style: { ...LABEL, cursor: "pointer" } }, "Advanced — token cap and prompts"),
					h("div", { style: { display: "flex", flexDirection: "column", gap: 12, marginTop: 8 } },
						ADVANCED_FIELDS.map((field) => {
							const raw = typeof drafts[field.key] === "string" ? drafts[field.key] : "";
							const overridden = Object.prototype.hasOwnProperty.call(user, field.key);
							const inputProps = {
								value: raw,
								disabled: !writable,
								placeholder: field.type === "number" ? "adapter default" : "",
								onChange: (event) => {
									setDrafts((previous) => ({ ...previous, [field.key]: event.target.value }));
									setDirty((previous) => ({ ...previous, [field.key]: true }));
								},
								onBlur: (event) => commit(field, event.target.value),
								onKeyDown: (event) => {
									if (event.key === "Enter" && field.type === "number") {
										event.preventDefault();
										commit(field, event.target.value);
									}
								},
								style: {
									...CONTROL,
									resize: "vertical",
									minHeight: field.type === "textarea" ? 64 : void 0
								}
							};
							return h("div", { key: field.key, style: { display: "flex", flexDirection: "column", gap: 6 } },
								h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
									h("label", { style: LABEL }, field.label),
									overridden ? h(Pill, { style: { fontSize: 11 } }, "override") : h(Pill, { style: { fontSize: 11 } }, "default")),
								field.type === "textarea"
									? h("textarea", inputProps)
									: h(Input, { ...inputProps, type: "number", icon: void 0 }),
								h("div", { style: { display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" } },
									h("div", { style: HINT }, field.hint),
									overridden && writable
										? h(Button, { size: "sm", variant: "ghost", onClick: () => commit(field, "") }, "Reset to default")
										: null));
						}),
						!writable
							? h("div", { style: HINT }, "This deployment's settings document is read-only; the inputs are disabled.")
							: null)
				)
			);
		}

		/** Build the <select> children: fallback option + provider optgroups. */
		function pickerOptions(catalog, groups, currentProvider, currentModel, currentInCatalog, pickerValue) {
			if (groups.length === 0 && (currentProvider === "" || currentInCatalog)) {
				return h("option", { value: "" }, catalog.status === "loading" ? "Loading models…" : "No models available");
			}
			const children = [];
			if (currentProvider !== "" && !currentInCatalog) {
				children.push(h("option", { key: "current", value: pickerValue }, `${currentProvider} / ${currentModel} (not in the model list)`));
			}
			for (const group of groups) {
				children.push(h("optgroup", { key: group.id, label: group.name || group.id },
					group.models.map((model) => h("option", { key: model.id, value: `${group.id}\u0000${model.id}` },
						model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id))));
			}
			return children;
		}

		/** Register the EasyVision settings section once the settings scope binds. */
		function apply(ctx) {
			const binder = ctx.get("settingsScope");
			if (binder === void 0) return;
			const connection = ctx.get("connection");
			if (connection === void 0) return;
			const scope = binder.bind({ namespace: NS });
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "easyvision",
				order: 15,
				label: () => "EasyVision",
				inject: () => ({
					scope,
					api: connection.api,
					remote: ctx.get("remote")
				})
			}, EasyVisionSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		// Test hooks: the pure section component and the picker option builder,
		// exercised by the smoke test.
		exports.EasyVisionSection = EasyVisionSection;
		exports.pickerOptions = pickerOptions;
		return module.exports;
	}
});
