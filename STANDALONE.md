# Standalone Llama Chat: refresh inventory

Source comparison: the `webui` fork at `a07af1caa` **plus its local, uncommitted capability, video and routing changes**, versus upstream llama.cpp `5bd90fa0e40b79af1f7e7e8b2802223c1b15d118`. The new base is the upstream **ui/** subtree (`538e5f985`), not the former **tools/ui**. Chat now builds against sibling libraries. The production tree, container, browser origin and upstream remotes are not replaced by creating this worktree.

| Fork behavior to retain | How the refresh supplies it |
| --- | --- |
| Just the chat UI; no model runtime in the image | Build upstream Llama Chat. Run upstream's static HTTP handler behind a small Node built-in API adapter. No npm dependencies in the runtime image. |
| Client-only chat history/settings | Upstream IndexedDB (`LlamaUi`) and localStorage, no host-side chat DB, sessions, request logs or chat volume. Requests and streams are in memory only. Runtime is unprivileged and read-only. Upstream inference servers have their own logging policy. |
| Select a served model, including multiple OpenAI-compatible backends | Aggregate configured catalogs, route by model ID, publish per-model read-only props. Use distinct model IDs across backends. |
| Per-model reasoning dropdown, with Default/Off and native effort names | Use upstream's single-model button, model picker and mobile menu. Supply real capability metadata, not a fake Jinja template. Default omits the effort; unsupported saved preferences fall back to Default. |
| Live reasoning, post-completion editing, generation stats | Normalize both reasoning delta formats. Edit reasoning separately from the answer; save both in IndexedDB, in place or on a branch. Preserve native timings when present; otherwise derive stream timings from usage and first output. No invented decode rate on a nonstreamed response. |
| Images and video | Advertise modalities per model. Upstream already has reactive upload error details; use its attachment UI. Keep image URLs and translate inline video to a video data URL. |
| vLLM-compatible generation and cancellation | Apply the default output limit when absent; retain custom JSON and tools; translate repetition penalty; omit llama-only sampler controls. Stream UTF-8 safely and abort backend fetch when the browser disconnects. |
| Unsupported operations stay unavailable | No remote execution, file API, model download/load/unload, LoRA management, server-side replay or MCP proxy. Suppress native pre-encode and skip-reasoning controls. Optional browser tools/direct MCP require an explicit host opt-in (`BROWSER_AGENT_ENABLED=true`); default is ordinary chat. |

## Build and verify

From the filtered repository root:

```sh
docker build -t llama-chat:refresh .
cd apps/chat
npm ci
npm run check
npm run test:unit -- --run
node --test standalone/adapter.test.mjs
npm run build
node standalone/browser-smoke.mjs  # matching Playwright Chromium installed
```

For staging, use a separate container name, a loopback-only port, and the same
`VLLM_BACKENDS` configuration as the current model launcher. Do not start the
production Compose service just to preview an image. A different browser origin
will have an empty history by design. Before cutover, export important chats in
the old UI: preserving the origin allows upstream's DB migrations to run but
rolling back the container does **not** roll back a browser schema migration.

## Future upstream refreshes

Fetch `upstream/master`. In a clean **full-source** worktree at that revision,
run `git subtree split --prefix=ui -b ui-base-<revision>`. In the clean
standalone worktree, rebase the reviewed standalone commits with
`git rebase --onto ui-base-<revision> <previous-filtered-base>`. Do not rebase
against the monorepo root, or use the legacy script targeting `tools/ui`.
Keep site addresses and model-specific capabilities in deployment overrides.
