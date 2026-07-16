# @synoi/sdk

One-line governance for any AI agent. Drops in front of a tool call; gates it through your SynOI tenant's risk policy with HITL approval where required. Works with any agent framework — there is no agent-specific surface.

## Install

```bash
npm install @synoi/sdk
```

## Use

```typescript
import { gate } from '@synoi/sdk'

const result = await gate(
  {
    tool_name:   'shell.exec',
    tool_input:  { command: 'rm -rf /tmp/test' },
    user_message: 'clean up the test artifacts',
  },
  () => myAgent.execTool(...)
)
```

- Policy says **allow** → your function runs, its return value comes back
- Policy says **deny** → `SynoiDeniedError` is thrown, with the matched rule
- Policy says **require_approval** → throws with operator-must-approve message (v2 will block + poll for the HITL resolution)

That's the entire API.

## Decorator pattern

```typescript
import { wrap } from '@synoi/sdk'

const safeRm = wrap('shell.exec', async (input: { command: string }) => {
  return await myShell.run(input.command)
})

// Now every call goes through SynOI:
await safeRm({ command: 'rm -rf /tmp' })   // throws if policy denies
```

## Config

Env vars (or override in the `gate(..., cfg)` arg):

| Var | Default | Purpose |
|---|---|---|
| `SYNOI_LICENSE_KEY` | — | Your SynOI license. Sent as Bearer. |
| `SYNOI_GATEWAY_URL` | `https://gateway.synoi.systems` | Where the gateway lives |

```typescript
const result = await gate(ctx, exec, {
  gatewayUrl: 'https://gateway.synoi.systems',
  licenseKey: 'synoi-lk-...',
  mode:       'strict',   // 'permissive' (default) or 'strict'
})
```

## Failure modes

| Mode | Gateway down | License missing | Behavior |
|---|---|---|---|
| **permissive** (default) | warn + allow | warn + allow | Your agent never hangs because of SynOI infrastructure |
| **strict** | throws `SynoiGatewayError` | throws `SynoiGatewayError` | Fail-closed for compliance-critical deployments |

## What gets recorded

Every call (allow / deny / approval) generates a signed Decision Receipt at the gateway. View it at:

```
https://gateway.synoi.systems/verify/<receipt_id>
```

— signature is Ed25519, public-verifiable, embeddable in audit reports.

## Decide-only API

If you want the verdict but don't want the SDK to call your function, use `decide`:

```typescript
import { decide } from '@synoi/sdk'

const { action, matched_rule, reason } = await decide(ctx)
switch (action) {
  case 'allow':            await runTool(); break
  case 'deny':             showDenial(reason); break
  case 'require_approval': showWaitingForOperator(); break
}
```

## Why this exists

The drop-in proxy (just change `OPENAI_BASE_URL`) handles caching, cost, audit on **LLM calls**. It can't see **tool calls** unless the agent runtime opts in. This SDK is that opt-in — one wrapper around your tool dispatcher, and now every tool action is governed.

For OpenClaw specifically, you can use `@synoi/openclaw-guard` which wires the same SDK into OpenClaw's `before_tool_call` hook. For any other agent, use `@synoi/sdk` directly.
