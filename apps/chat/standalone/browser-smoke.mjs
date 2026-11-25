// Run against the built dist. The browser profile, ports, backend and conversation are disposable.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { standalone } from './adapter.mjs';

const sent = [];
const fake = createServer(async (req, res) => {
	if (req.url === '/v1/models') {
		res.setHeader('Content-Type', 'application/json');
		return res.end(
			JSON.stringify({ object: 'list', data: [{ id: 'demo-model', object: 'model' }] })
		);
	}
	if (req.url !== '/v1/chat/completions') {
		res.writeHead(404);
		return res.end();
	}
	let data = '';
	for await (const chunk of req) data += chunk;
	const b = JSON.parse(data);
	sent.push(b);
	if (!b.stream) {
		res.setHeader('Content-Type', 'application/json');
		return res.end(
			JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Title' } }] })
		);
	}
	res.writeHead(200, { 'Content-Type': 'text/event-stream' });
	const chunk = (delta, finish_reason = null) =>
		res.write(
			'data: ' +
				JSON.stringify({
					id: 'demo',
					model: 'demo-model',
					choices: [{ index: 0, delta, finish_reason }]
				}) +
				'\n\n'
		);
	chunk({ role: 'assistant', reasoning: 'draft reasoning' });
	await new Promise((r) => setTimeout(r, 100));
	chunk({ content: 'A fresh lemon.' });
	chunk({}, 'stop');
	res.end(
		'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8}}\n\ndata: [DONE]\n\n'
	);
});
const listen = async (s) => {
	s.listen(0, '127.0.0.1');
	await once(s, 'listening');
	return 'http://127.0.0.1:' + s.address().port;
};
const app = standalone({
	VLLM_BACKENDS: JSON.stringify([
		{
			url: await listen(fake),
			vision: true,
			video: true,
			reasoning: { efforts: ['off', 'low', 'high', 'max'], default: 'high' }
		}
	])
});
const origin = await listen(app);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage(),
	errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
	await page.goto(origin);
	await page
		.getByRole('button', { name: 'Reasoning effort', exact: true })
		.first()
		.click({ timeout: 15000 });
	assert.equal(await page.getByText('Extra High', { exact: true }).count(), 0);
	await page.getByText('Low', { exact: true }).first().click();
	const editor = page.locator('.cm-content:visible').last();
	await editor.fill('Name one citrus fruit');
	await editor.press('Enter');
	await page.getByText('A fresh lemon.', { exact: true }).first().waitFor();
	assert.equal(sent.find((b) => b.stream).reasoning_effort, 'low');
	await page.reload();
	await page.getByText('A fresh lemon.', { exact: true }).first().waitFor();
	await page.getByText('A fresh lemon.', { exact: true }).first().click({ button: 'right' });
	await page.getByText('Edit', { exact: true }).last().click();
	const reasoning = page.getByRole('textbox', { name: 'Reasoning', exact: true });
	assert.equal(await reasoning.inputValue(), 'draft reasoning');
	await reasoning.fill('Corrected reasoning');
	const answer = page.locator('.cm-content:visible').filter({ hasText: 'A fresh lemon.' }).first();
	await answer.fill('A fresh lime.');
	await page.keyboard.press('Enter');
	await page.getByText('A fresh lime.', { exact: true }).first().waitFor();
	await page.reload();
	await page.getByText('A fresh lime.', { exact: true }).first().waitFor();
	const stored = await page.evaluate(
		() =>
			new Promise((resolve) => {
				const open = indexedDB.open('LlamaUi');
				open.onsuccess = () => {
					const db = open.result,
						q = db.transaction('messages').objectStore('messages').getAll();
					q.onsuccess = () => {
						db.close();
						resolve(q.result.find((m) => m.content === 'A fresh lime.')?.reasoningContent);
					};
				};
			})
	);
	assert.equal(stored, 'Corrected reasoning');
	assert.equal(
		(await page.evaluate(() => indexedDB.databases())).some((x) => x.name === 'LlamaUi'),
		true
	);
	assert.deepEqual(errors, []);
	console.log(
		'Browser passed: model-specific effort, send/stream, edit reasoning and answer separately, IndexedDB and reload.'
	);
} catch (e) {
	console.error(
		'Page errors:',
		errors,
		'Page text:',
		(await page.locator('body').innerText()).slice(-2400)
	);
	throw e;
} finally {
	await browser.close();
	app.close();
	fake.close();
}
