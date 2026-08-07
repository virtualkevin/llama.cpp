import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
	ChatStreamTransform,
	normalizeReasoning,
	sanitizeChatBody,
	upstreamTarget
} from '../../server.mjs';

const request = { headers: {} };

async function sanitize(input) {
	const body = await sanitizeChatBody(Buffer.from(JSON.stringify(input)), request);
	return JSON.parse(body.toString('utf8'));
}

describe('standalone vLLM adapter', () => {
	it('pins absolute-form request targets to the configured backend', () => {
		const target = upstreamTarget(new URL('http://attacker.invalid/v1/models?probe=1'));
		expect(target.origin).toBe(
			new URL(process.env.VLLM_BASE_URL || 'http://127.0.0.1:8000').origin
		);
		expect(target.pathname).toBe('/v1/models');
		expect(target.search).toBe('?probe=1');
	});

	it('enforces defaults and translates supported request fields', async () => {
		const output = await sanitize({
			model: 'test-model',
			messages: [{ role: 'user', content: 'hello' }],
			stream: true,
			repeat_penalty: 1.1,
			dynatemp_range: 0.2,
			tools: [{ type: 'function', function: { name: 'clock', parameters: {} } }],
			priority: 2
		});

		expect(output.max_tokens).toBe(4096);
		expect(output.repetition_penalty).toBe(1.1);
		expect(output.dynatemp_range).toBeUndefined();
		expect(output.tool_choice).toBe('auto');
		expect(output.priority).toBe(2);
		expect(output.stream_options).toEqual({
			include_usage: true,
			continuous_usage_stats: true
		});
	});

	it('rejects the removed pre-fill request', async () => {
		await expect(
			sanitize({
				model: 'test-model',
				messages: [{ role: 'user', content: 'hello' }],
				n_predict: 0
			})
		).rejects.toMatchObject({ status: 400 });
	});

	it('normalizes DeepSeek reasoning fields', () => {
		const payload = normalizeReasoning({
			choices: [{ delta: { reasoning: 'thinking' } }, { message: { reasoning: 'done' } }]
		});
		expect(payload.choices[0].delta).toEqual({ reasoning_content: 'thinking' });
		expect(payload.choices[1].message).toEqual({ reasoning_content: 'done' });
	});

	it('adds token timings to continuous usage chunks', async () => {
		const transform = new ChatStreamTransform(performance.now() - 100);
		let output = '';
		transform.on('data', (chunk) => {
			output += chunk.toString('utf8');
		});
		transform.end(
			'data: {"choices":[{"delta":{"reasoning":"thinking"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'
		);
		await once(transform, 'finish');

		const payload = JSON.parse(output.split('\n')[0].slice(5));
		expect(payload.choices[0].delta.reasoning_content).toBe('thinking');
		expect(payload.timings.prompt_n).toBe(10);
		expect(payload.timings.predicted_n).toBe(2);
		expect(payload.timings.predicted_ms).toBeGreaterThan(0);
	});
});
