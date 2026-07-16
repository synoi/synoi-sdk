/**
 * test/test-sdk-local-mode.ts
 *
 * Reproduce-first vectors for the additive SDK local mode per ADR_014 Section 9.3.
 *
 * Status: DESIGN (ADR_014 Section 9.5). PARTIAL-against-test-keys.
 *
 * All vectors use an injected fetcher stub; no live daemon required.
 *
 * Vectors (spec: ADR_014 Section 9.6 Surface (ii)):
 *   LOCAL-ALLOW         stub POST->201 pending; GET->allowed; gate() returns exec() result
 *   LOCAL-DENY          GET->denied; gate() throws SynoiDeniedError with receipt_id
 *   LOCAL-TIMEOUT       GET->timeout; throws SynoiDeniedError (message names timeout)
 *   LOCAL-UNREACHABLE   fetcher throws; strict default -> SynoiGatewayError (fail-closed)
 *   LOCAL-PERMISSIVE-UNREACHABLE  unreachable in permissive: local mode still fails closed
 *   LOCAL-HEADERS       every local-mode request carries X-SynOI-Local:1 and NO Authorization
 *   LOCAL-NO-KEY        works without SYNOI_LICENSE_KEY (no license required)
 *   LOCAL-NEVER-DECIDE  stub never sees a request to /local/decide
 *   LOCAL-SAAS-INTACT   gate() with local=false still hits /v1/risk/evaluate (additive)
 *   LOCAL-BUDGET        GET keeps returning pending; after approvalTimeoutMs -> SynoiDeniedError
 *   LOCAL-BODY-SHAPE    POST /local/gate body carries action_kind, args, panel_id, bundle_oid,
 *                       principal_oid per Section 9.3; originating_receipt_oid passthrough
 *   LOCAL-DAEMONURL     daemonUrl config overrides default; used in submit + poll URLs
 *
 * No em dashes. No AI attribution.
 */

import {
  gate,
  SynoiDeniedError,
  SynoiGatewayError,
} from '../src/index'

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error('FAIL:', msg); process.exit(1) }
  console.log('OK  ', msg)
}

interface Captured { url: string; init: RequestInit }

function makeFetchStub(
  handler: (url: string, init: RequestInit, callIndex: number) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = []
  let n = 0
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    calls.push({ url, init: init ?? {} })
    return await handler(url, init ?? {}, n++)
  }) as typeof fetch
  return { fetch: f, calls }
}

function jsonResp(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })
}

// Canonical stub responses for the local gate flow.
// Use oid- prefix (no colons) so encodeURIComponent does not alter them in poll URLs.
const PENDING_OID = 'oid-' + 'a'.repeat(64)
const RECEIPT_OID = 'oid-' + 'b'.repeat(64)

function allowFlow(url: string): Response {
  if (url.includes('/local/gate') && !url.includes(`/${PENDING_OID}`)) {
    // POST /local/gate -> 201 pending
    return jsonResp({ pending_oid: PENDING_OID, status: 'pending', challenge_nonce: 'nonce-test' }, 201)
  }
  if (url.includes(`/local/gate/${PENDING_OID}`)) {
    // GET /local/gate/:oid -> allowed
    return jsonResp({ pending_oid: PENDING_OID, status: 'allowed', decision: 'allow', receipt_oid: RECEIPT_OID, verify_url: `/local/receipts/${RECEIPT_OID}` })
  }
  return jsonResp({ error: 'unmatched' }, 404)
}

function denyFlow(url: string): Response {
  if (url.includes('/local/gate') && !url.includes(`/${PENDING_OID}`)) {
    return jsonResp({ pending_oid: PENDING_OID, status: 'pending', challenge_nonce: 'nonce-test' }, 201)
  }
  if (url.includes(`/local/gate/${PENDING_OID}`)) {
    return jsonResp({ pending_oid: PENDING_OID, status: 'denied', decision: 'deny', receipt_oid: RECEIPT_OID, verify_url: `/local/receipts/${RECEIPT_OID}` })
  }
  return jsonResp({ error: 'unmatched' }, 404)
}

function timeoutFlow(url: string): Response {
  if (url.includes('/local/gate') && !url.includes(`/${PENDING_OID}`)) {
    return jsonResp({ pending_oid: PENDING_OID, status: 'pending', challenge_nonce: 'nonce-test' }, 201)
  }
  if (url.includes(`/local/gate/${PENDING_OID}`)) {
    return jsonResp({ pending_oid: PENDING_OID, status: 'timeout', receipt_oid: RECEIPT_OID, verify_url: `/local/receipts/${RECEIPT_OID}` })
  }
  return jsonResp({ error: 'unmatched' }, 404)
}

const LOCAL_BASE = {
  local:         true,
  daemonUrl:     'http://127.0.0.1:7991',
  bundle_oid:    'capbundle/1',
  principal_oid: 'oid-' + '0'.repeat(64),
}

async function main(): Promise<void> {
  // ── LOCAL-ALLOW ─────────────────────────────────────────────────────────────
  {
    const { fetch: f } = makeFetchStub(url => allowFlow(url))
    let ran = false
    const result = await gate(
      { tool_name: 'shell.exec', tool_input: { command: 'ls /tmp' } },
      () => { ran = true; return 'exec-result' },
      { ...LOCAL_BASE, fetcher: f },
    )
    assert(ran,                      'LOCAL-ALLOW: exec() ran on allow')
    assert(result === 'exec-result', 'LOCAL-ALLOW: gate() returns exec() result')
  }

  // ── LOCAL-DENY ──────────────────────────────────────────────────────────────
  {
    const { fetch: f } = makeFetchStub(url => denyFlow(url))
    let ran = false
    let threw: Error | null = null
    try {
      await gate(
        { tool_name: 'shell.exec', tool_input: { command: 'rm -rf /' } },
        () => { ran = true; return 'should-not-run' },
        { ...LOCAL_BASE, fetcher: f },
      )
    } catch (e) { threw = e as Error }
    assert(!ran,                                   'LOCAL-DENY: exec() did NOT run')
    assert(threw instanceof SynoiDeniedError,       'LOCAL-DENY: threw SynoiDeniedError')
    assert(
      (threw as SynoiDeniedError).receipt_id === RECEIPT_OID,
      'LOCAL-DENY: receipt_id is the deny receipt_oid',
    )
  }

  // ── LOCAL-TIMEOUT ───────────────────────────────────────────────────────────
  {
    const { fetch: f } = makeFetchStub(url => timeoutFlow(url))
    let ran = false
    let threw: Error | null = null
    try {
      await gate(
        { tool_name: 'shell.exec', tool_input: {} },
        () => { ran = true; return 'x' },
        { ...LOCAL_BASE, fetcher: f },
      )
    } catch (e) { threw = e as Error }
    assert(!ran,                                    'LOCAL-TIMEOUT: exec() did NOT run')
    assert(threw instanceof SynoiDeniedError,        'LOCAL-TIMEOUT: threw SynoiDeniedError')
    const msg = (threw as SynoiDeniedError).message
    // The error message must name the timeout (distinguishable from operator deny).
    assert(
      msg.includes('timeout') || msg.includes('no operator decision'),
      `LOCAL-TIMEOUT: message names the timeout -- "${msg}"`,
    )
  }

  // ── LOCAL-UNREACHABLE (strict default = fail-closed) ────────────────────────
  {
    const { fetch: f } = makeFetchStub(() => { throw new Error('ECONNREFUSED') })
    let ran = false
    let threw: Error | null = null
    try {
      await gate(
        { tool_name: 't', tool_input: {} },
        () => { ran = true; return 'x' },
        { ...LOCAL_BASE, fetcher: f, mode: 'strict' },
      )
    } catch (e) { threw = e as Error }
    assert(!ran,                                  'LOCAL-UNREACHABLE: exec() did NOT run')
    assert(threw instanceof SynoiGatewayError,    'LOCAL-UNREACHABLE: strict -> SynoiGatewayError (fail-closed)')
  }

  // ── LOCAL-PERMISSIVE-UNREACHABLE: local mode fails CLOSED even in permissive ─
  // Section 9.3 spec: "local mode fail-closed-on-unreachable regardless of mode."
  // A down local governance daemon must not fail open.
  {
    const { fetch: f } = makeFetchStub(() => { throw new Error('ECONNREFUSED') })
    let ran = false
    let threw: Error | null = null
    try {
      await gate(
        { tool_name: 't', tool_input: {} },
        () => { ran = true; return 'x' },
        { ...LOCAL_BASE, fetcher: f, mode: 'permissive' },
      )
    } catch (e) { threw = e as Error }
    assert(!ran,   'LOCAL-PERMISSIVE-UNREACHABLE: exec() did NOT run (fail-closed in permissive)')
    assert(
      threw instanceof SynoiGatewayError || threw instanceof SynoiDeniedError,
      'LOCAL-PERMISSIVE-UNREACHABLE: threw a gate error (not open)',
    )
  }

  // ── LOCAL-HEADERS ────────────────────────────────────────────────────────────
  // Every local-mode request must carry X-SynOI-Local:1 and must NOT have Authorization.
  {
    const { fetch: f, calls } = makeFetchStub(url => allowFlow(url))
    await gate(
      { tool_name: 'shell.exec', tool_input: { x: 1 } },
      () => 'ok',
      { ...LOCAL_BASE, fetcher: f },
    )
    // All captured calls must have X-SynOI-Local: 1.
    const allHaveLocal = calls.every(c => {
      const hdrs = c.init.headers as Record<string, string> | undefined
      return hdrs?.['X-SynOI-Local'] === '1' || hdrs?.['x-synoi-local'] === '1'
    })
    assert(allHaveLocal, 'LOCAL-HEADERS: all requests carry X-SynOI-Local: 1')

    // None must have Authorization.
    const anyHaveAuth = calls.some(c => {
      const hdrs = c.init.headers as Record<string, string> | undefined
      return hdrs !== undefined && ('Authorization' in hdrs || 'authorization' in hdrs)
    })
    assert(!anyHaveAuth, 'LOCAL-HEADERS: no Authorization header on any local-mode request')
  }

  // ── LOCAL-NO-KEY ─────────────────────────────────────────────────────────────
  // Local mode must not require SYNOI_LICENSE_KEY.
  {
    const savedKey = process.env['SYNOI_LICENSE_KEY']
    delete process.env['SYNOI_LICENSE_KEY']
    const { fetch: f } = makeFetchStub(url => allowFlow(url))
    let threw: Error | null = null
    let ran = false
    try {
      await gate(
        { tool_name: 't', tool_input: {} },
        () => { ran = true; return 'ok' },
        // No licenseKey in config; env unset above.
        { local: true, daemonUrl: 'http://127.0.0.1:7991', bundle_oid: 'capbundle/1', principal_oid: 'oid-' + '0'.repeat(64), fetcher: f },
      )
    } catch (e) { threw = e as Error }
    if (savedKey !== undefined) process.env['SYNOI_LICENSE_KEY'] = savedKey
    assert(ran && threw === null, 'LOCAL-NO-KEY: gate() succeeded without license key')
  }

  // ── LOCAL-NEVER-DECIDE ───────────────────────────────────────────────────────
  // gate() must NEVER call /local/decide across all outcome paths.
  {
    for (const [label, flowFn] of [
      ['allow',   allowFlow],
      ['deny',    denyFlow],
      ['timeout', timeoutFlow],
    ] as Array<[string, (url: string) => Response]>) {
      const { fetch: f, calls } = makeFetchStub(url => flowFn(url))
      try {
        await gate(
          { tool_name: 't', tool_input: {} },
          () => 'ok',
          { ...LOCAL_BASE, fetcher: f },
        )
      } catch { /* deny/timeout throw; that is expected */ }
      const decideCall = calls.find(c => c.url.includes('/local/decide'))
      assert(!decideCall, `LOCAL-NEVER-DECIDE (${label}): no request to /local/decide`)
    }
  }

  // ── LOCAL-SAAS-INTACT ────────────────────────────────────────────────────────
  // gate() with local mode OFF must still hit /v1/risk/evaluate (additive guarantee).
  {
    const { fetch: f, calls } = makeFetchStub(() => jsonResp({ action: 'allow', reason: 'ok' }))
    await gate(
      { tool_name: 'shell.exec', tool_input: {} },
      () => 'saas-result',
      { gatewayUrl: 'http://gw.test', licenseKey: 'synoi-lk-TEST', fetcher: f },
    )
    assert(
      calls.some(c => c.url.includes('/v1/risk/evaluate')),
      'LOCAL-SAAS-INTACT: SaaS path still hits /v1/risk/evaluate',
    )
    assert(
      calls.every(c => !c.url.includes('/local/gate')),
      'LOCAL-SAAS-INTACT: SaaS path does NOT hit /local/gate',
    )
  }

  // ── LOCAL-BUDGET ─────────────────────────────────────────────────────────────
  // When GET /local/gate/:oid always returns "pending", the SDK must fail-closed
  // once approvalTimeoutMs elapses rather than blocking forever.
  {
    const { fetch: f } = makeFetchStub(url => {
      if (url.includes('/local/gate') && !url.includes(`/${PENDING_OID}`)) {
        return jsonResp({ pending_oid: PENDING_OID, status: 'pending', challenge_nonce: 'n' }, 201)
      }
      if (url.includes(`/local/gate/${PENDING_OID}`)) {
        // Always pending (operator never decides).
        return jsonResp({ pending_oid: PENDING_OID, status: 'pending' })
      }
      return jsonResp({ error: 'unmatched' }, 404)
    })
    let ran = false
    let threw: Error | null = null
    const t0 = Date.now()
    try {
      await gate(
        { tool_name: 't', tool_input: {} },
        () => { ran = true; return 'x' },
        // Very short budget so the test runs fast.
        { ...LOCAL_BASE, fetcher: f, approvalTimeoutMs: 300 },
      )
    } catch (e) { threw = e as Error }
    const elapsed = Date.now() - t0
    assert(!ran,                               'LOCAL-BUDGET: exec() did NOT run on budget expiry')
    assert(
      threw instanceof SynoiDeniedError || threw instanceof SynoiGatewayError,
      'LOCAL-BUDGET: threw a gate error on budget expiry',
    )
    // Should complete close to the budget (not hang).
    assert(elapsed < 2000, `LOCAL-BUDGET: completed within 2s (elapsed ${elapsed}ms)`)
  }

  // ── LOCAL-BODY-SHAPE ─────────────────────────────────────────────────────────
  // POST /local/gate body must carry the required fields per Section 9.3.
  {
    const { fetch: f, calls } = makeFetchStub(url => allowFlow(url))
    await gate(
      {
        tool_name:              'file.write',
        tool_input:             { path: '/etc/hosts', content: '...' },
        originating_receipt_oid: 'oid-' + 'f'.repeat(64),
      },
      () => 'ok',
      {
        ...LOCAL_BASE,
        fetcher: f,
        originating_receipt_oid: 'oid-' + 'f'.repeat(64),
      },
    )
    // Find the POST /local/gate call.
    const postCall = calls.find(c =>
      c.init.method === 'POST' && c.url.includes('/local/gate') && !c.url.includes(`/${PENDING_OID}`),
    )
    assert(postCall !== undefined, 'LOCAL-BODY-SHAPE: found POST /local/gate call')
    const body = JSON.parse(String(postCall!.init.body)) as Record<string, unknown>
    assert(body['action_kind'] === 'command',    'LOCAL-BODY-SHAPE: action_kind is "command"')
    assert(body['panel_id']    === 'approval',   'LOCAL-BODY-SHAPE: panel_id is "approval"')
    assert(body['bundle_oid']  === 'capbundle/1', 'LOCAL-BODY-SHAPE: bundle_oid from config')
    assert(
      body['principal_oid'] === 'oid-' + '0'.repeat(64),
      'LOCAL-BODY-SHAPE: principal_oid from config',
    )
    // args must carry tool_input (and optionally tool_name).
    const args = body['args'] as Record<string, unknown>
    assert(typeof args === 'object' && args !== null, 'LOCAL-BODY-SHAPE: args is object')
    // tool_name travels in args.tool_name per spec.
    assert(args['tool_name'] === 'file.write',  'LOCAL-BODY-SHAPE: args.tool_name is tool_name')
    assert(
      (args['tool_input'] as Record<string, unknown>)?.['path'] === '/etc/hosts',
      'LOCAL-BODY-SHAPE: args.tool_input carries tool_input',
    )
  }

  // ── LOCAL-DAEMONURL ──────────────────────────────────────────────────────────
  // daemonUrl config must be used in both the submit URL and the poll URL.
  {
    const DAEMON = 'http://127.0.0.1:8765'
    const { fetch: f, calls } = makeFetchStub(url => {
      // Reuse allow flow but rooted at DAEMON.
      const rel = url.replace(DAEMON, '')
      return allowFlow(`http://127.0.0.1:7991${rel}`)
    })
    await gate(
      { tool_name: 't', tool_input: {} },
      () => 'ok',
      { ...LOCAL_BASE, daemonUrl: DAEMON, fetcher: f },
    )
    const allUseDaemon = calls.every(c => c.url.startsWith(DAEMON))
    assert(allUseDaemon, 'LOCAL-DAEMONURL: all requests use configured daemonUrl')
  }

  console.log('\nAll SDK local-mode tests passed.')
}

main().catch(err => { console.error('Test failed:', err); process.exit(1) })
