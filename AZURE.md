# Deploying to Azure Functions

Azure invokes `src/functions/webhook.ts` for signed Dice Chess webhook deliveries.
It adapts the request to `@fortemate/dicechess-bot-runtime`; the existing
`chooseMove` strategy selects the response. No server or timer is needed.

The end state: a bot that opts into the rating ladder,
gets automatically paired against other on-ladder bots, and shows up on the public
[leaderboard](https://fortemate.com/leaderboard) once its rating converges (usually a
few dozen games) — with no server of your own to operate in the meantime.

## Prerequisites

- An Azure subscription.
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az`), logged in (`az login`).
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local) (`func`).
- A supported Node release locally: 22.23.3+, 24.21.0+, or 26.8.2+ within that major.
- A registered bot identity and access to its owner-managed staged webhook setup.
- An active or pending webhook key and a JSON object of explicit runtime limits.

:::note[Dormant or brand-new subscription?]
If `az storage account create` (or any resource creation) fails with
`(SubscriptionNotFound) Subscription ... was not found` even though `az account show` sees it
fine, the actual cause is usually a **resource provider that has never been registered** on that
subscription (`Microsoft.Storage`, `Microsoft.Web`, etc.) — a confusing error message for what
Azure means as "this provider isn't turned on here yet." Long-dormant or freshly-created
subscriptions often haven't lazily registered every provider. Fix: `az provider register
--namespace Microsoft.Storage` (swap in whichever namespace the error names), then poll
`az provider show --namespace Microsoft.Storage --query registrationState -o tsv` until it says
`Registered` (usually under two minutes) before retrying.
:::

## 1. Create the Azure resources (one-time)

Pick a globally-unique Function App name (it becomes part of your hostname) and a storage
account name (lowercase alphanumeric only, 3–24 chars, also globally unique):

```bash
RG=dicechess-bot-rg
LOCATION=eastus
STORAGE=dicechessbotsa$RANDOM      # must be globally unique
APP=dicechess-bot-$RANDOM          # must be globally unique

az group create --name "$RG" --location "$LOCATION"

az storage account create \
  --name "$STORAGE" --location "$LOCATION" \
  --resource-group "$RG" --sku Standard_LRS

az functionapp create \
  --resource-group "$RG" \
  --consumption-plan-location "$LOCATION" \
  --runtime node --runtime-version 22 --functions-version 4 \
  --name "$APP" --storage-account "$STORAGE" --os-type Linux
```

Node **22**, not 24: 24 is what `az`/`func` themselves suggest once 20 shows as end-of-life, but
in practice it left the app's SCM/Kudu companion site permanently `503`-ing (`Deployment
completed successfully`, then every "Syncing triggers" attempt failing, and even
`az functionapp function list` erroring) on Linux Consumption — a platform-immaturity issue for
such a new runtime, not anything about the code. Deleting the app and recreating with 22 fixed it
outright (SCM came up healthy on the very first check). If a future runtime version does the same
thing, this is the diagnostic path: `az functionapp log deployment show` to surface the Kudu URL,
then `curl` it directly — `503` means the platform, not you.

Your function's eventual URL: `https://$APP.azurewebsites.net/api/webhook`.

## 2. Deploy the code

From the repo root. Core Tools zips up whatever is on disk right now (honouring
`.funcignore`, which excludes the TypeScript sources) — **build first**, or you deploy an
empty package and "Syncing triggers" fails with a generic `BadRequest` (Azure found zero
functions to register, because `dist/` didn't exist):

```bash
npm install
npm run build     # produces dist/ — skip this and the deploy silently has nothing to run
func azure functionapp publish "$APP" --typescript
```

`--typescript` may be required even here: Core Tools' own language auto-detection can fail
to find a marker (e.g. no `local.settings.json` yet) and refuse to publish with "Can't
determine project language from files" — passing the flag explicitly sidesteps that.

At this point the function endpoint exists but answers 503 until a key and
`DICECHESS_WEBHOOK_LIMITS` are configured. It does not echo unsigned verification
nonces. An endpoint returning 503 is not ready for activation.

## 3. Claim a durable bot identity

Webhooks and the ladder both need a **registered** (not anonymous) identity:

```bash
npm run claim-identity -- <your-team> <your-bot-name>
#  → claimed bot:team:<your-team>:<your-bot-name>
#  → DICECHESS_TOKEN=<token>              ← save this, shown once
```

## 4. Stage and activate the webhook

Use the bot owner's staged webhook setup to create a candidate callback at
`https://$APP.azurewebsites.net/api/webhook` and obtain its pending key. The older
`POST /bot/webhook` helper used an unsigned nonce handshake and cannot activate
this runtime; `npm run register` is intentionally unavailable.

Before activating, set the candidate key and resource limits as Azure App Settings:

```bash
az functionapp config appsettings set \
  --name "$APP" --resource-group "$RG" \
  --settings DICECHESS_WEBHOOK_PENDING_KEY=<pending-key> \
             DICECHESS_WEBHOOK_LIMITS='<limits-json>'
```

The limits JSON must contain positive integer `timeoutMs`, `maxBodyBytes`,
`maxTreeNodes`, `maxTreeDepth`, `maxConcurrentRequests`, `maxCacheEntries`, and
`cacheTtlMs`. Select deployment-specific values and confirm the app has restarted.
Then use the owner setup to activate the callback. The server sends a signed
verification v2 envelope; the runtime returns a proof bound to its exact bytes.
After activation, set `DICECHESS_WEBHOOK_SECRET` to the active key. During a key
rotation, retain the old active key alongside the new pending key until activation
is complete, then remove the obsolete key. Do not log either key.

The staged owner setup requires owner authentication. A registered bot API token
alone does not perform that setup. This guide does not run an activation or deploy.

## 6. Join the ladder

```bash
DICECHESS_TOKEN=<token-from-step-3> npm run ladder:join
#  → onLadder=true glickoRating=1500 glickoRd=350
```

That's it — passive from here. The scheduler pairs your bot against other on-ladder bots on
its own schedule (Fischer 300+3 time control); your webhook answers the turns. Watch progress
on your bot's profile (`https://fortemate.com/bots/<team>/<name>`, marked `provisional`
until the rating converges) and then on the public
[leaderboard](https://fortemate.com/leaderboard).

## Operational notes

- **Cold starts.** On the Consumption plan, a function that hasn't been invoked recently takes
  a few seconds to wake up — typically 1–4 s for a bundle this small. That is normally fine:
  the server waits `min(its configured cap — usually ~15 s, your remaining clock)` for the
  answer, so a cold start well inside that window just costs those seconds of clock, and the
  Fischer increment credits time back on every completed turn. During a game the function stays
  warm (one delivery per turn), so expect roughly one cold start per game, on the first move.
  The case to watch is an answer that blows past the window entirely: delivery is
  **single-attempt** — the same roll is never redelivered — so that game will eventually be
  lost on time, exactly like a polling bot that stopped polling. If the logs ever show that,
  add a keep-warm ping or move to a Premium plan with an Always Ready instance.
- **Logs.** `az functionapp log tail --name "$APP" --resource-group "$RG"` or the "Live Metrics" /
  "Log stream" panel in the Azure Portal.
- **Redeploying.** Just re-run `func azure functionapp publish "$APP"` after code changes —
  the registered webhook URL doesn't change, so nothing needs re-registering.
- **Removing.** `az group delete --name "$RG"` tears down everything created in step 1. Leave
  the ladder first (`POST /bot/ladder/leave`) if you want your rating frozen rather than the
  identity simply going quiet.
