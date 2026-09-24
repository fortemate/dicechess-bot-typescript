/** Azure Functions v4 adapter. Authentication and dispatch live in the shared runtime. */

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { configuredWebhookHandler } from '../webhook.js';

export async function handleAzureWebhook(request: HttpRequest, context: Pick<InvocationContext, 'warn'>): Promise<HttpResponseInit> {
	try {
		// Preserve raw bytes for the runtime's HMAC check.
		const input = new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body: await request.arrayBuffer(),
		});
		const response = await configuredWebhookHandler()(input);
		return {
			status: response.status,
			body: await response.text(),
			headers: Object.fromEntries(response.headers),
		};
	} catch {
		context.warn('Webhook configuration or adapter failure');
		return { status: 503, jsonBody: { error: 'webhook_unavailable' } };
	}
}

app.http('webhook', {
	methods: ['POST'],
	authLevel: 'anonymous',
	handler: handleAzureWebhook,
});
