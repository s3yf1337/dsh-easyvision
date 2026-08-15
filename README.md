# dsh-easyvision

![version](https://img.shields.io/badge/version-0.3.1-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![dsh](https://img.shields.io/badge/dsh-plugin-4B32C3)

**Give your text-only agent eyes — with one command and zero extra APIs.**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)
plugin that lets a text-only conversation model "see" images by delegating
them to a **vision model from your own dsh model list**, called over the
harness's own LLM runtime.

## Why

Your main model (e.g. `deepseek-v4-flash`) is text-only, so dsh's built-in
`read_image` tool refuses to send image blocks to it. dsh-easyvision fixes
that by registering one extra tool — `describe_image` — which hands the
picture to a vision-capable model and returns the description as plain text.

No external API keys. No extra plumbing. Just a model that can see, picked
from the models you already have.

## Features

- **One command install** — idempotent, safe to re-run
- **Zero external APIs** — the vision call goes through `ctx.llm`, the exact
  same runtime the agent loop uses: your keys, your retry policy, your middleware
- **Any vision model** — pick anything from your dsh model list in
  Settings → EasyVision; no vendor lock-in
- **Live configuration** — model changes apply immediately, no restart
- **Multiple images per call** — validated PNG/JPEG/WebP/GIF, same
  attachment pipeline as `read_image`

## Screenshots

Configure the vision model in the dsh **Settings** UI — no file editing:

![Settings → EasyVision](docs/settings-easyvision.png)

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/s3yf1337/dsh-easyvision/main/install.sh | bash
```

That's it. Then open **Settings → EasyVision** and pick a vision-capable
model from your list (the default is `qwen3.7-plus` on `opencode-go`).

> Only models that declare image input work — a text-only pick is refused by
> the tool with a clear message.

## Demo

```text
$ dsh "what's in testpics/1.jpg?"

  ✦ describe_image(file_paths=["testpics/1.jpg"])
  ✓ qwen3.7-plus (opencode-go) · 1024×1024

  A futuristic cityscape at night — glowing cyan and blue towers
  under three moons, rendered in a digital painting style.
```

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
                              vision model (e.g. qwen3.7-plus)
                                                              │
                        description text ──▶ main model
```

The plugin validates the configured model against your dsh model list and
refuses to run when it is missing or does not declare `image` input — before
any filesystem I/O.

## Configuration

Everything is optional — the defaults work out of the box.

| Control | Meaning |
|---|---|
| **Vision model** (picker) | Any model from your dsh model list, grouped by provider — the same catalog the composer's picker uses. |
| Advanced → Max tokens | Optional output cap for the vision call. |
| Advanced → System prompt | System prompt sent to the vision model before every call. |
| Advanced → Default prompt | Question used when `describe_image` is called without a prompt. |

Profile-level defaults live in the plugin's entry config
(`cordis.patch.yml`) and act as the base layer: Settings overrides inherit
from it, and "Reset to default" restores it.

## Tool

`describe_image(file_paths: string[], prompt?: string)` — sends one or more
image files to the vision model and returns its description, plus the
resolved provider/model, per-image dimensions, and whether the response hit
the token limit.

## Troubleshooting

<details>
<summary>Settings shows "unavailable" for EasyVision</summary>

The harness's API gateway serves only an explicit allowlist of settings
namespaces to the browser, so the plugin cannot extend it through a seam
yet. Run `node scripts/patch-dsh-host.mjs` (one-time, idempotent — re-run
after every dsh upgrade). The tool itself keeps working without it, using
the profile-level defaults.
</details>

<details>
<summary><code>AUTH</code> errors from the vision model</summary>

Model choice matters for quotas. On the opencode.ai Zen GO plan
(requests per 5 h / week / month) good vision-capable options include:
qwen3.7-plus **4 300 / 10 800 / 21 600** (the default), MiniMax M3
3 200 / 8 000 / 16 000, Qwen3.6 Plus 3 300 / 8 200 / 16 300, GPT-5.6 Luna
2 050 / 5 100 / 10 250, Kimi K2.6 1 150 / 2 880 / 5 750.

MiMo-V2.5 has by far the best quota (30 100 / 75 200 / 150 400), but as of
this writing the `opencode.ai` gateway answers **all** `mimo-*` model ids on
some accounts with `403` (AUTH), while other models on the same key work
fine. If `describe_image` fails with `AUTH`, pick another vision-capable
model from your list.
</details>

## Manual installation

<details>
<summary>Wire it by hand (advanced)</summary>

1. Add `"dsh-easyvision": "file:/path/to/dsh-easyvision"` to the profile's
   `package.json` dependencies and link it into the profile's `node_modules`
   (or `dsh plugin --profile NAME add dsh-easyvision`).
2. Load it in the profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: easyvision
         name: 'dsh-easyvision'
         config:
           provider: opencode-go
           model: qwen3.7-plus
   ```

3. Expose the settings namespace to the web client:
   `node scripts/patch-dsh-host.mjs` (one-time; re-run after dsh upgrades).
4. Restart the harness. The model must be present in your dsh model list
   (`~/.dsh/settings.yaml` or Settings → Models) and the provider must
   actually serve it.

Install script options: `--profile NAME` (default `desktop`), `--link`
(symlink a dev checkout), `--no-restart`.
</details>

## Development

```bash
# headless smoke test (plugin must be installed in the headless profile)
dsh --profile headless "Use describe_image on testpics/1.jpg and report what it returns"
```

## License

MIT
