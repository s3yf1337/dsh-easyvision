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
		 * Binds the `easyvision` settings namespace through `ctx.settingsScope`
		 * (the same Host transport every preference row uses) and renders a
		 * small form for the vision model selection: provider, model, optional
		 * max-token cap, and the two prompt templates. Every field commits on
		 * blur or Enter through `scope.set` / `scope.unset`; an empty value
		 * clears the override so the field re-inherits the composition base
		 * (the profile's entry config) and schema defaults. The tool on the
		 * host side reads the resolved section live on every call, so changes
		 * apply immediately — no restart.
		 */
		const { createElement: h, useState, useEffect, useCallback, useRef, useSyncExternalStore } = react;
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

		/** Field descriptors: settings key, label, hint, and control kind. */
		const FIELDS = [
			{ key: "provider", label: "Provider", hint: "Provider route owning the vision model (from the dsh model list).", type: "text" },
			{ key: "model", label: "Vision model", hint: "Model id from that provider's model list; it must accept image input.", type: "text" },
			{ key: "maxTokens", label: "Max tokens", hint: "Optional output cap for the vision call; empty = adapter default.", type: "number" },
			{ key: "systemPrompt", label: "System prompt", hint: "System prompt sent to the vision model before every call.", type: "textarea" },
			{ key: "defaultPrompt", label: "Default prompt", hint: "Question used when describe_image is called without an explicit prompt.", type: "textarea" }
		];

		/** Draft strings for a resolved value (numbers rendered back as text). */
		function draftsFromValue(value) {
			const drafts = {};
			if (value === void 0) return drafts;
			for (const field of FIELDS) {
				const committed = value[field.key];
				drafts[field.key] = field.type === "number" && typeof committed === "number" ? String(committed) : typeof committed === "string" ? committed : "";
			}
			return drafts;
		}

		/**
		 * The EasyVision settings section. `scope` is the bound settings
		 * namespace scope; `close` (the shell affordance) is unused here.
		 */
		function EasyVisionSection({ scope }) {
			if (scope === void 0) return null;
			const snapshot = useSyncExternalStore(scope.subscribe, scope.getSnapshot, scope.getSnapshot);
			const value = snapshot.value;
			const [drafts, setDrafts] = useState(() => draftsFromValue(snapshot.value));
			const [dirty, setDirty] = useState({});
			const [feedback, setFeedback] = useState(null); // { kind: 'ok' | 'error', text }
			const feedbackTimer = useRef(null);

			// Adopt committed values into the drafts, without clobbering a
			// field the user is currently editing.
			useEffect(() => {
				if (value === void 0) return;
				setDrafts((previous) => {
					let next = previous;
					for (const field of FIELDS) {
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

			/** Commit one field: empty clears the override, valid values write. */
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
					h("div", { style: HINT }, "The settings transport only works on the loopback connection; the tool keeps using the profile's composed configuration."));
			}

			const user = typeof snapshot.user === "object" && snapshot.user !== null ? snapshot.user : {};
			const writable = snapshot.writable === true;

			return h("div", { style: { width: "100%", maxWidth: 760, color: "var(--dsw-alias-label-primary)", display: "flex", flexDirection: "column", gap: 12 } },
				h("div", { style: { ...H3, fontSize: 16, marginBottom: 2 } }, "EasyVision"),
				h("div", { style: CARD },
					h("div", { style: H3 }, "Vision model"),
					h("div", { style: HINT }, "The model describe_image sends images to. It must be in your dsh model list (Settings → Models) and accept image input. Changes apply live — no restart needed."),
					h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 4 } },
						h(Pill, {}, `live · ${snapshot.mode === "memory" ? "memory" : "host"}`),
						feedback
							? h("span", { style: { fontSize: 12, color: feedback.kind === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-state-success-primary)" } }, feedback.text)
							: null)
				),
				FIELDS.map((field) => {
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
							if (event.key === "Enter" && (field.type === "text" || field.type === "number")) {
								event.preventDefault();
								commit(field, event.target.value);
							}
						},
						style: {
							width: "100%",
							padding: "6px 8px",
							borderRadius: 8,
							border: "1px solid var(--dsw-alias-interactive-border)",
							background: "var(--dsw-alias-interactive-bg, transparent)",
							color: "var(--dsw-alias-label-primary)",
							font: "inherit",
							fontSize: 13,
							boxSizing: "border-box",
							resize: "vertical",
							minHeight: field.type === "textarea" ? 64 : void 0
						}
					};
					return h("div", { key: field.key, style: { ...CARD, gap: 8 } },
						h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
							h("label", { style: LABEL }, field.label),
							overridden ? h(Pill, { style: { fontSize: 11 } }, "override") : h(Pill, { style: { fontSize: 11 } }, "default")),
						field.type === "textarea"
							? h("textarea", inputProps)
							: h(Input, { ...inputProps, type: field.type === "number" ? "number" : "text", icon: void 0 }),
						h("div", { style: { display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" } },
							h("div", { style: HINT }, field.hint),
							overridden && writable
								? h(Button, { size: "sm", variant: "ghost", onClick: () => commit(field, "") }, "Reset to default")
								: null)
					);
				}),
				!writable
					? h("div", { style: { ...HINT, padding: "0 4px" } }, "This deployment's settings document is read-only; the inputs are disabled.")
					: null
			);
		}

		/** Register the EasyVision settings section once the settings scope binds. */
		function apply(ctx) {
			const binder = ctx.get("settingsScope");
			if (binder === void 0) return;
			const scope = binder.bind({ namespace: NS });
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "easyvision",
				order: 15,
				label: () => "EasyVision",
				inject: () => ({ scope })
			}, EasyVisionSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		// Test hook: the pure section component, exercised by the smoke test.
		exports.EasyVisionSection = EasyVisionSection;
		return module.exports;
	}
});
