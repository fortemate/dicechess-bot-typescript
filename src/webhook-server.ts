#!/usr/bin/env node
/** Standalone Node HTTP adapter for the shared webhook runtime. */

import { createServer } from 'node:http';
import { createNodeListener } from '@fortemate/dicechess-bot-runtime/node';
import { configuredWebhookHandler } from './webhook.js';

const port = Number(process.env.PORT ?? '8080');
const listener = createNodeListener(configuredWebhookHandler());
const server = createServer((request, response) => void listener(request, response));

server.listen(port, () => console.info(`webhook handler listening on :${port}`));
