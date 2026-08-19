/**
 * @synoi/sdk — one-line governance wrapper for any AI agent.
 *
 * Drop this in front of any "the agent is about to execute a tool" code path
 * and SynOI will:
 *   1. Validate your tenant's license against the control plane (cached)
 *   2. Evaluate the call against your tenant's risk policy
 *   3. If approval is required, dispatch HITL through configured surfaces and
 *      block until the operator approves/denies (or timeout)
 *   4. Sign + store a Decision Receipt (publicly verifiable at /verify/<id>)
 *
 * The full integration is one wrap:
 *
 *   import { gate } from '@synoi/sdk'
 *
 *   const result = await gate({
 *     tool_name:   'shell.exec',
 *     tool_input:  { command: 'rm -rf /tmp' },
 *     user_message: 'clean up the temp directory',
 *   }, () => realTool.exec(...))
 *
 * If the policy says allow -> realTool.exec runs and returns its result.
 * If deny -> throws SynoiDeniedError.
 * If require_approval -> suspends until HITL resolves; then runs or throws.
 *
 * LOCAL MODE (ADR_014 Section 9.3):
 * When { local: true } (or daemonUrl is set), gate() routes through the
 * local daemon at daemonUrl instead of the SaaS gateway. No license key
 * is required. The daemon must be running and reachable; if it is not,
 * gate() fails CLOSED regardless of the `mode` setting.
 *
 *   const result = await gate(ctx, exec, {
 *     local:         true,
 *     daemonUrl:     'http://127.0.0.1:7990',
 *     bundle_oid:    '<governed-action bundle OID>',
 *     principal_oid: '<operator session OID>',
 *   })
 *
 * The SaaS path (/v1/risk/*) is UNTOUCHED by this addition; existing callers
 * with no local config continue to work identically.
 *
 * No em dashes. No AI attribution.
 */

export type Verdict = 'allow' | 'deny' | 'require_approval'

export interface GateContext {
  /** Name of the tool the agent is about to call. Used by risk policy matchers. */
  tool_name:     string
  /** Inputs the agent prepared. Object shape is tool-specific; matchers walk
   *  dotted paths into it (e.g. `tool_input.command`). */
  tool_input:    Record<string, unknown>
  /** Optional: the last user message that triggered this tool call. Helps
   *  the operator decide context when an approval prompt fires. */
  user_message?: string
  /** Optional: model that drove the request, for the receipt. */
  model?:        string
  /** Optional: stable id for this invocation. Auto-generated if missing. */
  call_id?:      string
  /** Optional: session id for grouping receipts. */
  session_id?:   string
  /** Optional: GAP intent_oid correlating this call to the prompt/turn that
   *  caused it. Format `sha256:<64 hex>`. Threaded onto the receipt's
   *  authority block by the gateway; malformed values are rejected there. */
  intent_oid?:   string
}

export interface RiskDecision {
  action:        Verdict
  matched_rule?: { id?: string; note?: string }
  reason:        string
  /** Present when gate() called with waitForApproval and verdict is
   *  require_approval. The gateway has dispatched HITL; SDK is polling. */
  hitl_id?:      string
  tenant_id?:    string
}

export interface SynoiConfig {
  /** Where the gateway lives. Default: SYNOI_GATEWAY_URL env, else https://gateway.synoi.systems */
  gatewayUrl?:    string
  /** SynOI license key. Default: SYNOI_LICENSE_KEY env. Sent as Bearer. */
  licenseKey?:    string
  /** Failure mode when gateway is unreachable: `permissive` (fail-open) or
   *  `strict` (fail-closed). Default: strict. */
  mode?:          'permissive' | 'strict'
  /** When verdict is require_approval, instruct the gateway to dispatch HITL
   *  (mobile / desktop / SMS / etc.) and the SDK polls until resolution.
   *  Default: false (v1 behavior - throws immediately). When true, gate()
   *  blocks for up to `approvalTimeoutMs` waiting for an operator. */
  waitForApproval?: boolean
  /** Max time to wait for HITL resolution before treating as a denial.
   *  Default: 5 minutes. */
  approvalTimeoutMs?: number
  /** Override fetch for testing. */
  fetcher?:       typeof fetch
  /** Log handler (default: console.warn for warn/error levels). */
  log?:           (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void

  // ── Local-mode fields (ADR_014 Section 9.3) ──────────────────────────────
  // When local is true (or daemonUrl is set), gate() routes through the local
  // daemon instead of the SaaS gateway. No licenseKey is required. The daemon
  // must be reachable; if unreachable, gate() ALWAYS fails closed regardless
  // of the `mode` setting. The SaaS /v1/risk/* path is untouched.

  /** Enable local-daemon mode. Also implied when daemonUrl is set. */
  local?:         boolean
  /** URL of the local daemon. Default: SYNOI_DAEMON_URL env, else http://127.0.0.1:7990.
   *  Used only when local mode is active. */
  daemonUrl?:     string
  /** The governed-action bundle OID to submit with every local gate() call.
   *  Default: 'capbundle/1' (test-mode sentinel; use the real OID in production). */
  bundle_oid?:    string
  /** The operator session OID to declare as principal.
   *
   *  OPTIONAL (ADR_016 v1.1 ergonomics): when omitted, the daemon derives principal_oid
   *  from the single active enrolled operator. This is the correct default for v1
   *  single-operator deployments -- you do not need to set this.
   *
   *  When set, the daemon validates that it matches an active enrolled operator and
   *  rejects at gate() time (not silently at decide time) if it does not match.
   *
   *  D1 limitation note (ADR_014 Section 9.3): in the general multi-party case the
   *  receipt attests operator-APPROVAL, not principal PROVENANCE. This is the v1
   *  single-operator ergonomic guard; the limitation framing is unchanged. */
  principal_oid?: string
  /** Optional originating receipt OID to pass through to the daemon (ADR_014 Section 2 tuple). */
  originating_receipt_oid?: string
}

export class SynoiDeniedError extends Error {
  readonly receipt_id?: string
  readonly matched_rule?: { id?: string; note?: string }
  constructor(message: string, opts?: { receipt_id?: string; matched_rule?: { id?: string; note?: string } }) {
    super(message)
    this.name = 'SynoiDeniedError'
    this.receipt_id = opts?.receipt_id
    this.matched_rule = opts?.matched_rule
  }
}

export class SynoiGatewayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SynoiGatewayError'
  }
}

interface ResolvedConfig {
  gatewayUrl:        string
  licenseKey:        string
  mode:              'permissive' | 'strict'
  waitForApproval:   boolean
  approvalTimeoutMs: number
  fetcher:           typeof fetch
  log:               NonNullable<SynoiConfig['log']>
  // Local-mode resolved fields.
  isLocal:           boolean
  daemonUrl:         string
  bundle_oid:        string
  // null means "omit from body; let daemon derive" (ADR_016 v1.1).
  principal_oid:     string | null
  originating_receipt_oid: string | null
}

function resolveConfig(cfg: SynoiConfig = {}): ResolvedConfig {
  const isLocal = !!(cfg.local || cfg.daemonUrl)
  // principal_oid: explicit config wins; then env fallback; then null (omit from body,
  // daemon derives per ADR_016 v1.1). Never default to ZERO_OID -- that was the footgun.
  const principalOidRaw = cfg.principal_oid ?? process.env['SYNOI_PRINCIPAL_OID'] ?? null
  // Treat an explicitly-set empty string as omitted (same as null: let daemon derive).
  const principal_oid = (typeof principalOidRaw === 'string' && principalOidRaw.trim().length > 0)
    ? principalOidRaw.trim()
    : null
  return {
    gatewayUrl:        cfg.gatewayUrl        ?? process.env['SYNOI_GATEWAY_URL'] ?? 'https://gateway.synoi.systems',
    licenseKey:        cfg.licenseKey        ?? process.env['SYNOI_LICENSE_KEY'] ?? '',
    mode:              cfg.mode              ?? 'strict',   // fail-CLOSED by default; 'permissive' is opt-in
    waitForApproval:   cfg.waitForApproval   ?? false,
    approvalTimeoutMs: cfg.approvalTimeoutMs ?? 5 * 60_000,
    fetcher:           cfg.fetcher           ?? fetch,
    log:               cfg.log               ?? ((lvl, msg) => {
      if (lvl === 'warn' || lvl === 'error') console.warn(`[synoi-sdk] ${lvl}: ${msg}`)
    }),
    isLocal,
    daemonUrl:         cfg.daemonUrl ?? process.env['SYNOI_DAEMON_URL'] ?? 'http://127.0.0.1:7990',
    bundle_oid:        cfg.bundle_oid ?? 'capbundle/1',
    principal_oid,
    originating_receipt_oid: cfg.originating_receipt_oid ?? null,
  }
}

// ── Local-mode gate path (ADR_014 Section 9.3) ───────────────────────────────
//
// Status: DESIGN (ADR_014 Section 9.5). PARTIAL-against-test-keys.
// Production fetcher: PAPER (off this contract's path per Section 9.5).
// principal_oid provenance: accepted v1 limitation D1 (ADR_014 Section 9.4).
//
// This path is ADDITIVE: the SaaS /v1/risk/* path above is UNTOUCHED.

/** Long-poll window per iteration (mirrors the SaaS waitForApproval 30s cap). */
const LOCAL_POLL_WINDOW_MS = 30_000

interface LocalOutcomeResponse {
  pending_oid:  string
  status:       'pending' | 'allowed' | 'denied' | 'timeout'
  decision?:    'allow' | 'deny'
  receipt_oid?: string
  verify_url?:  string
}

/**
 * Internal: run gate() through the local daemon.
 *
 * Fail-closed contract (Section 9.3, load-bearing):
 *   - Daemon unreachable at submit or poll -> throw SynoiGatewayError. ALWAYS.
 *     Even in permissive mode. A down local governance daemon must not fail open.
 *   - denied or timeout -> throw SynoiDeniedError (do NOT run exec).
 *   - Budget elapsed while still pending -> throw SynoiDeniedError (fail closed).
 *   - gate() NEVER calls /local/decide (Section 9.4).
 */
async function gateLocal<T>(
  ctx:  GateContext,
  exec: () => Promise<T> | T,
  c:    ResolvedConfig,
): Promise<T> {
  const localHeaders = {
    'Content-Type':   'application/json',
    'X-SynOI-Local':  '1',
    // Deliberately NO Authorization header (Section 9.3: no license key in local mode).
  }

  // Step 1: POST /local/gate to submit the action.
  let submitResp: Response
  try {
    // Build the gate body. principal_oid is OMITTED when null so the daemon can
    // derive it from the single enrolled operator (ADR_016 v1.1 ergonomics).
    const gateBody: Record<string, unknown> = {
      bundle_oid:               c.bundle_oid,
      panel_id:                 'approval',   // hero bundle's form panel (Section 1.2)
      action_kind:              'command',    // Section 9.3: tool execution is "command"
      originating_receipt_oid:  c.originating_receipt_oid,
      // args carries the full tool context so the operator sees it in the approval form.
      args: {
        tool_name:    ctx.tool_name,
        tool_input:   ctx.tool_input,
        user_message: ctx.user_message,
        model:        ctx.model,
      },
    }
    // Include principal_oid only when explicitly set (null = omit = daemon derives).
    if (c.principal_oid !== null) {
      gateBody['principal_oid'] = c.principal_oid
    }
    submitResp = await c.fetcher(`${c.daemonUrl}/local/gate`, {
      method:  'POST',
      headers: localHeaders,
      body: JSON.stringify(gateBody),
    })
  } catch (err) {
    // Daemon unreachable: fail CLOSED regardless of mode (Section 9.3).
    throw new SynoiGatewayError(
      `synoi-sdk local: daemon unreachable at submit: ${(err as Error).message}`,
    )
  }

  // Non-2xx on submit: parse and fail closed.
  if (!submitResp.ok) {
    const text = await submitResp.text().catch(() => '')
    throw new SynoiGatewayError(
      `synoi-sdk local: POST /local/gate returned ${submitResp.status}: ${text.slice(0, 200)}`,
    )
  }

  const submitBody = await submitResp.json() as { pending_oid?: string }
  const pending_oid = submitBody.pending_oid
  if (!pending_oid || typeof pending_oid !== 'string') {
    throw new SynoiGatewayError('synoi-sdk local: POST /local/gate response missing pending_oid')
  }

  c.log('info', `synoi-sdk local: submitted ${ctx.tool_name}, pending_oid=${pending_oid}`)

  // Step 2: Long-poll GET /local/gate/:pending_oid until resolved or budget elapsed.
  // Mirrors the SaaS waitForApproval loop (Math.min(window, remaining), retry on pending).
  const start = Date.now()
  while (true) {
    const remaining = c.approvalTimeoutMs - (Date.now() - start)
    if (remaining <= 0) {
      // Budget elapsed: fail closed (Section 9.3).
      throw new SynoiDeniedError(
        `synoi-sdk local: approval budget elapsed for ${ctx.tool_name} (pending_oid=${pending_oid})`,
      )
    }
    const waitMs = Math.min(LOCAL_POLL_WINDOW_MS, remaining)

    let pollResp: Response
    try {
      pollResp = await c.fetcher(
        `${c.daemonUrl}/local/gate/${encodeURIComponent(pending_oid)}?wait_ms=${waitMs}`,
        { method: 'GET', headers: localHeaders },
      )
    } catch (err) {
      // Daemon unreachable during poll: fail CLOSED regardless of mode.
      throw new SynoiGatewayError(
        `synoi-sdk local: daemon unreachable at poll: ${(err as Error).message}`,
      )
    }

    // 408: server-side long-poll window elapsed; re-issue (mirrors SaaS path line 196).
    if (pollResp.status === 408) continue

    if (!pollResp.ok) {
      const text = await pollResp.text().catch(() => '')
      throw new SynoiGatewayError(
        `synoi-sdk local: GET /local/gate/:oid returned ${pollResp.status}: ${text.slice(0, 200)}`,
      )
    }

    const outcome = await pollResp.json() as LocalOutcomeResponse

    if (outcome.status === 'allowed') {
      c.log('info', `synoi-sdk local: ${ctx.tool_name} allowed (receipt_oid=${outcome.receipt_oid ?? 'n/a'})`)
      return await exec()
    }

    if (outcome.status === 'denied') {
      throw new SynoiDeniedError(
        `synoi-sdk local: ${ctx.tool_name} denied by operator`,
        { receipt_id: outcome.receipt_oid },
      )
    }

    if (outcome.status === 'timeout') {
      throw new SynoiDeniedError(
        `synoi-sdk local: ${ctx.tool_name} timed out (no operator decision within the allowed window)`,
        { receipt_id: outcome.receipt_oid },
      )
    }

    // status === 'pending': the server returned before the action was decided
    // (either the server-side long-poll window elapsed or it is a short-poll stub).
    // Yield a beat before re-issuing so the event loop can advance and so rapid
    // stub responses do not spin the loop without consuming real elapsed time.
    if (outcome.status !== 'pending') {
      // Unknown status: fail closed.
      throw new SynoiGatewayError(
        `synoi-sdk local: unexpected outcome status "${outcome.status}" for ${ctx.tool_name}`,
      )
    }
    await new Promise(r => setTimeout(r, 50))
    // Continue the loop (re-issue with the remaining budget).
  }
}

/**
 * Decide-only API. Useful when you want the verdict but not the SDK to call
 * your tool for you. Returns the RiskDecision; throws on non-2xx.
 *
 * Pass dispatch=true to ask the gateway to dispatch HITL for require_approval
 * verdicts. The returned RiskDecision will include hitl_id; the caller can
 * then call waitForApproval(hitl_id, cfg) to block on resolution.
 */
export async function decide(ctx: GateContext, cfg: SynoiConfig = {}, dispatch = false): Promise<RiskDecision> {
  const c = resolveConfig(cfg)
  if (!c.licenseKey) {
    if (c.mode === 'strict') throw new SynoiGatewayError('SYNOI_LICENSE_KEY not set (strict mode)')
    c.log('warn', 'SYNOI_LICENSE_KEY not set; defaulting to allow (permissive mode)')
    return { action: 'allow', reason: 'license-key-not-set' }
  }
  const url = `${c.gatewayUrl}/v1/risk/evaluate${dispatch ? '?dispatch=1' : ''}`
  let resp: Response
  try {
    resp = await c.fetcher(url, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${c.licenseKey}`,
      },
      body: JSON.stringify({
        tool_name:    ctx.tool_name,
        tool_input:   ctx.tool_input,
        user_message: ctx.user_message,
        model:        ctx.model,
        session_id:   ctx.session_id,
        intent_oid:   ctx.intent_oid,
      }),
    })
  } catch (err) {
    const msg = `gateway unreachable: ${(err as Error).message}`
    c.log(c.mode === 'strict' ? 'error' : 'warn', msg)
    if (c.mode === 'strict') throw new SynoiGatewayError(msg)
    return { action: 'allow', reason: 'gateway-unreachable' }
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const msg  = `gateway ${resp.status}: ${text.slice(0, 200)}`
    c.log(c.mode === 'strict' ? 'error' : 'warn', msg)
    if (c.mode === 'strict') throw new SynoiGatewayError(msg)
    return { action: 'allow', reason: `gateway-${resp.status}` }
  }
  const json = await resp.json() as RiskDecision
  return json
}

/**
 * Wait (long-poll) for a held HITL request to resolve. Returns the final
 * status. Used internally by gate() when waitForApproval=true.
 *
 * The gateway's /v1/risk/hitl/:id/wait endpoint long-polls server-side for up
 * to 30s per request; the SDK retries until the configured overall timeout.
 */
export async function waitForApproval(
  hitl_id:   string,
  cfg:       SynoiConfig = {},
  timeoutMs: number = 5 * 60_000,
): Promise<{ status: 'approved' | 'denied' | 'expired' | 'timeout'; decided_by?: string; note?: string }> {
  const c = resolveConfig(cfg)
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - start)
    const waitMs = Math.min(30_000, remaining)
    let resp: Response
    try {
      resp = await c.fetcher(`${c.gatewayUrl}/v1/risk/hitl/${encodeURIComponent(hitl_id)}/wait?wait_ms=${waitMs}`, {
        method:  'GET',
        headers: { 'Authorization': `Bearer ${c.licenseKey}` },
      })
    } catch (err) {
      const msg = `gateway unreachable while polling HITL: ${(err as Error).message}`
      c.log(c.mode === 'strict' ? 'error' : 'warn', msg)
      if (c.mode === 'strict') throw new SynoiGatewayError(msg)
      return { status: 'timeout' }
    }
    if (resp.status === 408) {
      // Server-side long-poll timed out — issue another iteration
      continue
    }
    if (resp.status === 404) {
      return { status: 'expired' }   // request was GC'd or never existed
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      const msg  = `gateway ${resp.status}: ${text.slice(0, 200)}`
      c.log(c.mode === 'strict' ? 'error' : 'warn', msg)
      if (c.mode === 'strict') throw new SynoiGatewayError(msg)
      return { status: 'timeout' }
    }
    const body = await resp.json() as { status: string; decided_by?: string; decision_note?: string; timed_out?: boolean }
    if (body.timed_out) continue
    if (body.status === 'approved' || body.status === 'denied' || body.status === 'expired') {
      return { status: body.status, decided_by: body.decided_by, note: body.decision_note }
    }
    // Anything else (pending, etc.) — wait a beat then re-issue
    await new Promise(r => setTimeout(r, 250))
  }
  return { status: 'timeout' }
}

/**
 * The headline API. Wrap a tool call with one function:
 *
 *   const result = await gate(ctx, () => myTool.exec(...))
 *
 * Returns whatever the wrapped function returns on allow.
 * Throws SynoiDeniedError on deny.
 *
 * On require_approval:
 *   - Default (waitForApproval: false) — throws SynoiDeniedError immediately
 *     with the matched-rule context. Caller surfaces the prompt to the
 *     operator out-of-band.
 *   - With { waitForApproval: true } — gateway dispatches HITL through its
 *     configured surfaces (mobile / SMS / desktop / Slack) and the SDK blocks
 *     until the operator decides (or approvalTimeoutMs elapses). On approve,
 *     the wrapped function runs; on deny / timeout / expired, throws.
 */
export async function gate<T>(
  ctx: GateContext,
  exec: () => Promise<T> | T,
  cfg: SynoiConfig = {},
): Promise<T> {
  const localCfg = resolveConfig(cfg)

  // Local-daemon mode (ADR_014 Section 9.3): additive, does NOT touch the SaaS path.
  if (localCfg.isLocal) {
    return gateLocal(ctx, exec, localCfg)
  }

  const wantsBlocking = cfg.waitForApproval === true
  const decision = await decide(ctx, cfg, wantsBlocking)
  if (decision.action === 'allow') {
    return await exec()
  }
  if (decision.action === 'deny') {
    throw new SynoiDeniedError(
      `Denied by SynOI policy${decision.matched_rule?.id ? ` (rule: ${decision.matched_rule.id})` : ''}: ${decision.reason}`,
      { matched_rule: decision.matched_rule },
    )
  }
  // require_approval
  if (!wantsBlocking || !decision.hitl_id) {
    throw new SynoiDeniedError(
      `Approval required by SynOI policy${decision.matched_rule?.id ? ` (rule: ${decision.matched_rule.id})` : ''}. ` +
      `Set { waitForApproval: true } on the gate() config to block until an operator decides.`,
      { matched_rule: decision.matched_rule },
    )
  }
  // Block + poll
  const c = resolveConfig(cfg)
  c.log('info', `synoi-sdk: awaiting approval for ${ctx.tool_name} (hitl=${decision.hitl_id})`)
  const result = await waitForApproval(decision.hitl_id, cfg, cfg.approvalTimeoutMs)
  if (result.status === 'approved') {
    c.log('info', `synoi-sdk: ${ctx.tool_name} approved by ${result.decided_by ?? 'operator'}`)
    return await exec()
  }
  throw new SynoiDeniedError(
    `HITL ${result.status} for ${ctx.tool_name}` +
    (result.decided_by ? ` (by ${result.decided_by})` : '') +
    (result.note ? `: ${result.note}` : ''),
    { matched_rule: decision.matched_rule, receipt_id: decision.hitl_id },
  )
}

/** Convenience: turn the SDK into a decorator-style wrapper around any function.
 *
 *  const safeRm = wrap('shell.exec', myRm)
 *  await safeRm({ command: 'rm -rf /tmp' })
 */
export function wrap<TInput extends Record<string, unknown>, TResult>(
  toolName: string,
  fn:       (input: TInput) => Promise<TResult> | TResult,
  cfg?:     SynoiConfig,
): (input: TInput) => Promise<TResult> {
  return async (input: TInput): Promise<TResult> => {
    return gate(
      { tool_name: toolName, tool_input: input },
      () => fn(input),
      cfg,
    )
  }
}
