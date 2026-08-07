# Maintaining the standalone branch

The `webui` branch is based on history filtered from `tools/ui` in the full llama.cpp repository. The full source remains on `master`. The `ui-upstream` branch marks the current filtered upstream base.

## Refresh from llama.cpp

Start with a clean `webui` worktree, then run:

```sh
bash scripts/update-llama-ui.sh
```

The script performs these operations:

1. fetches `ggml-org/llama.cpp` through the `upstream` remote;
2. filters the latest `tools/ui` history into a temporary branch;
3. rebases standalone commits onto that filtered history; and
4. advances the `ui-upstream` marker after a successful rebase.

Resolve conflicts only in the small standalone layer. Do not merge the full upstream repository into `webui`.

## Branch roles

| Branch        | Purpose                                                        |
| ------------- | -------------------------------------------------------------- |
| `master`      | Full fork of llama.cpp; recovery and source reference          |
| `ui-upstream` | Filtered `tools/ui` base used by the current standalone branch |
| `webui`       | Standalone UI plus vLLM compatibility and deployment files     |

The filtered branch preserves file history for the UI. A large deletion commit does not: it conflicts with unrelated upstream changes and lets newly added non-UI files leak back into the fork.

## Verification after an update

```sh
npm ci
npm run check
npm run lint
npm run test:unit -- --run --passWithNoTests
npm run build
docker compose build
```

Then verify `/healthz`, `/props`, `/v1/models`, and one streaming chat request against vLLM.
