// The static app and its IndexedDB are upstream's. This module only translates the wire protocol.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createChatServer } from '../cli/server.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const nativeOnly =
	'return_progress sse_ping_interval reasoning_format reasoning_control thinking_budget_tokens timings_per_token backend_sampling samplers typ_p dynatemp_range dynatemp_exponent xtc_probability xtc_threshold repeat_last_n dry_multiplier dry_base dry_allowed_length dry_penalty_last_n'.split(
		' '
	);
const bool = (x) => x === true || /^(1|true|yes|on)$/i.test(x);

export function configuration(env) {
	const entries = env.VLLM_BACKENDS
		? JSON.parse(env.VLLM_BACKENDS)
		: [
				{
					url: env.VLLM_BASE_URL || 'http://127.0.0.1:8000',
					vision: env.VLLM_VISION_ENABLED,
					video: env.VLLM_VIDEO_ENABLED
				}
			];
	if (!Array.isArray(entries) || !entries.length) throw Error('No backends configured');
	return entries.map(({ url, vision, video, reasoning }) => {
		const origin = new URL(url);
		if (!['http:', 'https:'].includes(origin.protocol)) throw Error('Invalid backend protocol');
		if (
			reasoning &&
			(!Array.isArray(reasoning.efforts) ||
				!reasoning.efforts.length ||
				reasoning.efforts.some(
					(e) => !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(e)
				) ||
				(reasoning.default !== undefined && !reasoning.efforts.includes(reasoning.default)))
		)
			throw Error('Invalid reasoning capabilities');
		return { origin, vision: bool(vision), video: bool(video), reasoning };
	});
}

export function completion(input, model, config, limit) {
	if (!input || !Array.isArray(input.messages) || 'n_predict' in input)
		throw fail(400, 'Expected a chat request');
	const body = { ...input, model };
	for (const key of nativeOnly) delete body[key];
	if (body.repeat_penalty !== undefined) body.repetition_penalty ??= body.repeat_penalty;
	delete body.repeat_penalty;
	if (body.max_completion_tokens > 0) delete body.max_tokens;
	else if (!(body.max_tokens > 0)) body.max_tokens = limit;
	const effort =
		body.chat_template_kwargs?.enable_thinking === false ? 'off' : body.reasoning_effort;
	if (effort) {
		const value = effort === 'none' ? 'off' : effort;
		if (config.reasoning && !config.reasoning.efforts.includes(value))
			throw fail(400, 'Unsupported model reasoning effort');
		body.reasoning_effort = value === 'off' ? 'none' : value;
	}
	body.messages = body.messages.map((m) =>
		!Array.isArray(m.content)
			? m
			: {
					...m,
					content: m.content.map((p) => {
						if (p.type !== 'input_video') return p;
						const data = p.input_video?.data;
						if (typeof data !== 'string' || !data.length) throw fail(400, 'Missing video data');
						return {
							type: 'video_url',
							video_url: {
								url: data.startsWith('data:')
									? data
									: 'data:video/' +
										(p.input_video.format === 'ogg' ? 'ogg' : 'mp4') +
										';base64,' +
										data
							}
						};
					})
				}
	);
	if (body.tools?.length) body.tool_choice ??= 'auto';
	if (body.stream)
		body.stream_options = {
			...body.stream_options,
			include_usage: true,
			continuous_usage_stats: true
		};
	return body;
}

function translator(start, streaming) {
	let first;
	return (packet) => {
		for (const choice of packet.choices ?? []) {
			const part = choice.delta ?? choice.message;
			if (!part) continue;
			if (part.reasoning != null) {
				part.reasoning_content ??= part.reasoning;
				delete part.reasoning;
			}
			if (streaming && (part.content || part.reasoning_content || part.tool_calls?.length))
				first ??= performance.now();
		}
		const u = packet.usage;
		if (u && !packet.timings) {
			const now = performance.now(),
				cached = u.prompt_tokens_details?.cached_tokens ?? 0;
			packet.timings = {
				prompt_n: Math.max(0, (u.prompt_tokens ?? 0) - cached),
				cache_n: cached,
				prompt_ms: first ? first - start : 0,
				predicted_n: u.completion_tokens ?? 0,
				predicted_ms: first ? now - first : 0
			};
		}
		return packet;
	};
}

export async function* events(source, translate) {
	let pending = '';
	const decoder = new TextDecoder();
	function line(s) {
		if (!s.startsWith('data:')) return s;
		const value = s.slice(5).trim();
		if (!value || value === '[DONE]') return s;
		return 'data: ' + JSON.stringify(translate(JSON.parse(value)));
	}
	for await (const bytes of source) {
		pending += decoder.decode(bytes, { stream: true });
		const lines = pending.split('\n');
		pending = lines.pop();
		for (const s of lines) yield line(s) + '\n';
	}
	pending += decoder.decode();
	if (pending) yield line(pending);
}

async function jsonBody(req) {
	const chunks = [];
	let n = 0;
	for await (const data of req) {
		n += data.length;
		if (n > 128 * 1024 * 1024) throw fail(413, 'Body too large');
		chunks.push(data);
	}
	try {
		return JSON.parse(Buffer.concat(chunks));
	} catch {
		throw fail(400, 'Invalid JSON');
	}
}

export function standalone(env = process.env) {
	const backends = configuration(env),
		router = backends.length > 1,
		files = createChatServer();
	const limit = Number(env.DEFAULT_MAX_TOKENS || 4096);
	return createServer(async (req, res) => {
		const send = (status, value) => {
			res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			res.end(JSON.stringify(value));
		};
		const abort = new AbortController();
		res.once('close', () => {
			if (!res.writableFinished) abort.abort();
		});
		try {
			const u = new URL(req.url, 'http://localhost'),
				path = u.pathname;
			if (req.method === 'GET' && path === '/healthz') return send(200, { status: 'ok' });
			if (req.method === 'GET' && ['/tools', '/slots', '/v1/streams/lookup'].includes(path))
				return send(200, []);
			if (req.method === 'GET' && path === '/models/sse' && router) {
				res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
				res.write(': connected\n\n');
				const timer = setInterval(() => res.write(': alive\n\n'), 15000);
				res.once('close', () => clearInterval(timer));
				return;
			}
			const chat = path === '/v1/chat/completions' && req.method === 'POST';
			if (!chat && !(req.method === 'GET' && ['/props', '/v1/models'].includes(path))) {
				if (/^\/(v1|tools|models|slots|cors-proxy)(\/|$)/.test(path))
					return send(404, { error: 'Not available in standalone mode' });
				files.emit('request', req, res);
				return;
			}
			const headers = req.headers.authorization ? { authorization: req.headers.authorization } : {};
			const input = chat ? await jsonBody(req) : null;
			const requested = chat ? input?.model : u.searchParams.get('model');
			let config = backends[0],
				model = { id: requested };
			if (!chat || !requested || router) {
				const rows = (
					await Promise.all(
						backends.map(async (c) => {
							const r = await fetch(new URL('/v1/models', c.origin), {
								headers,
								signal: abort.signal,
								redirect: 'error'
							});
							if (!r.ok) throw fail(r.status, 'Could not list backend models');
							return (await r.json()).data.map((m) => ({ config: c, model: m }));
						})
					)
				).flat();
				if (path === '/v1/models')
					return send(200, {
						object: 'list',
						data: rows.map(({ config: c, model: m }) => ({
							...m,
							in_cache: true,
							status: { value: 'loaded', args: [] },
							path: m.root || m.id,
							architecture: {
								input_modalities: [
									'text',
									...(c.vision ? ['image'] : []),
									...(c.video ? ['video'] : [])
								]
							}
						}))
					});
				const selected = requested ? rows.find((x) => x.model.id === requested) : rows[0];
				if (!selected) throw fail(404, 'No matching served model');
				({ config, model } = selected);
			}
			if (!chat) {
				const globalRouter = router && !requested;
				return send(200, {
					role: router ? 'router' : 'model',
					model_path: globalRouter ? '' : model.id,
					model_alias: globalRouter ? '' : model.id,
					modalities: {
						vision: !globalRouter && config.vision,
						video: !globalRouter && config.video,
						audio: false
					},
					chat_template: '',
					standalone: {
						efforts: globalRouter ? [] : (config.reasoning?.efforts ?? ['off']),
						default: globalRouter ? null : config.reasoning?.default
					},
					chat_template_caps: {
						reasoning_effort_levels: (config.reasoning?.efforts ?? []).filter((e) => e !== 'off')
					},
					default_generation_settings: {
						n_ctx: model.max_model_len ?? 131072,
						params: { max_tokens: limit, stream: true }
					},
					total_slots: 1,
					bos_token: '',
					eos_token: '',
					build_info: 'Standalone Llama Chat',
					cors_proxy_enabled: false,
					ui_agent: bool(env.BROWSER_AGENT_ENABLED),
					ui_settings: { showMessageStats: true }
				});
			}
			const data = completion(input, model.id, config, limit),
				translate = translator(performance.now(), data.stream);
			const r = await fetch(new URL(path, config.origin), {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify(data),
				signal: abort.signal,
				redirect: 'error'
			});
			if (!r.ok) {
				res.writeHead(r.status, {
					'Content-Type': r.headers.get('content-type') ?? 'text/plain',
					'Cache-Control': 'no-store'
				});
				await pipeline(Readable.fromWeb(r.body), res);
				return;
			}
			if (!data.stream) return send(200, translate(await r.json()));
			res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
			await pipeline(events(r.body, translate), res);
		} catch (e) {
			if (res.destroyed) return;
			if (res.headersSent) res.destroy();
			else send(e.status ?? 502, { error: e.message });
		}
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	standalone().listen(Number(process.env.PORT || 3131), process.env.HOST || '0.0.0.0');
