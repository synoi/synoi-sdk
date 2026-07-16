/**
 * test/test-sdk-local-mode-v11.ts
 *
 * ADR_016 v1.1 SDK ergonomics vectors: principal_oid is optional in local mode.
 *
 * Vectors (reproduce-first: RED before fix, GREEN after):
 *
 *   SDK-V11-OMIT-NO-BODY      gate() with no principal_oid config does NOT send
 *                              principal_oid in the POST /local/gate body
 *
 *   SDK-V11-OMIT-ALLOW        gate() with no principal_oid, stub daemon derives and allows
 *                              -> gate() returns exec() result (full loop)
 *
 *   SDK-V11-OMIT-NULL-ENV     principal_oid set to empty string -> treated as omit (null)
 *
 *   SDK-V11-EXPLICIT-PRESENT  principal_oid explicitly set -> still sent in body (regression guard)
 *
 *   SDK-V11-ZERO-OID-ABSENT   the old ZERO_OID default is no longer sent when principal_oid
 *                              is absent (confirms the footgun is gone)
 *
 * No em dashes. No AI attribution.
 */

import { gate, SynoiDeniedError, SynoiGatewayError } from '../src/index'

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error('FAIL:', msg); process.exit(1) }
  console.log('OK  ', msg)
}

interface Captured { url: string; init: RequestInit }

function makeFetchStub(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Captured[] } {
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

const PENDING_OID = 'oid-' + 'a'.repeat(64)
const RECEIPT_OID = 'oid-' + 'b'.repeat(64)
const ZERO_OID    = 'oid-' + '0'.repeat(64)

function allowFlow(url: string): Response {
  if (url.includes('/local/gate') && !url.includes(`/${PENDING_OID}`)) {
    return jsonResp({ pending_oid: PENDING_OID, status: 'pending', challenge_nonce: 'nc' }, 201)
  }
  if (url.includes(`/local/gate/${PENDING_OID}`)) {
    return jsonResp({ pending_oid: PENDING_OID, status: 'allowed', decision: 'allow', receipt_oid: RECEIPT_OID })
  }
  return jsonResp({ error: 'unmatched' }, 404)
}

const DAEMON = 'http://127.0.0.1:7991'

async function main(): Promise<void> {

  // ── SDK-V11-OMIT-NO-BODY ─────────────────────────────────────────────────────
  // gate() with no principal_oid in config must NOT send principal_oid in the POST body.
  {
    const { fetch: f, calls } = makeFetchStub(allowFlow)
    await gate(
      { tool_name: 'shell.exec', tool_input: { command: 'ls' } },
      () => 'ok',
      { local: true, daemonUrl: DAEMON, bundle_oid: 'capbundle/1', fetcher: f },
    )
    const postCall = calls.find(c =>
      c.init.method === 'POST' && c.url.includes('/local/gate') && !c.url.includes(`/${PENDING_OID}`),
    )
    assert(postCall !== undefined, 'SDK-V11-OMIT-NO-BODY: found POST /local/gate call')
    const body = JSON.parse(String(postCall!.init.body)) as Record<string, unknown>
    assert(
      !('principal_oid' in body),
      `SDK-V11-OMIT-NO-BODY: principal_oid NOT in body when omitted (got ${JSON.stringify(body)})`,
    )
  }

  // ── SDK-V11-OMIT-ALLOW ───────────────────────────────────────────────────────
  // gate() with no principal_oid, stub allows -> exec() runs.
  {
    const { fetch: f } = makeFetchStub(allowFlow)
    let ran = false
    const result = await gate(
      { tool_name: 'shell.exec', tool_input: { command: 'ls' } },
      () => { ran = true; return 'exec-ran' },
      { local: true, daemonUrl: DAEMON, bundle_oid: 'capbundle/1', fetcher: f },
    )
    assert(ran,                      'SDK-V11-OMIT-ALLOW: exec() ran on allow')
    assert(result === 'exec-ran',    'SDK-V11-OMIT-ALLOW: gate() returns exec() result')
  }

  // ── SDK-V11-OMIT-NULL-ENV ────────────────────────────────────────────────────
  // Empty string principal_oid is treated as omit (no field in body).
  {
    const { fetch: f, calls } = makeFetchStub(allowFlow)
    await gate(
      { tool_name: 't', tool_input: {} },
      () => 'ok',
      { local: true, daemonUrl: DAEMON, bundle_oid: 'capbundle/1', principal_oid: '', fetcher: f },
    )
    const postCall = calls.find(c =>
      c.init.method === 'POST' && c.url.includes('/local/gate') && !c.url.includes(`/${PENDING_OID}`),
    )
    assert(postCall !== undefined, 'SDK-V11-OMIT-NULL-ENV: found POST call')
    const body = JSON.parse(String(postCall!.init.body)) as Record<string, unknown>
    assert(
      !('principal_oid' in body),
      `SDK-V11-OMIT-NULL-ENV: empty string principal_oid is omitted from body (got ${JSON.stringify(body)})`,
    )
  }

  // ── SDK-V11-EXPLICIT-PRESENT ─────────────────────────────────────────────────
  // When principal_oid is explicitly set, it IS sent in the body (regression guard).
  {
    const EXPLICIT_OID = 'oid-' + 'c'.repeat(64)
    const { fetch: f, calls } = makeFetchStub(allowFlow)
    await gate(
      { tool_name: 't', tool_input: {} },
      () => 'ok',
      { local: true, daemonUrl: DAEMON, bundle_oid: 'capbundle/1', principal_oid: EXPLICIT_OID, fetcher: f },
    )
    const postCall = calls.find(c =>
      c.init.method === 'POST' && c.url.includes('/local/gate') && !c.url.includes(`/${PENDING_OID}`),
    )
    assert(postCall !== undefined, 'SDK-V11-EXPLICIT-PRESENT: found POST call')
    const body = JSON.parse(String(postCall!.init.body)) as Record<string, unknown>
    assert(
      body['principal_oid'] === EXPLICIT_OID,
      `SDK-V11-EXPLICIT-PRESENT: explicit principal_oid sent in body (got ${body['principal_oid']})`,
    )
  }

  // ── SDK-V11-ZERO-OID-ABSENT ──────────────────────────────────────────────────
  // The old ZERO_OID default ('oid-' + '0'*64) must NOT appear in the body when
  // principal_oid is absent from config. This confirms the footgun is gone.
  {
    const { fetch: f, calls } = makeFetchStub(allowFlow)
    await gate(
      { tool_name: 't', tool_input: {} },
      () => 'ok',
      { local: true, daemonUrl: DAEMON, bundle_oid: 'capbundle/1', fetcher: f },
    )
    const postCall = calls.find(c =>
      c.init.method === 'POST' && c.url.includes('/local/gate') && !c.url.includes(`/${PENDING_OID}`),
    )
    assert(postCall !== undefined, 'SDK-V11-ZERO-OID-ABSENT: found POST call')
    const body = JSON.parse(String(postCall!.init.body)) as Record<string, unknown>
    assert(
      body['principal_oid'] !== ZERO_OID,
      `SDK-V11-ZERO-OID-ABSENT: ZERO_OID footgun not present in body (got ${body['principal_oid']})`,
    )
  }

  console.log('\nAll SDK v1.1 ergonomics tests passed.')
}

main().catch(err => { console.error('Test failed:', err); process.exit(1) })
