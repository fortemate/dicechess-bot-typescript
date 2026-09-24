import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createNodeListener } from '@fortemate/dicechess-bot-runtime/node';
import type { HttpRequest } from '@azure/functions';
import { createBotWebhookHandler, toStrategyContext } from './webhook.js';
import { handleAzureWebhook } from './functions/webhook.js';

const active = 'synthetic-active-key';
const pending = 'synthetic-pending-key';
const timestamp = 1756728000;
const limits = {
	timeoutMs: 1000,
	maxBodyBytes: 65536,
	maxTreeNodes: 100,
	maxTreeDepth: 8,
	maxConcurrentRequests: 4,
	maxCacheEntries: 8,
	cacheTtlMs: 1000,
};
const sign = (key: string, raw: string) => createHmac('sha256', key).update(`${timestamp}.${raw}`).digest('hex');
const delivery = (raw: string, key = active) => new Request('https://bot.invalid/webhook', {
	method: 'POST',
	headers: { 'x-dicechess-timestamp': String(timestamp), 'x-dicechess-signature': sign(key, raw) },
	body: raw,
});
const handler = () => createBotWebhookHandler({ keys: { active, pending }, limits, now: () => timestamp * 1000 });
const turn = (legalMoves: Record<string, unknown>, seat: 'White' | 'Black' = 'White') => JSON.stringify({
	type: 'yourTurn',
	gameId: 'synthetic-game',
	seat,
	state: {
		version: 7,
		dfen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1 P',
		activeSeat: seat,
		dicePending: true,
		clocks: null,
		legalMoves,
	},
});

test('signed turn uses the existing random strategy and returns a complete legal path', async () => {
	const tree = { e2e4: { g1f3: {}, b1c3: {} }, d2d4: { d4d5: {} } };
	const result = await handler()(delivery(turn(tree)));
	assert.equal(result.status, 200);
	const { moves } = await result.json() as { moves: string[] };
	let node: Record<string, unknown> = tree;
	for (const move of moves) {
		assert.ok(Object.hasOwn(node, move));
		node = node[move] as Record<string, unknown>;
	}
	assert.deepEqual(node, {});
});

test('bad signature and unsigned legacy registration cannot dispatch the strategy', async () => {
	const raw = turn({ e2e3: {} });
	const forged = new Request('https://bot.invalid/webhook', {
		method: 'POST',
		headers: { 'x-dicechess-timestamp': String(timestamp), 'x-dicechess-signature': '0'.repeat(64) },
		body: raw,
	});
	const runtime = handler();
	assert.equal((await runtime(forged)).status, 401);
	const legacy = await runtime(new Request('https://bot.invalid/webhook', {
		method: 'POST', body: JSON.stringify({ type: 'verification', nonce: 'legacy' }),
	}));
	assert.equal(legacy.status, 401);
});

test('pending key completes signed verification v2 and active key cannot impersonate it', async () => {
	const nonce = Buffer.alloc(16, 1).toString('base64url');
	const raw = JSON.stringify({ type: 'verification', version: 2, bot: { team: 'demo', name: 'starter' }, setupId: 'whs_test', revision: 'whrev_test', nonce });
	const result = await handler()(delivery(raw, pending));
	assert.equal(result.status, 200);
	assert.deepEqual(await result.json(), {
		nonce,
		proof: createHmac('sha256', pending).update(`dicechess-webhook-activate-v2\n${raw}`).digest('hex'),
	});
	assert.equal((await handler()(delivery(raw, active))).status, 401);
});

test('runtime context maps seat-relative clock to the polling strategy shape', () => {
	const legalMoves = { e7e6: {} };
	assert.deepEqual(toStrategyContext({
		gameId: 'g1', seat: 'Black', version: 7, dfen: 'synthetic dfen',
		legalMoves, mayOfferDraw: false,
		clock: { remainingMillis: 23000, opponentRemainingMillis: 12000, incrementMillis: 2000 },
	}), { dfen: 'synthetic dfen', legalMoves, activeSeat: 'Black', clocks: { white: 12000, black: 23000 } });
});

test('Node HTTP adapter preserves signed request bytes and runtime response', async () => {
	const server = createServer((request, response) => void createNodeListener(handler())(request, response));
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	try {
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const raw = turn({ e2e3: {} });
		const response = await fetch(`http://127.0.0.1:${address.port}/webhook`, {
			method: 'POST',
			headers: { 'x-dicechess-timestamp': String(timestamp), 'x-dicechess-signature': sign(active, raw) },
			body: raw,
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { moves: ['e2e3'] });
	} finally {
		server.close();
		await once(server, 'close');
	}
});

test('Azure adapter preserves signed request bytes and returns the runtime response', async () => {
	const previousSecret = process.env.DICECHESS_WEBHOOK_SECRET;
	const previousLimits = process.env.DICECHESS_WEBHOOK_LIMITS;
	try {
		process.env.DICECHESS_WEBHOOK_SECRET = active;
		process.env.DICECHESS_WEBHOOK_LIMITS = JSON.stringify(limits);
		const raw = turn({ e2e3: {} });
		const currentStamp = String(Math.floor(Date.now() / 1000));
		const request = {
			url: 'https://bot.invalid/api/webhook', method: 'POST',
			headers: new Headers({ 'x-dicechess-timestamp': currentStamp,
				'x-dicechess-signature': createHmac('sha256', active)
					.update(`${currentStamp}.${raw}`).digest('hex') }),
			body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(raw)); controller.close(); } }),
		} as unknown as HttpRequest;
		const result = await handleAzureWebhook(request, { warn: () => {} });
		assert.equal(result.status, 200);
		assert.deepEqual(JSON.parse(result.body as string), { moves: ['e2e3'] });
	} finally {
		if (previousSecret === undefined) delete process.env.DICECHESS_WEBHOOK_SECRET;
		else process.env.DICECHESS_WEBHOOK_SECRET = previousSecret;
		if (previousLimits === undefined) delete process.env.DICECHESS_WEBHOOK_LIMITS;
		else process.env.DICECHESS_WEBHOOK_LIMITS = previousLimits;
	}
});

test('Azure adapter applies the runtime body limit while streaming', async () => {
	const previousSecret = process.env.DICECHESS_WEBHOOK_SECRET;
	const previousLimits = process.env.DICECHESS_WEBHOOK_LIMITS;
	try {
		process.env.DICECHESS_WEBHOOK_SECRET = active;
		process.env.DICECHESS_WEBHOOK_LIMITS = JSON.stringify({ ...limits, maxBodyBytes: 10 });
		const raw = turn({ e2e3: {} });
		const currentStamp = String(Math.floor(Date.now() / 1000));
		const request = {
			url: 'https://bot.invalid/api/webhook', method: 'POST',
			headers: new Headers({ 'x-dicechess-timestamp': currentStamp,
				'x-dicechess-signature': createHmac('sha256', active).update(`${currentStamp}.${raw}`).digest('hex') }),
			body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(raw)); controller.close(); } }),
		} as unknown as HttpRequest;
		const result = await handleAzureWebhook(request, { warn: () => {} });
		assert.equal(result.status, 413);
	} finally {
		if (previousSecret === undefined) delete process.env.DICECHESS_WEBHOOK_SECRET;
		else process.env.DICECHESS_WEBHOOK_SECRET = previousSecret;
		if (previousLimits === undefined) delete process.env.DICECHESS_WEBHOOK_LIMITS;
		else process.env.DICECHESS_WEBHOOK_LIMITS = previousLimits;
	}
});
