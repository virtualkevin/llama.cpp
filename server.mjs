import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('./dist', import.meta.url)));
const host = process.env.HOST || '0.0.0.0';
const port = parseInteger(process.env.PORT, 3131);
const backend = new URL(process.env.VLLM_BASE_URL || 'http://127.0.0.1:8000');
const defaultMaxTokens = parseInteger(process.env.DEFAULT_MAX_TOKENS, 4096);
const maxBodyBytes = 128 * 1024 * 1024;

const mimeTypes = new Map([
	['.css', 'text/css; charset=utf-8'],
	['.html', 'text/html; charset=utf-8'],
	['.ico', 'image/x-icon'],
	['.js', 'text/javascript; charset=utf-8'],
	['.json', 'application/json; charset=utf-8'],
	['.png', 'image/png'],
	['.svg', 'image/svg+xml'],
	['.webmanifest', 'application/manifest+json'],
	['.woff2', 'font/woff2']
]);

const allowedChatFields = new Set([
	'messages',
	'model',
	'stream',
	'temperature',
	'max_tokens',
	'top_p',
	'top_k',
	'min_p',
	'presence_penalty',
	'frequency_penalty',
	'stop',
	'seed',
	'logit_bias',
	'logprobs',
	'top_logprobs',
	'tools',
	'tool_choice',
	'parallel_tool_calls',
	'response_format',
	'user',
	'chat_template_kwargs',
	'continue_final_message',
	'add_generation_prompt'
]);

function parseInteger(value, fallback) {
	const parsed = Number.parseInt(value || '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sendJson(res, status, body) {
	const data = Buffer.from(JSON.stringify(body));
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': data.length,
		'cache-control': 'no-store'
	});
	res.end(data);
}

async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > maxBodyBytes) {
			const error = new Error('Request body is too large');
			error.status = 413;
			throw error;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

async function sanitizeChatBody(body, req) {
	const input = JSON.parse(body.toString('utf8'));
	const output = {};
	for (const [key, value] of Object.entries(input)) {
		if (allowedChatFields.has(key) && value !== undefined) output[key] = value;
	}

	if (!Number.isFinite(output.max_tokens) || output.max_tokens <= 0) {
		delete output.max_tokens;
	}

	if (Number.isFinite(input.thinking_budget_tokens)) {
		const budget = input.thinking_budget_tokens;
		output.reasoning_effort = budget <= 512 ? 'low' : budget <= 2048 ? 'medium' : 'high';
	}

	// llama-server does not require a model name, so the UI omits it in single-model mode.
	// vLLM does require one; use its first served model when the client did not choose one.
	if (!output.model) {
		const models = await fetchModels(req);
		output.model = models.data?.[0]?.id;
		if (!output.model) throw new Error('vLLM did not report a served model');
	}

	return Buffer.from(JSON.stringify(output));
}

function upstreamHeaders(req) {
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (!value) continue;
		const lower = name.toLowerCase();
		if (lower === 'host' || lower === 'connection' || lower === 'content-length') continue;
		headers.set(name, Array.isArray(value) ? value.join(', ') : value);
	}
	return headers;
}

async function proxy(req, res, pathname) {
	let body;
	if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req);
	if (req.method === 'POST' && pathname === '/v1/chat/completions') {
		body = await sanitizeChatBody(body, req);
	}

	const target = new URL(req.url, backend);
	const controller = new AbortController();
	req.once('aborted', () => controller.abort());
	const response = await fetch(target, {
		method: req.method,
		headers: upstreamHeaders(req),
		body,
		signal: controller.signal,
		redirect: 'manual'
	});

	const headers = {};
	for (const [name, value] of response.headers) {
		if (name === 'connection' || name === 'content-length' || name === 'transfer-encoding')
			continue;
		headers[name] = value;
	}
	headers['cache-control'] = 'no-store';
	res.writeHead(response.status, headers);
	if (!response.body || req.method === 'HEAD') {
		res.end();
		return;
	}
	Readable.fromWeb(response.body).pipe(res);
}

async function fetchModels(req) {
	const headers = upstreamHeaders(req);
	const response = await fetch(new URL('/v1/models', backend), { headers });
	if (!response.ok) throw new Error(`vLLM returned HTTP ${response.status}`);
	return response.json();
}

async function serveProps(req, res) {
	const models = await fetchModels(req);
	const model = models.data?.[0] || {};
	const modelName = model.id || 'vllm-model';
	const nCtx = Number.isFinite(model.max_model_len) ? model.max_model_len : 131072;
	sendJson(res, 200, {
		default_generation_settings: {
			id: 0,
			id_task: 0,
			n_ctx: nCtx,
			speculative: false,
			is_processing: false,
			params: {
				temperature: 0.6,
				top_p: 0.95,
				min_p: 0,
				presence_penalty: 0,
				frequency_penalty: 0,
				max_tokens: defaultMaxTokens,
				stream: true
			},
			prompt: '',
			next_token: {
				has_next_token: false,
				has_new_line: false,
				n_remain: 0,
				n_decoded: 0,
				stopping_word: ''
			}
		},
		total_slots: 1,
		model_path: modelName,
		model_alias: modelName,
		role: 'MODEL',
		modalities: { vision: false, audio: false, video: false },
		chat_template: '{{ reasoning_effort }}',
		bos_token: '',
		eos_token: '',
		build_info: 'standalone llama.cpp WebUI for vLLM',
		cors_proxy_enabled: false,
		ui_settings: {
			preEncodeConversation: false,
			showMessageStats: false
		}
	});
}

async function serveStatic(req, res, pathname) {
	let relative = decodeURIComponent(pathname).replace(/^\/+/, '');
	if (!relative) relative = 'index.html';
	let file = resolve(root, relative);
	if (file !== root && !file.startsWith(`${root}${sep}`)) {
		sendJson(res, 403, { error: 'Forbidden' });
		return;
	}

	let stat;
	try {
		stat = await fs.stat(file);
		if (stat.isDirectory()) {
			file = resolve(file, 'index.html');
			stat = await fs.stat(file);
		}
	} catch {
		file = resolve(root, 'index.html');
		stat = await fs.stat(file);
	}

	const type = mimeTypes.get(extname(file)) || 'application/octet-stream';
	const immutable = file !== resolve(root, 'index.html');
	res.writeHead(200, {
		'content-type': type,
		'content-length': stat.size,
		'cache-control': immutable ? 'public, max-age=3600' : 'no-cache',
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer'
	});
	if (req.method === 'HEAD') res.end();
	else createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
		const pathname = url.pathname;

		if (pathname === '/healthz') {
			sendJson(res, 200, { status: 'ok' });
			return;
		}
		if (pathname === '/props') {
			await serveProps(req, res);
			return;
		}
		if (pathname === '/slots' || pathname === '/v1/streams/lookup') {
			sendJson(res, 200, []);
			return;
		}
		if (pathname.startsWith('/v1/stream') || pathname === '/v1/chat/completions/control') {
			sendJson(res, 404, { error: 'This llama-server-only endpoint is not available with vLLM.' });
			return;
		}
		if (pathname.startsWith('/v1/')) {
			await proxy(req, res, pathname);
			return;
		}
		if (pathname === '/tools') {
			sendJson(res, 200, []);
			return;
		}
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			sendJson(res, 405, { error: 'Method not allowed' });
			return;
		}
		await serveStatic(req, res, pathname);
	} catch (error) {
		const status = Number.isInteger(error.status) ? error.status : 502;
		sendJson(res, status, { error: error.message || 'Upstream request failed' });
	}
});

server.listen(port, host, () => {
	console.log(`llama-ui listening on http://${host}:${port}`);
});
