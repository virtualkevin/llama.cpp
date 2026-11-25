import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { standalone, configuration, completion, events } from './adapter.mjs';

export async function listen(s) {
	s.listen(0, '127.0.0.1');
	await once(s, 'listening');
	return 'http://127.0.0.1:' + s.address().port;
}
test('translation preserves provider extensions, tool choice, video and model-specific effort', () => {
	const [c] = configuration({
		VLLM_BACKENDS: '[{"url":"http://localhost","reasoning":{"efforts":["off","high"]}}]'
	});
	const input = {
		messages: [
			{
				role: 'user',
				content: [{ type: 'input_video', input_video: { format: 'mp4', data: 'QQ==' } }]
			}
		],
		tools: [{}],
		stream: true,
		reasoning_effort: 'high',
		priority: 2,
		repeat_penalty: 1.1,
		samplers: ['abc']
	};
	const b = completion(input, 'chosen', c, 4096);
	assert.equal(b.messages[0].content[0].video_url.url, 'data:video/mp4;base64,QQ==');
	assert.equal(b.max_tokens, 4096);
	assert.equal(b.priority, 2);
	assert.equal(b.samplers, undefined);
	assert.equal(b.tool_choice, 'auto');
	assert.equal(b.repetition_penalty, 1.1);
	assert.equal(b.stream_options.include_usage, true);
	assert.throws(
		() => completion({ ...input, reasoning_effort: 'xhigh' }, 'chosen', c, 4096),
		/Unsupported/
	);
	assert.equal(
		completion({ ...input, chat_template_kwargs: { enable_thinking: false } }, 'chosen', c, 4096)
			.reasoning_effort,
		'none'
	);
	assert.throws(() => completion({ ...input, n_predict: 0 }, 'chosen', c, 4096));
	assert.throws(() =>
		configuration({ VLLM_BACKENDS: '[{"url":"https://test","reasoning":{"efforts":["invalid"]}}]' })
	);
});
test('byte-split Unicode stream preserves framing and final usage event', async () => {
	const raw =
		'data: {"choices":[{"delta":{"content":"🍋"}}]}\r\n\r\ndata: {"choices":[],"usage":{"completion_tokens":1}}\n\ndata: [DONE]\n\n';
	const pieces = Array.from(Buffer.from(raw), (n) => Buffer.from([n]));
	let text = '';
	for await (const part of events(pieces, (x) => x)) text += part;
	assert.equal(text.replaceAll('\r', ''), raw.replaceAll('\r', ''));
});
test('fixed backend routing, scoped props, native timing preservation and closed management routes', async (t) => {
	const calls = [];
	const configs = await Promise.all(
		['qwen', 'deepseek'].map(async (id) => {
			const s = createServer(async (req, res) => {
				res.setHeader('Content-Type', 'application/json');
				if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id }] }));
				let body = '';
				for await (const buf of req) body += buf;
				calls.push([id, req.url, JSON.parse(body)]);
				res.end(
					JSON.stringify({
						choices: [{ message: { reasoning: 'thought', content: 'answer' } }],
						timings: { predicted_ms: 100 },
						usage: { completion_tokens: 5 }
					})
				);
			});
			t.after(() => s.close());
			return {
				url: await listen(s),
				vision: true,
				video: id === 'qwen',
				reasoning: { efforts: id === 'qwen' ? ['off', 'xhigh'] : ['off', 'high'] }
			};
		})
	);
	const app = standalone({ VLLM_BACKENDS: JSON.stringify(configs) });
	t.after(() => app.close());
	const base = await listen(app);
	assert.equal((await (await fetch(base + '/v1/models')).json()).data.length, 2);
	const props = await (await fetch(base + '/props?model=deepseek')).json();
	assert.deepEqual(props.standalone.efforts, ['off', 'high']);
	assert.equal(props.modalities.video, false);
	assert.equal((await fetch(base + '/props?model=unknown')).status, 404);
	for (const path of [
		'/v1/files',
		'/tools',
		'/models/unload',
		'/cors-proxy',
		'/v1/chat/completions/control'
	])
		assert.equal((await fetch(base + path, { method: 'POST' })).status, 404);
	const out = await (
		await fetch(base + '/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'deepseek', messages: [], reasoning_effort: 'high' })
		})
	).json();
	assert.equal(out.choices[0].message.reasoning_content, 'thought');
	assert.deepEqual(out.timings, { predicted_ms: 100 });
	assert.equal(calls.length, 1);
	assert.equal(calls[0][0], 'deepseek');
});
