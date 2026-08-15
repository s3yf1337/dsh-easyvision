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
		 * The main control is a model picker that mirrors the composer's model
		 * selection (dsh-client-ui-model-selection): the same trigger pill and
		 * dropdown menu styling, provider-grouped model list from the same
		 * `llm.models` catalog, checkmark on the current selection, keyboard
		 * navigation, and click-outside/Escape closing. Picking writes
		 * provider + model through `scope.set`; an "Advanced" fold holds the
		 * token cap and prompt templates. The tool on the host side reads the
		 * resolved section live, so every change applies immediately.
		 */
		const { createElement: h, useState, useEffect, useCallback, useMemo, useRef, useId, useSyncExternalStore } = react;
		const { Button, IconCheckOutline16, IconChevronDownOutline14, Input, Pill } = primitives;

		const NS = "easyvision";
		const inject = ["slots", "settingsScope", "connection", "remote"];

		// ── picker styles: the composer ModelSelect look (same tokens) ─────
		// The menu opens DOWNWARD here (settings page), not upward (composer).
		const PICKER_CSS = `
._ev_root{min-width:0;position:relative}
._ev_trigger{min-width:0;width:100%;height:32px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:6px;padding:0 8px 0 12px;font-size:13px;font-weight:500;line-height:20px;display:flex}
._ev_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
._ev_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
._ev_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
._ev_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
._ev_triggerEffort{color:var(--dsw-alias-label-caption);flex:none}
._ev_chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}
._ev_chevronOpen{transform:rotate(180deg)}
._ev_menu{z-index:20;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:min(240px,100vw - 32px);max-height:min(360px,100vh - 96px);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex-direction:column;padding:4px;display:flex;position:absolute;top:calc(100% + 8px);left:0;overflow:hidden}
._ev_status,.ev_empty{color:var(--dsw-alias-label-tertiary);padding:10px;font-size:13px;line-height:20px}
._ev_error,.ev_warning{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:8px;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;padding:7px 8px;font-size:12px;line-height:18px;display:flex}
._ev_warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}
._ev_retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-weight:600}
._ev_groups{min-height:0;overflow-y:auto}
._ev_group+._ev_group{margin-top:4px}
._ev_groupTitle{z-index:1;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);padding:5px 8px 3px;font-size:12px;font-weight:500;line-height:18px;position:sticky;top:0}
._ev_option{width:100%;min-height:38px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:10px;outline:none;align-items:center;gap:8px;padding:6px 8px;display:flex}
._ev_option:hover:not(:disabled),._ev_option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
._ev_option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
._ev_optionCopy{flex-direction:column;flex:1;min-width:0;display:flex}
._ev_modelName{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}
._ev_description{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}
._ev_check{color:var(--dsw-alias-label-primary);flex:0 0 18px;place-items:center;display:grid}
`;
		{
			const tagId = "dsh-easyvision/ModelSelect.module.css";
			if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-easyvision";
				tag.dataset.pluginCss = tagId;
				tag.textContent = PICKER_CSS;
				document.head.appendChild(tag);
			}
		}

		/** Card / label / hint style tokens for the rest of the section. */
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
		 * Build the menu rows for the model picker: the current selection
		 * first when it is absent from the catalog, then one group section
		 * per provider. Pure, so the smoke test can exercise it directly.
		 */
		function pickerRows(groups, currentProvider, currentModel) {
			const rows = [];
			const known = groups.some((group) => group.id === currentProvider && group.models.some((model) => model.id === currentModel));
			if (currentProvider !== "" && !known) {
				rows.push({
					key: "current",
					title: `${currentProvider} / ${currentModel}`,
					description: "not in the model list",
					value: `${currentProvider}\u0000${currentModel}`,
					selected: true
				});
			}
			for (const group of groups) {
				const models = group.models.filter((model) => !(group.id === currentProvider && model.id === currentModel && !known));
				if (models.length === 0) continue;
				rows.push({
					key: group.id,
					groupTitle: group.name || group.id,
					options: models.map((model) => ({
						key: model.id,
						title: model.name || model.id,
						description: model.description || group.name || group.id,
						value: `${group.id}\u0000${model.id}`,
						selected: group.id === currentProvider && model.id === currentModel
					}))
				});
			}
			return rows;
		}

		/**
		 * The model picker: composer-style trigger pill and dropdown menu.
		 * @param props - catalog + current selection + verbs.
		 */
		function EasyVisionPicker({ catalog, currentProvider, currentModel, writable, onPick, onRetry }) {
			const [open, setOpen] = useState(false);
			const rootRef = useRef(null);
			const triggerRef = useRef(null);
			const itemRefs = useRef([]);
			const id = useId();

			const groups = catalog.groups.filter((group) => group.models.length > 0);
			// While the catalog is loading, do not present the selection as
			// "not in the model list" — the list just has not arrived yet.
			const rows = useMemo(() => catalog.status === "loading" ? [] : pickerRows(groups, currentProvider, currentModel), [catalog.status, groups, currentProvider, currentModel]);
			const currentRow = (() => {
				for (const row of rows) {
					if (!Array.isArray(row.options)) {
						if (row.selected) return row;
						continue;
					}
					for (const option of row.options) if (option.selected) return option;
				}
				return void 0;
			})();
			const triggerLabel = currentRow?.title ?? (currentProvider === "" ? "Select model" : `${currentProvider} / ${currentModel}`);
			const triggerEffort = catalog.status === "loading"
				? (currentProvider === "" ? "" : currentProvider)
				: (currentRow?.description ?? (currentProvider === "" ? "" : currentProvider));
			const busy = catalog.status === "loading";

			useEffect(() => {
				if (!open) return;
				const closeOutside = (event) => {
					if (!rootRef.current?.contains(event.target)) setOpen(false);
				};
				document.addEventListener("mousedown", closeOutside);
				return () => document.removeEventListener("mousedown", closeOutside);
			}, [open]);

			const close = (restoreFocus = false) => {
				setOpen(false);
				if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
			};
			const moveFocus = (offset) => {
				const items = itemRefs.current.filter((item) => item !== null);
				if (items.length === 0) return;
				const active = items.findIndex((item) => item === document.activeElement);
				items[(Math.max(active, 0) + offset + items.length) % items.length]?.focus();
			};
			const onRootKeyDown = (event) => {
				if (event.key === "Escape" && open) {
					event.preventDefault();
					close(true);
					return;
				}
				if (!open) return;
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					moveFocus(event.key === "ArrowDown" ? 1 : -1);
				}
			};
			const onBlur = (event) => {
				if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return;
				close();
			};
			itemRefs.current = [];
			let itemIndex = 0;
			const itemRef = () => {
				const at = itemIndex++;
				return (node) => {
					itemRefs.current[at] = node;
				};
			};

			return h("div", { ref: rootRef, className: "_ev_root", onKeyDown: onRootKeyDown, onBlur },
				h("button", {
					ref: triggerRef,
					type: "button",
					className: "_ev_trigger",
					"aria-haspopup": "menu",
					"aria-expanded": open,
					"aria-controls": open ? `${id}-menu` : void 0,
					title: triggerLabel,
					disabled: !writable,
					onClick: () => {
						if (open) close();
						else {
							setOpen(true);
							onRetry();
						}
					}
				},
					h("span", { className: "_ev_triggerLabel" }, triggerLabel),
					triggerEffort !== ""
						? h("span", { className: "_ev_triggerEffort" }, triggerEffort)
						: null,
					h(IconChevronDownOutline14, { className: open ? "_ev_chevron _ev_chevronOpen" : "_ev_chevron" })),
				open
					? h("div", { id: `${id}-menu`, className: "_ev_menu", role: "menu", "aria-label": "Vision model", "aria-busy": busy },
							catalog.status === "loading" && rows.length === 0
								? h("div", { className: "_ev_status" }, "Loading models…")
								: null,
							catalog.status === "error"
								? h("div", { className: "_ev_error" },
										h("span", {}, `Could not load the model list: ${catalog.error}`),
										h("button", { type: "button", className: "_ev_retry", onClick: onRetry }, "Retry"))
								: null,
							catalog.failures.map((failure) => h("div", { key: failure.id, className: "_ev_warning" },
								h("span", {}, `${failure.name || failure.id}: ${failure.message}`),
								h("button", { type: "button", className: "_ev_retry", onClick: onRetry }, "Retry"))),
							rows.length === 0 && catalog.status !== "loading"
								? h("div", { className: "ev_empty" }, "No models available")
								: h("div", { className: "_ev_groups scrollable" },
										rows.map((row) => Array.isArray(row.options)
											? h("section", { key: row.key, role: "group", "aria-labelledby": `${id}-${row.key}`, className: "_ev_group" },
													h("div", { className: "_ev_groupTitle", id: `${id}-${row.key}` }, row.groupTitle),
													row.options.map((option) => h("button", {
														ref: itemRef(),
														key: option.key,
														type: "button",
														role: "menuitemradio",
														"aria-checked": option.selected,
														className: "_ev_option",
														title: option.title,
														disabled: busy,
														onClick: () => {
															const [provider, model] = option.value.split("\u0000");
															onPick(provider, model);
															close(true);
														}
													},
														h("span", { className: "_ev_optionCopy" },
															h("span", { className: "_ev_modelName" }, option.title),
															h("span", { className: "_ev_description" }, option.description)),
														h("span", { className: "_ev_check" }, option.selected ? h(IconCheckOutline16, {}) : null))))
											: h("section", { key: row.key, role: "group", className: "_ev_group" },
													h("div", { className: "_ev_groupTitle" }, "Current selection"),
													h("button", {
														ref: itemRef(),
														type: "button",
														role: "menuitemradio",
														"aria-checked": true,
														className: "_ev_option",
														title: row.title,
														disabled: busy,
														onClick: () => {
															const [provider, model] = row.value.split("\u0000");
															onPick(provider, model);
															close(true);
														}
													},
														h("span", { className: "_ev_optionCopy" },
															h("span", { className: "_ev_modelName" }, row.title),
															h("span", { className: "_ev_description" }, row.description)),
														h("span", { className: "_ev_check" }, h(IconCheckOutline16, {})))))))
					: null
			);
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
			const currentProvider = typeof value?.provider === "string" ? value.provider : "";
			const currentModel = typeof value?.model === "string" ? value.model : "";

			const onPick = (provider, model) => {
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
					h(EasyVisionPicker, {
						catalog,
						currentProvider,
						currentModel,
						writable,
						onPick,
						onRetry: refreshCatalog
					}),
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
		// Test hooks: the pure section component, the picker, and the row
		// builder, exercised by the smoke test.
		exports.EasyVisionSection = EasyVisionSection;
		exports.EasyVisionPicker = EasyVisionPicker;
		exports.pickerRows = pickerRows;
		return module.exports;
	}
});
