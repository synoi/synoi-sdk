/**
 * test-sdk.ts — @synoi/sdk one-line wrapper.
 *
 *   1. decide() returns the gateway's verdict on allow/deny/require_approval
 *   2. gate() runs the wrapped function on allow + returns its value
 *   3. gate() throws SynoiDeniedError on deny (with matched_rule)
 *   4. gate() throws on require_approval (v1; v2 will poll)
 *   5. permissive mode: gateway unreachable → allow + run + log warn
 *   6. strict mode: gateway unreachable → throws SynoiGatewayError
 *   7. wrap() decorator produces a callable that mirrors the underlying fn
 *   8. Missing license key in permissive → allow with warning
 *   9. Missing license key in strict → throws
 *  10. The gateway request shape carries Bearer + tool_name + tool_input
 */

import { gate, decide, wrap, SynoiDeniedError, SynoiGatewayError } from '../src/index'

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error('FAIL:', msg); process.exit(1) }
  console.log('OK  ', msg)
}

interface Captured { url: string; init: RequestInit }
function makeFetchStub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Captured[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    calls.push({ url, init: init ?? {} })
    return await handler(url, init ?? {})
  }) as typeof fetch
  return { fetch: f, calls }
}

function jsonResp(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })
}

async function main(): Promise<void> {
  const baseCfg = { gatewayUrl: 'http://gw.test', licenseKey: 'synoi-lk-TEST' }

  // ── 1. decide() ──────────────────────────────────────────────────────────
  {
    const { fetch: f } = makeFetchStub(() => jsonResp({ action: 'allow', reason: 'ok' }))
    const d = await decide({ tool_name: 'shell.exec', tool_input: { command: 'ls' } }, { ...baseCfg, fetcher: f })
    assert(d.action === 'allow',                                           'decide: returns allow')
  }

  // ── 2. gate() runs wrapped fn on allow ───────────────────────────────────
  {
    const { fetch: f } = makeFetchStub(() => jsonResp({ action: 'allow', reason: 'ok' }))
    const result = await gate({ tool_name: 't', tool_input: {} }, async () => 42, { ...baseCfg, fetcher: f })
    assert(result === 42,                                                  'gate: returns wrapped fn result on allow')
  }

  // ── 3. gate() throws SynoiDeniedError on deny ────────────────────────────
  {
    const { fetch: f } = makeFetchStub(() => jsonResp({
      action: 'deny', reason: 'rm-rf blocked',
      matched_rule: { id: 'no-rm-rf', note: 'never' },
    }))
    let threw: Error | null = null
    try { await gate({ tool_name: 't', tool_input: {} }, () => 'should not run', { ...baseCfg, fetcher: f }) }
    catch (e) { threw = e as Error }
    assert(threw instanceof SynoiDeniedError,                              'deny: throws SynoiDeniedError')
    assert((threw as SynoiDeniedError).matched_rule?.id === 'no-rm-rf',    'deny: matched_rule.id propagated')
    assert(threw!.message.includes('no-rm-rf'),                            'deny: message names the rule')
  }

  // ── 4. gate() throws on require_approval ─────────────────────────────────
  {
    const { fetch: f } = makeFetchStub(() => jsonResp({
      action: 'require_approval', reason: 'manual gate',
      matched_rule: { id: 'gate-prod-deploy' },
    }))
    let threw: Error | null = null
    try { await gate({ tool_name: 'Deploy', tool_input: {} }, () => 'nope', { ...baseCfg, fetcher: f }) }
    catch (e) { threw = e as Error }
    assert(threw instanceof SynoiDeniedError,                              'approval: throws SynoiDeniedError (v1 surface)')
    assert(threw!.message.includes('Approval required'),                   'approval: message says Approval required')
  }

  // ── 5. permissive: gateway down → allow + run ───────────────────────────
  {
    const logs: string[] = []
    const { fetch: f } = makeFetchStub(() => { throw new Error('ECONNREFUSED') })
    let ran = false
    const out = await gate(
      { tool_name: 't', tool_input: {} },
      () => { ran = true; return 'ran' },
      { ...baseCfg, fetcher: f, mode: 'permissive', log: (_l, m) => logs.push(m) },
    )
    assert(ran && out === 'ran',                                           'permissive-down: wrapped fn ran')
    assert(logs.some(m => m.includes('gateway unreachable')),              'permissive-down: warning logged')
  }

  // ── 6. strict: gateway down → throws SynoiGatewayError ──────────────────
  {
    const { fetch: f } = makeFetchStub(() => { throw new Error('ECONNREFUSED') })
    let threw: Error | null = null
    try { await gate({ tool_name: 't', tool_input: {} }, () => 'x', { ...baseCfg, fetcher: f, mode: 'strict' }) }
    catch (e) { threw = e as Error }
    assert(threw instanceof SynoiGatewayError,                             'strict-down: throws SynoiGatewayError')
  }

  // ── 7. wrap() decorator ─────────────────────────────────────────────────
  {
    const { fetch: f } = makeFetchStub(() => jsonResp({ action: 'allow', reason: 'ok' }))
    const safe = wrap('shell.exec', async (input: { command: string }) => `ran: ${input.command}`, { ...baseCfg, fetcher: f })
    const r = await safe({ command: 'ls' })
    assert(r === 'ran: ls',                                                'wrap: passes input through + returns result')
  }

  // ── 8. Missing license key in permissive → allow ────────────────────────
  {
    const logs: string[] = []
    let ran = false
    await gate(
      { tool_name: 't', tool_input: {} },
      () => { ran = true; return 1 },
      { gatewayUrl: 'http://gw.test', mode: 'permissive', log: (_l, m) => logs.push(m) },
    )
    assert(ran,                                                            'no-key-permissive: ran')
    assert(logs.some(m => m.includes('SYNOI_LICENSE_KEY not set')),        'no-key-permissive: logged warning')
  }

  // ── 9. Missing license key in strict → throws ───────────────────────────
  {
    let threw: Error | null = null
    try {
      await gate({ tool_name: 't', tool_input: {} }, () => 1,
                 { gatewayUrl: 'http://gw.test', mode: 'strict' })
    } catch (e) { threw = e as Error }
    assert(threw instanceof SynoiGatewayError,                             'no-key-strict: throws')
  }

  // ── 10. Gateway request shape ────────────────────────────────────────────
  {
    const { fetch: f, calls } = makeFetchStub(() => jsonResp({ action: 'allow', reason: 'ok' }))
    await decide({ tool_name: 'shell.exec', tool_input: { command: 'rm -rf /tmp' }, user_message: 'clean up', model: 'claude-opus-4-7' }, { ...baseCfg, fetcher: f })
    const c = calls[0]!
    assert(c.url.endsWith('/v1/risk/evaluate'),                            'shape: hits /v1/risk/evaluate')
    const headers = c.init.headers as Record<string, string>
    assert(headers['Authorization'] === 'Bearer synoi-lk-TEST',            'shape: Bearer license header')
    const body = JSON.parse(String(c.init.body))
    assert(body.tool_name === 'shell.exec',                                'shape: tool_name forwarded')
    assert(body.tool_input.command === 'rm -rf /tmp',                      'shape: tool_input forwarded')
    assert(body.user_message === 'clean up',                               'shape: user_message forwarded')
    assert(body.model === 'claude-opus-4-7',                               'shape: model forwarded')
  }

  console.log('\nAll @synoi/sdk tests passed.')
}

main().catch(err => { console.error('Test failed:', err); process.exit(1) })
