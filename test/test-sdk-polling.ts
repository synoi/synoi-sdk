/**
 * test-sdk-polling.ts — SDK v2 waitForApproval flow.
 *
 *   1. waitForApproval=false (default): require_approval throws immediately
 *   2. waitForApproval=true: require_approval → dispatches HITL → polls →
 *      resolves to approved → wrapped fn runs
 *   3. waitForApproval=true: denied verdict → throws SynoiDeniedError
 *   4. waitForApproval=true: expired verdict → throws
 *   5. waitForApproval=true: gateway long-poll 408 (no resolution yet) is
 *      transparently retried
 *   6. waitForApproval=true: overall timeout → throws (status: timeout)
 *   7. The decide(ctx, cfg, dispatch=true) variant adds ?dispatch=1 to URL
 *   8. waitForApproval() helper can be called standalone given a hitl_id
 */

import { gate, decide, waitForApproval, SynoiDeniedError } from '../src/index'

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error('FAIL:', msg); process.exit(1) }
  console.log('OK  ', msg)
}

interface Captured { url: string; init: RequestInit }
function makeFetchStub(handler: (url: string, init: RequestInit, callIndex: number) => Response | Promise<Response>) {
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

const baseCfg = { gatewayUrl: 'http://gw.test', licenseKey: 'synoi-lk-TEST' }

async function main(): Promise<void> {
  // ── 1. Default behavior unchanged — throws immediately ─────────────────
  {
    const { fetch: f } = makeFetchStub(() => jsonResp({ action: 'require_approval', reason: 'gate' }))
    let threw: Error | null = null
    try { await gate({ tool_name: 't', tool_input: {} }, () => 'x', { ...baseCfg, fetcher: f }) }
    catch (e) { threw = e as Error }
    assert(threw instanceof SynoiDeniedError,                              'default: require_approval throws immediately')
    assert(threw!.message.includes('waitForApproval'),                     'default: error mentions the opt-in flag')
  }

  // ── 2. waitForApproval=true → dispatches + polls → approved → runs ─────
  {
    let pollCount = 0
    const { fetch: f, calls } = makeFetchStub((url, _init, _i) => {
      if (url.includes('/v1/risk/evaluate')) {
        // The SDK must have appended ?dispatch=1
        assert(url.includes('dispatch=1'),                                  'shape: ?dispatch=1 included on evaluate URL')
        return jsonResp({
          action: 'require_approval',
          reason: 'gate-deploy',
          matched_rule: { id: 'gate-deploy' },
          hitl_id: 'hitl-test-1',
        })
      }
      if (url.includes('/v1/risk/hitl/')) {
        pollCount++
        if (pollCount < 2) return jsonResp({ hitl_id: 'hitl-test-1', status: 'pending' })
        return jsonResp({
          hitl_id:       'hitl-test-1',
          status:        'approved',
          decided_by:    'operator@example.com',
          decision_note: 'approved on phone',
        })
      }
      return jsonResp({ error: 'unmatched' }, 404)
    })
    let ran = false
    const out = await gate(
      { tool_name: 'Deploy', tool_input: { env: 'prod' } },
      () => { ran = true; return 'shipped' },
      { ...baseCfg, fetcher: f, waitForApproval: true, approvalTimeoutMs: 10_000 },
    )
    assert(out === 'shipped' && ran,                                       'approved-path: wrapped fn ran on approval')
    const pollUrls = calls.filter(c => c.url.includes('/v1/risk/hitl/'))
    assert(pollUrls.length >= 1,                                           `polled HITL at least once (got ${pollUrls.length})`)
    assert(pollUrls[0]!.url.includes('hitl-test-1'),                       'polled with the hitl_id we got back')
  }

  // ── 3. waitForApproval=true + denied → throws SynoiDeniedError ─────────
  {
    const { fetch: f } = makeFetchStub((url) => {
      if (url.includes('/v1/risk/evaluate')) {
        return jsonResp({ action: 'require_approval', hitl_id: 'hitl-deny-1', matched_rule: { id: 'gate' }, reason: 'manual' })
      }
      return jsonResp({ hitl_id: 'hitl-deny-1', status: 'denied', decided_by: 'op', decision_note: 'looked wrong' })
    })
    let threw: Error | null = null
    try { await gate({ tool_name: 't', tool_input: {} }, () => 'x', { ...baseCfg, fetcher: f, waitForApproval: true }) }
    catch (e) { threw = e as Error }
    assert(threw instanceof SynoiDeniedError,                              'denied: throws')
    assert(threw!.message.includes('denied'),                              'denied: message includes status')
    assert(threw!.message.includes('looked wrong'),                        'denied: message includes operator note')
  }

  // ── 4. waitForApproval=true + expired (404 from gateway wait) → throws ─
  {
    const { fetch: f } = makeFetchStub((url) => {
      if (url.includes('/v1/risk/evaluate')) return jsonResp({ action: 'require_approval', hitl_id: 'hitl-x', reason: 'g' })
      return new Response('not found', { status: 404 })
    })
    let threw: Error | null = null
    try { await gate({ tool_name: 't', tool_input: {} }, () => 'x', { ...baseCfg, fetcher: f, waitForApproval: true }) }
    catch (e) { threw = e as Error }
    assert(threw instanceof SynoiDeniedError,                              'expired: throws')
    assert(threw!.message.includes('expired'),                             'expired: message includes status')
  }

  // ── 5. Long-poll 408 is retried transparently ─────────────────────────
  {
    let phase = 0
    const { fetch: f } = makeFetchStub((url) => {
      if (url.includes('/v1/risk/evaluate')) return jsonResp({ action: 'require_approval', hitl_id: 'hitl-408', reason: 'g' })
      phase++
      // First poll: 408. Second poll: approved.
      if (phase === 1) return new Response('{}', { status: 408, headers: { 'Content-Type': 'application/json' } })
      return jsonResp({ hitl_id: 'hitl-408', status: 'approved', decided_by: 'op' })
    })
    let ran = false
    await gate({ tool_name: 't', tool_input: {} }, () => { ran = true; return 'ok' },
               { ...baseCfg, fetcher: f, waitForApproval: true, approvalTimeoutMs: 5_000 })
    assert(ran,                                                            '408-retry: SDK retried after 408 and ran the wrapped fn')
  }

  // ── 6. Overall timeout → throws (status: timeout) ──────────────────────
  {
    const { fetch: f } = makeFetchStub((url) => {
      if (url.includes('/v1/risk/evaluate')) return jsonResp({ action: 'require_approval', hitl_id: 'hitl-slow', reason: 'g' })
      return new Response('{}', { status: 408 })  // always 408 → never resolves
    })
    let threw: Error | null = null
    try {
      await gate({ tool_name: 't', tool_input: {} }, () => 'x',
                 { ...baseCfg, fetcher: f, waitForApproval: true, approvalTimeoutMs: 100 })
    } catch (e) { threw = e as Error }
    assert(threw instanceof SynoiDeniedError,                              'timeout: throws')
    assert(threw!.message.includes('timeout'),                             'timeout: status named in error')
  }

  // ── 7. decide(..., dispatch=true) appends ?dispatch=1 ──────────────────
  {
    const { fetch: f, calls } = makeFetchStub(() => jsonResp({ action: 'allow', reason: 'ok' }))
    await decide({ tool_name: 't', tool_input: {} }, { ...baseCfg, fetcher: f }, true)
    assert(calls[0]?.url.includes('?dispatch=1'),                          'decide(dispatch): URL includes ?dispatch=1')
  }

  // ── 8. waitForApproval() helper standalone ─────────────────────────────
  {
    const { fetch: f } = makeFetchStub(() => jsonResp({ hitl_id: 'hitl-direct', status: 'approved', decided_by: 'me' }))
    const r = await waitForApproval('hitl-direct', { ...baseCfg, fetcher: f }, 5_000)
    assert(r.status === 'approved' && r.decided_by === 'me',               'helper: standalone waitForApproval works')
  }

  console.log('\nAll SDK polling tests passed.')
}

main().catch(err => { console.error('Test failed:', err); process.exit(1) })
