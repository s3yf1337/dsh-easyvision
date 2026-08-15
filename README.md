# dsh-easyvision

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)
plugin that lets a text-only conversation model "see" images by delegating
them to a **dedicated vision model from the dsh model list** — called over the
harness's own LLM runtime, with no external API plumbing.

The main model (e.g. `deepseek-v4-flash`) is usually text-only, so the built-in
`read_image` tool refuses to send image blocks to it. This plugin instead
registers one tool, `describe_image`, which reads the image files through
`ctx.fs`, commits them through the durable attachment service
(`ctx.attachments.saveImage`), sends them to the configured vision model via
`ctx.llm.stream` — the exact same runtime the agent loop uses, with the
provider's own key resolution, retry policy, and middleware — and returns the
description as plain text.

## How it works

```
main model (text-only) ──describe_image(paths, prompt?)──▶ plugin
                                                              │
                                            ctx.fs.readBytes (sandbox-aware reads)
                                                              │
                                  ctx.attachments.saveImage (durable image refs)
                                                              │
                        ctx.llm.stream(provider, model, messages=[image blocks + prompt])
                                                              │
                              vision model (e.g. mimo-v2.5, kimi-k2.6)
                                                              │
                        description text ──▶ main model
```

* The vision provider/model come from the **dsh model list** (the same models
  you configure in Settings → Models). The plugin refuses to run when the
  configured model is not in that list or does not declare `image` input.
* Images are validated (PNG/JPEG/WebP/GIF, size caps, magic-byte checks) by
  the same attachment pipeline as `read_image`.
* The tool registers only while a durable attachment store is mounted.

## Installation

Add the plugin to a profile (the examples use the `desktop` profile, adjust
for `web`/`headless`):

1. Install the package into the profile:

   ```bash
   dsh plugin --profile desktop add dsh-easyvision
   # or, for a local checkout:
   #   add "dsh-easyvision": "file:/path/to/dsh-easyvision" to the profile's package.json
   #   and run pnpm install in the profile directory
   ```

2. Load it in the profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: easyvision
         name: 'dsh-easyvision'
         config:
           provider: opencode-go
           model: mimo-v2.5
   ```

3. Restart the harness. The model must be present in your dsh model list
   (`~/.dsh/settings.yaml` or via Settings → Models) and the provider must
   actually serve it.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `provider` | `opencode-go` | Provider route owning the vision model. |
| `model` | `mimo-v2.5` | Model id from that provider's model list; must accept image input. |
| `maxTokens` | *(adapter default)* | Optional output cap for the vision call. |
| `toolName` | `describe_image` | Model-facing tool name. |
| `systemPrompt` | "You are a helpful vision assistant…" | System prompt sent to the vision model. |
| `defaultPrompt` | "Describe what you see…" | Question used when the model calls the tool without an explicit `prompt`. |

## Tool

`describe_image(file_paths: string[], prompt?: string)` — sends one or more
image files to the vision model and returns its description as text. The
result also reports the resolved `provider`, `model`, per-image dimensions,
and whether the response hit the token limit.

## Development / testing

```bash
# headless smoke test (plugin must be installed in the headless profile)
dsh --profile headless "Use describe_image on testpics/1.jpg and report what it returns"
```

## Known upstream caveats

* As of this writing the `opencode.ai` gateway answers **all** `mimo-*`
  model ids on some accounts with `403 {"model":"mimo-v2.5"}` (AUTH), while
  other models on the same key work fine. If `describe_image` fails with
  `AUTH`, either fix the model's availability on the provider side or point
  the plugin at another vision-capable model from your model list
  (e.g. `kimi-k2.6`).

## License

MIT
