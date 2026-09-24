# Dice Chess Bot — TypeScript Starter

[![CI](https://github.com/fortemate/dicechess-bot-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/fortemate/dicechess-bot-typescript/actions/workflows/ci.yml)
[![Play Live](https://img.shields.io/badge/Play-Live-success)](https://fortemate.com/)
[![Leaderboard](https://img.shields.io/badge/Ladder-Leaderboard-1E90FF)](https://fortemate.com/leaderboard)
[![License: MIT](https://img.shields.io/badge/License-MIT-lightgrey)](./LICENSE)

A complete, **runnable** Dice Chess bot in TypeScript. The polling client uses
built-in `fetch`; webhooks use the published `@fortemate/dicechess-bot-runtime`.
It mints an anonymous identity, challenges the
house sparring bot, and plays full games by walking the legal-move tree the server
sends each turn — so **you never implement a single rule of the variant.**

MIT-licensed: copy it into a closed-source bot with no strings attached. Playing
over the wire imposes no obligation, and this starter links no engine.

## Quickstart

[**Use this template**](https://github.com/fortemate/dicechess-bot-typescript/generate) → clone your copy → run:

```bash
npm install
npm start
```

That's it. No signup — it mints an anonymous token and starts playing `house/greedy`
immediately:

```
minted anonymous identity bot:team:anon:typescript-starter-…
game 147ea30e: played g1h3 (v3)
```

Requires Node 22.23.3, 24.21.0, or 26.8.2 (or a newer patch release within those major versions).

## Make it yours

The only decision the bot makes is in **`chooseMove`** (`src/strategy.ts`) — the baseline
ignores the position entirely and walks a random root-to-leaf path of the legal-move tree.
Replace it with real evaluation and time management; everything else (auth, discovery, the
activity loop, retries) is transport you can leave alone. The poll bot and webhook
adapter both call this same function.

```ts
interface TurnContext {
  dfen: string;               // the position to move in (7th field = the pending dice pool)
  legalMoves: MoveTree;        // a prefix tree of UCI micro-moves; a leaf ({}) is a full turn
  activeSeat: 'White' | 'Black'; // your seat — always the seat to move
  clocks: { white: number; black: number } | null; // remaining ms per side; null on Unlimited
}

async function chooseMove(ctx: TurnContext): Promise<string[]> {
  // Return the move path you want to play, or [] for a forced pass. `async` because a real
  // strategy will likely await an engine or a model — every caller already awaits this.
}
```

## Going further

- **A durable identity** (survives restarts; the gateway to the ladder and webhooks):
  ```bash
  npm run claim-identity -- <team> <name>   # prints DICECHESS_TOKEN=…, shown once
  ```
- **Join the rating ladder** (passive — the server pairs you against other on-ladder bots and
  your rating appears on the public [leaderboard](https://fortemate.com/leaderboard) once
  it converges):
  ```bash
  DICECHESS_TOKEN=<token> npm run ladder:join
  ```
- **Environment overrides:** `DICECHESS_TOKEN`, `DICECHESS_BASE_URL`,
  `DICECHESS_OPPONENT` (`team/name`, default `house/greedy`), `DICECHESS_NAME`,
  `DICECHESS_POLL_SECONDS`.
- **Scripts:** `npm start` (run), `npm run typecheck`, `npm run build`, `npm test`.
- **[Play against it yourself](https://fortemate.com/)**
  from the public lobby, before joining the ladder — confirms it plays a legal game end to end.

## Serverless: webhook mode

Instead of polling, you can run as a **webhook**: the server POSTs when it's your turn,
and the HTTP response body is your move. `src/webhook.ts` configures the shared runtime's
signed verification and turn handler. The strategy remains `chooseMove`.

```bash
# Supply the active and/or pending key plus all seven runtime limits, then start:
DICECHESS_WEBHOOK_SECRET=<active-key> DICECHESS_WEBHOOK_LIMITS='<limits-json>' npm run webhook
```

`DICECHESS_WEBHOOK_LIMITS` is a JSON object with positive integer `timeoutMs`,
`maxBodyBytes`, `maxTreeNodes`, `maxTreeDepth`, `maxConcurrentRequests`,
`maxCacheEntries`, and `cacheTtlMs`. Choose limits appropriate to your deployment.
For an initial staged setup, set `DICECHESS_WEBHOOK_PENDING_KEY` to its candidate key
before activation. Once activated, set `DICECHESS_WEBHOOK_SECRET` to the active key;
keep a pending key only during a rotation. `DICECHESS_BASE_URL` controls fallback
legal-tree retrieval. See [the runtime protocol](https://github.com/fortemate/dicechess-bot-runtime-js/blob/main/docs/protocol.md).

The old `POST /bot/webhook` registration helper was removed: it uses an unsigned
nonce handshake that the shared runtime intentionally rejects. Use the owner's
staged webhook setup and signed verification v2 to activate a callback. This PR
does not register or deploy a bot.

### Azure Functions (ready-made adapter)

`src/functions/webhook.ts` adapts Azure Functions v4 requests to the same runtime.
**[See `AZURE.md`](./AZURE.md)** for setup requirements.

## What's inside

| File | Role |
| --- | --- |
| `src/bot.ts` | The runnable poll-only bot; picks moves via `chooseMove`. |
| `src/strategy.ts` | `TurnContext` + `chooseMove` — the one decision the bot makes. **Edit this** (shared by both modes). |
| `src/client.ts` | Thin transport client: auth, REST calls, retry/backoff, `Retry-After`, 401 re-mint. |
| `src/webhook-server.ts` | Node.js HTTP adapter for the shared runtime. |
| `src/functions/webhook.ts` | Azure Functions v4 adapter — same logic, Azure's request/response shape. See `AZURE.md`. |
| `src/webhook.ts` | Runtime configuration and strategy adapter; authenticated delivery lives in the published package. |
| `src/claim-identity.ts` · `src/join-ladder.ts` | Claim a durable identity, then opt into the rating ladder. |

## Connection modes

This starter uses **polling** — the simplest mode, ideal for a cron/serverless
function. For pure serverless register a **webhook** (the server POSTs your turns).
