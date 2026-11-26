# Error codes

TierGate adds a code such as `[🦚 TierGate M100]` to every error it produces itself. Errors from a provider carry no code. Text in `{braces}` is filled in with your values.

## M001

**Missing Authorization header**

> Missing the Authorization header. Set it to `Bearer mnfst_<your-key>`.

## M002

**Empty Bearer token**

> The Bearer token is empty. Paste your TierGate key into it.

## M003

**Invalid key format**

> That doesn't look right. TierGate keys start with "mnfst_". Grab yours from the dashboard.

## M004

**Key expired**

> This key has expired. Generate a new one here

## M005

**Key not recognized**

> I don't recognize this key. It might have been rotated or deleted. Grab the current one from the dashboard.

## M100

**Provider API key missing**

> No {provider} API key yet. Add one here: {dashboardUrl}

## M101

**No model to route to**

> This harness has no model to route to yet. Pick a default model here: {dashboardUrl}

## M102

**Provider subscription credentials unusable**

> {provider} subscription credentials could not be refreshed. Reconnect OAuth here: {dashboardUrl}

## M200

**Usage limit exceeded**

> You hit your {metric} limit: {used} used, {threshold}/{period} allowed. Adjust it here: {dashboardUrl}

## M201

**Per-user rate limit exceeded**

> Too many requests — wait a few seconds and retry.

## M202

**Per-IP rate limit exceeded**

> Too many requests from this IP — wait a few seconds and retry.

## M203

**Concurrency limit exceeded**

> Too many concurrent requests. Give it a moment.

## M204

**Subscription required**

> TierGate Cloud needs a Pro subscription to route requests. Subscribe here: {upgradeUrl}

## M300

**Missing messages array**

> `messages` array is required.

## M302

**Model not available**

> Model "{model}" is not available for this agent. Use GET /v1/models to list available model IDs, or make the provider available for this agent here: {dashboardUrl}

## M303

**Local provider unavailable on TierGate Cloud**

> Built-in local providers are only available in self-hosted TierGate. On TierGate Cloud, expose the runtime through a public URL or tunnel and connect it as a custom provider.

## M500

**Internal server error**

> Something broke on our end. Try again in a moment.
