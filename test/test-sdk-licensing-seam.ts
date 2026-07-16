/**
 * test/test-sdk-licensing-seam.ts
 *
 * SDK <-> gateway /v1/risk/evaluate contract test.
 *
 * Proves (mocks only, no live gateway):
 *   1. gate()/decide() sends the exact request shape riskRouter expects.
 *   2. RiskDecision response fields are correctly parsed.
 *   3. receipt_id in gateway response is additional metadata; not in SDK's
 *      RiskDecision type (not drift — intentional boundary).
 *   4. matched_rule field round-trips when present.
 *   5. Authorization header format is exactly: Bearer <licenseKey>.
 *   6. No X-Provider-Key header is sent (SDK does not know provider creds).
 *   7. Permissive/strict mode behaves correctly on non-2xx.
 *   8. waitForApproval=true appends ?dispatch=1 to evaluate URL.
 *   9. Local mode sends X-SynOI-Local:1 header and NO Authorization header.
 *
 * Contract references:
 *   SDK request:       src/index.ts:345-375 (decide function)
 *   Gateway response:  synoi-gateway/src/risk-router.ts
 *   SDK RiskDecision:  src/index.ts:64-72
 */

import http from 'node:http'
import { strict as assert } from 'node:assert'

// ─── Types from SDK that we type-assert here without importing (standalone test) ──

interface RiskDecision {
  action:        'allow' | 'deny' | 'require_approval'
  matched_rule?: { id?: string; note?: string }
  reason:        string
  hitl_id?:      string
  tenant_id?:    string
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function startFakeGateway(
  getStatus: () => number,
  getBody:   () => Record<string, unknown>,
): Promise<{
  port:     number
  close:    () => void
  calls:    Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string> }>
}> {
  const calls: Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', d => { raw += d })
      req.on('end', () => {
        let parsed: Record<string, unknown> = {}
        try { parsed = JSON.parse(raw) as Record<string, unknown> } catch { /* ignore */ }
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers[k] = v
        }
        calls.push({ path: req.url ?? '', body: parsed, headers })

        res.setHeader('Content-Type', 'application/json')
        res.statusCode = getStatus()
        res.end(JSON.stringify(getBody()))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        port:  addr.port,
        close: () => server.close(),
        calls,
      })
    })
  })
}

// ─── Test runner ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let passed = 0
  let failed = 0

  function ok(label: string, cond: boolean, detail?: string): void {
    if (cond) {
      passed++
      process.stdout.write(`OK   ${label}\n`)
    } else {
      failed++
      process.stdout.write(`FAIL ${label}${detail ? ` — ${detail}` : ''}\n`)
    }
  }

  // Real gateway riskRouter 200 response shape (src/risk-router.ts).
  // Fields: action, matched_rule, reason, receipt_id, tenant_id, hitl_id?
  const GATEWAY_ALLOW_RESPONSE = {
    action:       'allow',
    matched_rule: undefined as undefined | { id?: string; note?: string },
    reason:       'no matching rule; default allow',
    receipt_id:   'rcpt-risk-1719244805000-a1b2c3d4',  // present in gateway; NOT in RiskDecision type
    tenant_id:    'synoi',
  }

  let gwStatus = 200
  let gwBody: Record<string, unknown> = { ...GATEWAY_ALLOW_RESPONSE }

  const { port, close, calls } = await startFakeGateway(() => gwStatus, () => gwBody)
  const GW_URL = `http://127.0.0.1:${port}`
  const LICENSE_KEY = 'synoi-lk-sdk-seam-test-key-0001'

  // Import SDK (tsx handles TS source directly).
  const sdk = await import('../src/index.js') as {
    decide:           (ctx: Record<string, unknown>, cfg?: Record<string, unknown>, dispatch?: boolean) => Promise<RiskDecision>
    gate:             <T>(ctx: Record<string, unknown>, exec: () => Promise<T> | T, cfg?: Record<string, unknown>) => Promise<T>
    waitForApproval:  (hitl_id: string, cfg?: Record<string, unknown>, timeoutMs?: number) => Promise<{ status: string; decided_by?: string; note?: string }>
    SynoiDeniedError: { new(msg: string): Error & { name: string } }
    SynoiGatewayError: { new(msg: string): Error & { name: string } }
  }

  const baseCfg = {
    gatewayUrl: GW_URL,
    licenseKey: LICENSE_KEY,
    mode:       'strict',
    fetcher:    fetch,
  }

  process.stdout.write('\n=== SDK <-> gateway /v1/risk/evaluate contract ===\n\n')

  // ─── A: Request shape ──────────────────────────────────────────────────

  calls.length = 0
  const decisionA = await sdk.decide(
    { tool_name: 'shell.exec', tool_input: { command: 'ls /tmp' }, user_message: 'list files', model: 'claude-opus-4-7' },
    baseCfg,
  )

  ok('A1: POST to /v1/risk/evaluate',
    calls.length === 1 && calls[0]!.path === '/v1/risk/evaluate')
  ok('A2: Authorization header is Bearer <licenseKey>',
    calls[0]?.headers['authorization'] === `Bearer ${LICENSE_KEY}`)
  ok('A3: Content-Type is application/json',
    (calls[0]?.headers['content-type'] ?? '').includes('application/json'))
  ok('A4: request body.tool_name',      calls[0]?.body['tool_name'] === 'shell.exec')
  ok('A5: request body.tool_input',     (calls[0]?.body['tool_input'] as Record<string, unknown>)?.['command'] === 'ls /tmp')
  ok('A6: request body.user_message',   calls[0]?.body['user_message'] === 'list files')
  ok('A7: request body.model',          calls[0]?.body['model'] === 'claude-opus-4-7')
  ok('A8: no X-SynOI-Local header (SaaS path)',
    !calls[0]?.headers['x-synoi-local'])
  ok('A9: no X-Provider-Key header (SDK does not forward provider creds)',
    !calls[0]?.headers['x-provider-key'])

  // ─── B: Response shape ─────────────────────────────────────────────────

  ok('B1: action parsed correctly',       decisionA.action === 'allow')
  ok('B2: reason parsed correctly',       typeof decisionA.reason === 'string' && decisionA.reason.length > 0)
  ok('B3: tenant_id parsed correctly',    decisionA.tenant_id === 'synoi')
  // matched_rule is undefined in the allow response - SDK should handle that.
  ok('B4: matched_rule is undefined/null on allow without rule match',
    decisionA.matched_rule === undefined || decisionA.matched_rule === null)
  // receipt_id: present in gateway response body AND present at runtime on the
  // parsed RiskDecision object (JSON.parse passes it through). The RiskDecision
  // TypeScript interface simply does not declare it, so callers do not depend on it.
  // This is intentional: the SDK does not surface receipt_id via its type contract.
  // The gateway stores it; SDK consumers use hitl_id for polling only.
  // This assertion confirms the field passes through at runtime (non-drift boundary doc).
  ok('B5 (boundary, not drift): receipt_id present in gateway body; SDK passes it through at runtime (not in TS type)',
    (gwBody as Record<string, unknown>)['receipt_id'] !== undefined &&
    (decisionA as Record<string, unknown>)['receipt_id'] !== undefined)

  // ─── C: matched_rule round-trips when present ───────────────────────────

  gwBody = {
    action:       'deny',
    matched_rule: { id: 'rule-no-rm-rf', note: 'destructive shell commands blocked' },
    reason:       'matched rule: rule-no-rm-rf',
    receipt_id:   'rcpt-deny-001',
    tenant_id:    'synoi',
  }
  calls.length = 0
  let caughtDeny: (Error & { matched_rule?: { id?: string } }) | null = null
  try {
    await sdk.decide({ tool_name: 'shell.exec', tool_input: { command: 'rm -rf /' } }, baseCfg)
  } catch (e) {
    if (e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'SynoiDeniedError') {
      caughtDeny = e as Error & { matched_rule?: { id?: string } }
    }
  }

  // decide() does NOT throw — it returns the decision. gate() throws.
  // Re-run via gate() to check SynoiDeniedError with matched_rule.
  calls.length = 0
  let gateErrorDeny: (Error & { matched_rule?: { id?: string } }) | null = null
  try {
    await sdk.gate(
      { tool_name: 'shell.exec', tool_input: { command: 'rm -rf /' } },
      async () => 'should not run',
      baseCfg,
    )
  } catch (e) {
    gateErrorDeny = e as Error & { matched_rule?: { id?: string } }
  }
  ok('C1: gate() throws SynoiDeniedError on deny',
    gateErrorDeny !== null && gateErrorDeny.name === 'SynoiDeniedError')
  ok('C2: SynoiDeniedError carries matched_rule.id from response',
    gateErrorDeny?.matched_rule?.id === 'rule-no-rm-rf')

  // ─── D: hitl_id forwarded when action=require_approval ─────────────────

  gwBody = {
    action:   'require_approval',
    reason:   'policy requires human approval',
    hitl_id:  'hitl-test-99',
    receipt_id: 'rcpt-hitl-001',
    tenant_id: 'synoi',
  }
  calls.length = 0
  const decisionD = await sdk.decide(
    { tool_name: 'approve.payment', tool_input: { amount: 500 } },
    baseCfg,
  )
  ok('D1: hitl_id parsed from require_approval response', decisionD.hitl_id === 'hitl-test-99')
  ok('D2: action is require_approval', decisionD.action === 'require_approval')

  // ─── E: dispatch=true appends ?dispatch=1 ──────────────────────────────

  calls.length = 0
  await sdk.decide(
    { tool_name: 'approve.payment', tool_input: {} },
    baseCfg,
    true, // dispatch=true
  )
  ok('E1: dispatch=true appends ?dispatch=1 to evaluate URL',
    calls.length > 0 && (calls[0]?.path ?? '').includes('?dispatch=1'))

  calls.length = 0
  await sdk.decide(
    { tool_name: 'approve.payment', tool_input: {} },
    baseCfg,
    false, // dispatch=false
  )
  ok('E2: dispatch=false does NOT append ?dispatch=1',
    calls.length > 0 && !(calls[0]?.path ?? '').includes('dispatch=1'))

  // ─── F: Error handling ─────────────────────────────────────────────────

  gwStatus = 401
  gwBody   = { error: { message: 'Unknown or revoked SynOI key.', type: 'auth_error' } }
  calls.length = 0
  let caught401: Error | null = null
  try {
    await sdk.decide({ tool_name: 'test', tool_input: {} }, baseCfg)
  } catch (e) {
    caught401 = e as Error
  }
  ok('F1: strict mode + 401 from gateway throws SynoiGatewayError',
    caught401 !== null && caught401.name === 'SynoiGatewayError')

  gwStatus = 401
  const permissiveResult = await sdk.decide(
    { tool_name: 'test', tool_input: {} },
    { ...baseCfg, mode: 'permissive' },
  )
  ok('F2: permissive mode + 401 returns allow (fail-open)',
    permissiveResult.action === 'allow')

  gwStatus = 200
  gwBody   = { ...GATEWAY_ALLOW_RESPONSE }

  // ─── G: Missing licenseKey ──────────────────────────────────────────────

  calls.length = 0
  let caughtNoKey: Error | null = null
  try {
    await sdk.decide(
      { tool_name: 'test', tool_input: {} },
      { ...baseCfg, licenseKey: '' },
    )
  } catch (e) {
    caughtNoKey = e as Error
  }
  ok('G1: strict mode + no licenseKey throws SynoiGatewayError',
    caughtNoKey !== null && caughtNoKey.name === 'SynoiGatewayError')
  ok('G2: no CP call made when licenseKey is empty', calls.length === 0)

  const noKeyPermissive = await sdk.decide(
    { tool_name: 'test', tool_input: {} },
    { ...baseCfg, licenseKey: '', mode: 'permissive' },
  )
  ok('G3: permissive mode + no licenseKey returns allow with reason license-key-not-set',
    noKeyPermissive.action === 'allow' && noKeyPermissive.reason === 'license-key-not-set')

  // ─── H: Local mode sends X-SynOI-Local:1, no Authorization ────────────

  // Start a fake local daemon.
  const { calls: daemonCalls, port: daemonPort, close: closeDaemon } = await startFakeGateway(
    () => 200,
    () => ({ pending_oid: 'oid-test-local-001' }),
  )

  // For local mode the SDK POSTs /local/gate and then polls. We only check the submit call.
  // The daemon will respond with pending_oid; polling will then fail (daemon returns pending_oid
  // not a poll response) but we capture the submit call shape before that happens.
  calls.length = 0
  daemonCalls.length = 0

  let localError: Error | null = null
  try {
    await sdk.gate(
      { tool_name: 'file.write', tool_input: { path: '/tmp/x', content: 'y' } },
      async () => 'done',
      {
        local:      true,
        daemonUrl:  `http://127.0.0.1:${daemonPort}`,
        licenseKey: '', // not required in local mode
        fetcher:    fetch,
        approvalTimeoutMs: 200, // short timeout so the test does not hang
      },
    )
  } catch (e) {
    localError = e as Error
  }

  const submitCall = daemonCalls[0]
  ok('H1: local mode sends POST to /local/gate',
    submitCall?.path === '/local/gate')
  ok('H2: local mode sends X-SynOI-Local: 1 header',
    submitCall?.headers['x-synoi-local'] === '1')
  ok('H3: local mode sends NO Authorization header',
    !submitCall?.headers['authorization'])
  ok('H4: local mode request body contains args.tool_name',
    (submitCall?.body as Record<string, unknown>)?.['args'] !== undefined &&
    ((submitCall?.body as Record<string, unknown>)?.['args'] as Record<string, unknown>)?.['tool_name'] === 'file.write')
  ok('H5: local mode request body contains bundle_oid',
    typeof (submitCall?.body as Record<string, unknown>)?.['bundle_oid'] === 'string')
  ok('H6: local mode request body contains principal_oid',
    typeof (submitCall?.body as Record<string, unknown>)?.['principal_oid'] === 'string')
  ok('H7: local mode fails closed (SynoiDeniedError or SynoiGatewayError) on timeout/bad poll',
    localError !== null &&
    (localError.name === 'SynoiDeniedError' || localError.name === 'SynoiGatewayError'))
  // The gateway calls (SaaS path) must be zero in local mode.
  ok('H8: local mode does NOT call /v1/risk/evaluate (SaaS path unused)',
    calls.length === 0)

  closeDaemon()
  close()

  // ─── Summary ─────────────────────────────────────────────────────────────
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  process.stderr.write(`test crashed: ${(err as Error).stack ?? err}\n`)
  process.exit(1)
})
