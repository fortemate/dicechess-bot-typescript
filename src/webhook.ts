/** Connect the shared authenticated webhook runtime to this starter's move strategy. */

import { createWebhookHandler, type TurnContext as RuntimeTurnContext, type WebhookHandlerOptions } from '@fortemate/dicechess-bot-runtime';
import { DEFAULT_BASE_URL, USER_AGENT } from './client.js';
import { chooseMove, type TurnContext } from './strategy.js';

type TransportOptions = Omit<WebhookHandlerOptions, 'strategy'>;

/** Translate the runtime's seat-relative clock into the starter's two-sided view. */
export function toStrategyContext(context: RuntimeTurnContext): TurnContext {
	if (context.legalMoves === null) throw new Error('Legal moves are unavailable');
	let clocks: TurnContext['clocks'] = null;
	if (context.clock !== null) {
		clocks = context.seat === 'White'
			? { white: context.clock.remainingMillis, black: context.clock.opponentRemainingMillis }
			: { white: context.clock.opponentRemainingMillis, black: context.clock.remainingMillis };
	}
	return { dfen: context.dfen, legalMoves: context.legalMoves, activeSeat: context.seat, clocks };
}

/** Keep the same chooseMove decision used by the polling bot. */
export function createBotWebhookHandler(options: TransportOptions): (request: Request) => Promise<Response> {
	return createWebhookHandler({
		...options,
		strategy: {
			async onTurn(context) {
				return { moves: await chooseMove(toStrategyContext(context)) };
			},
		},
	});
}

let cached: { configuration: string; handler: (request: Request) => Promise<Response> } | undefined;

/** Read configuration at call time so Azure App Setting rotation creates a fresh handler. */
export function configuredWebhookHandler(): (request: Request) => Promise<Response> {
	const active = process.env.DICECHESS_WEBHOOK_SECRET;
	const pending = process.env.DICECHESS_WEBHOOK_PENDING_KEY;
	const limitsText = process.env.DICECHESS_WEBHOOK_LIMITS;
	const baseUrl = process.env.DICECHESS_BASE_URL ?? DEFAULT_BASE_URL;
	if ((!active && !pending) || !limitsText) throw new Error('Webhook keys and DICECHESS_WEBHOOK_LIMITS must be configured');
	const configuration = JSON.stringify({ active, pending, limitsText, baseUrl });
	if (cached?.configuration === configuration) return cached.handler;
	const handler = createBotWebhookHandler({
		keys: { active, pending },
		limits: JSON.parse(limitsText) as WebhookHandlerOptions['limits'],
		playApiBaseUrl: baseUrl,
		fetch: (input, init) => fetch(input, { ...init, headers: { 'User-Agent': USER_AGENT } }),
	});
	cached = { configuration, handler };
	return handler;
}
