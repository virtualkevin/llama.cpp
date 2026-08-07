# Standalone llama.cpp WebUI

This branch contains only the llama.cpp WebUI source and a small stateless host for OpenAI-compatible vLLM servers.

## Storage model

- Conversations and messages are stored in browser IndexedDB.
- Settings and small UI state are stored in browser localStorage.
- The host has no database, cookies, sessions, telemetry, or request logging.
- Prompts and responses pass through the host while a request is active and are not retained.

## Run with Docker

The default configuration expects vLLM at `http://127.0.0.1:8000` and serves the UI on port 3131.

```sh
docker compose up --build -d
```

Open `http://SERVER_IP:3131`.

Configuration is provided through environment variables:

| Variable             | Default                 | Purpose                       |
| -------------------- | ----------------------- | ----------------------------- |
| `PORT`               | `3131`                  | UI listen port                |
| `HOST`               | `0.0.0.0`               | UI listen address             |
| `VLLM_BASE_URL`      | `http://127.0.0.1:8000` | vLLM server origin            |
| `DEFAULT_MAX_TOKENS` | `4096`                  | Default maximum output length |

The Compose service uses host networking so the UI can reach a vLLM process bound to the host loopback interface. The container filesystem is read-only and has no volumes.

## Build without Docker

Node.js 24 is the tested version.

```sh
npm ci
npm run check
npm run build
PORT=3131 VLLM_BASE_URL=http://127.0.0.1:8000 node server.mjs
```

## API compatibility

The browser uses the original llama.cpp UI unchanged. The stateless host:

- serves the compiled static files;
- forwards OpenAI-compatible `/v1` requests to vLLM;
- provides the read-only `/props` metadata expected by llama.cpp UI;
- advertises reasoning support without exposing a fake chat template;
- maps the reasoning selector to vLLM's native `reasoning_effort` values;
- disables llama-server-only resumable streams and slot inspection; and
- removes llama.cpp-only generation fields before forwarding chat requests.

The compatibility layer is intentionally separate from upstream UI code so upstream refreshes remain small and reviewable.
