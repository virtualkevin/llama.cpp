import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, extname, resolve, sep } from 'node:path';
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

const blockedChatFields = new Set([
	'backend_sampling',
	'dry_allowed_length',
	'dry_base',
	'dry_multiplier',
	'dry_penalty_last_n',
	'dynatemp_exponent',
	'dynatemp_range',
	'n_predict',
	'reasoning_control',
	'reasoning_format',
	'repeat_last_n',
	'repeat_penalty',
	'return_progress',
	'samplers',
	'sse_ping_interval',
	'thinking_budget_tokens',
	'timings_per_token',
	'typ_p',
	'xtc_probability',
	'xtc_threshold'
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
	let input;
	try {
		input = JSON.parse(body.toString('utf8'));
	} catch {
		const error = new Error('Request body must be valid JSON');
		error.status = 400;
		throw error;
	}

	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		const error = new Error('Request body must be a JSON object');
		error.status = 400;
		throw error;
	}
	if (Object.hasOwn(input, 'n_predict')) {
		const error = new Error('n_predict is not supported by the vLLM adapter');
		error.status = 400;
		throw error;
	}

	const output = { ...input };
	for (const field of blockedChatFields) delete output[field];

	if (Number.isFinite(input.repeat_penalty) && !Number.isFinite(output.repetition_penalty)) {
		output.repetition_penalty = input.repeat_penalty;
	}

	if (!Number.isFinite(output.max_completion_tokens)) {
		if (!Number.isFinite(output.max_tokens) || output.max_tokens <= 0) {
			output.max_tokens = defaultMaxTokens;
		}
	} else {
		delete output.max_tokens;
	}

	const enableThinking = input.chat_template_kwargs?.enable_thinking;
	if (!output.reasoning_effort && enableThinking === false) {
		output.reasoning_effort = 'none';
	} else if (!output.reasoning_effort && Number.isFinite(input.thinking_budget_tokens)) {
		const budget = input.thinking_budget_tokens;
		output.reasoning_effort = budget <= 512 ? 'low' : budget <= 2048 ? 'medium' : 'high';
	} else if (enableThinking === true && !output.reasoning_effort) {
		output.reasoning_effort = 'max';
	}

	if (Array.isArray(output.tools) && output.tools.length > 0 && !output.tool_choice) {
		output.tool_choice = 'auto';
	}

	if (output.stream === true) {
		const streamOptions =
			output.stream_options && typeof output.stream_options === 'object'
				? output.stream_options
				: {};
		output.stream_options = {
			...streamOptions,
			include_usage: true,
			continuous_usage_stats: true
		};
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

function normalizeReasoning(payload) {
	for (const choice of payload.choices || []) {
		for (const part of [choice.delta, choice.message]) {
			if (!part || typeof part !== 'object') continue;
			if (part.reasoning && !part.reasoning_content) part.reasoning_content = part.reasoning;
			delete part.reasoning;
		}
	}
	return payload;
}

function usageTimings(usage, requestStartedAt, firstOutputAt, now) {
	const promptTokens = Number(usage?.prompt_tokens) || 0;
	const cachedTokens = Number(usage?.prompt_tokens_details?.cached_tokens) || 0;
	const completionTokens = Number(usage?.completion_tokens) || 0;
	const outputStartedAt = firstOutputAt ?? now;
	return {
		prompt_n: Math.max(0, promptTokens - cachedTokens),
		prompt_ms: Math.max(0, outputStartedAt - requestStartedAt),
		predicted_n: completionTokens,
		predicted_ms: completionTokens > 0 ? Math.max(1, now - outputStartedAt) : 0,
		cache_n: cachedTokens
	};
}

class ChatStreamTransform extends Transform {
	constructor(requestStartedAt) {
		super();
		this.requestStartedAt = requestStartedAt;
		this.firstOutputAt = null;
		this.pending = '';
	}

	transformLine(line) {
		if (!line.startsWith('data:')) return line;
		const data = line.slice(5).trim();
		if (!data || data === '[DONE]') return line;
		try {
			const payload = normalizeReasoning(JSON.parse(data));
			const delta = payload.choices?.[0]?.delta;
			if (
				this.firstOutputAt === null &&
				(delta?.content || delta?.reasoning_content || delta?.tool_calls?.length)
			) {
				this.firstOutputAt = performance.now();
			}
			if (payload.usage) {
				payload.timings = usageTimings(
					payload.usage,
					this.requestStartedAt,
					this.firstOutputAt,
					performance.now()
				);
			}
			return `data: ${JSON.stringify(payload)}`;
		} catch {
			return line;
		}
	}

	_transform(chunk, _encoding, callback) {
		this.pending += chunk.toString('utf8');
		const lines = this.pending.split('\n');
		this.pending = lines.pop() || '';
		for (const line of lines) this.push(`${this.transformLine(line)}\n`);
		callback();
	}

	_flush(callback) {
		if (this.pending) this.push(this.transformLine(this.pending));
		callback();
	}
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

async function proxy(req, res, url) {
	const pathname = url.pathname;
	const requestStartedAt = performance.now();
	let body;
	if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req);
	if (req.method === 'POST' && pathname === '/v1/chat/completions') {
		body = await sanitizeChatBody(body, req);
	}

	const target = upstreamTarget(url);
	const controller = new AbortController();
	const abortUpstream = () => controller.abort();
	req.once('aborted', abortUpstream);
	res.once('error', abortUpstream);
	res.once('close', () => {
		if (!res.writableEnded) abortUpstream();
	});
	const response = await fetch(target, {
		method: req.method,
		headers: upstreamHeaders(req),
		body,
		signal: controller.signal,
		redirect: 'manual'
	});

	const headers = {};
	for (const [name, value] of response.headers) {
		if (
			name === 'connection' ||
			name === 'content-encoding' ||
			name === 'content-length' ||
			name === 'transfer-encoding'
		)
			continue;
		headers[name] = value;
	}
	headers['cache-control'] = 'no-store';
	res.writeHead(response.status, headers);
	if (!response.body || req.method === 'HEAD') {
		res.end();
		return;
	}
	const source = Readable.fromWeb(response.body);
	const isChatStream =
		pathname === '/v1/chat/completions' &&
		response.headers.get('content-type')?.includes('text/event-stream');
	if (isChatStream) {
		await pipeline(source, new ChatStreamTransform(requestStartedAt), res);
		return;
	}
	if (pathname === '/v1/chat/completions') {
		const chunks = [];
		for await (const chunk of source) chunks.push(chunk);
		const data = Buffer.concat(chunks);
		try {
			const payload = normalizeReasoning(JSON.parse(data.toString('utf8')));
			if (payload.usage) {
				payload.timings = usageTimings(
					payload.usage,
					requestStartedAt,
					requestStartedAt,
					performance.now()
				);
			}
			res.end(JSON.stringify(payload));
		} catch {
			res.end(data);
		}
		return;
	}
	await pipeline(source, res);
}

function upstreamTarget(url) {
	return new URL(`${url.pathname}${url.search}`, backend.origin);
}

async function fetchModels(req) {
	const headers = upstreamHeaders(req);
	const response = await fetch(new URL('/v1/models', backend), { headers });
	if (!response.ok) {
		let detail = '';
		try {
			detail = await response.text();
		} catch {
			// Ignore an unreadable upstream error body.
		}
		const error = new Error(detail || `vLLM returned HTTP ${response.status}`);
		error.status = response.status;
		throw error;
	}
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
		supports_thinking: true,
		chat_template: '',
		bos_token: '',
		eos_token: '',
		build_info: 'standalone llama.cpp WebUI for vLLM',
		cors_proxy_enabled: false,
		ui_settings: {
			showMessageStats: true
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
		if (extname(relative)) {
			sendJson(res, 404, { error: 'Not found' });
			return;
		}
		file = resolve(root, 'index.html');
		stat = await fs.stat(file);
	}

	const type = mimeTypes.get(extname(file)) || 'application/octet-stream';
	const name = basename(file);
	const noCache =
		file === resolve(root, 'index.html') ||
		name === 'sw.js' ||
		name === 'version.json' ||
		name.endsWith('.webmanifest');
	res.writeHead(200, {
		'content-type': type,
		'content-length': stat.size,
		'cache-control': noCache ? 'no-cache' : 'public, max-age=3600',
		'cross-origin-opener-policy': 'same-origin',
		'cross-origin-resource-policy': 'same-origin',
		'permissions-policy': 'camera=(), geolocation=(), microphone=()',
		'x-frame-options': 'DENY',
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
			await proxy(req, res, url);
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
		if (res.headersSent || res.destroyed) return;
		const status = Number.isInteger(error.status) ? error.status : 502;
		sendJson(res, status, { error: error.message || 'Upstream request failed' });
	}
});

export { ChatStreamTransform, normalizeReasoning, sanitizeChatBody, upstreamTarget, usageTimings };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	server.listen(port, host, () => {
		console.log(`llama-ui listening on http://${host}:${port}`);
	});
}
