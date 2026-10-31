/**
 * test-sdk-frozen.ts - src/frozen.ts, kill-switch freeze handling.
 *
 *   1. frozenInfo() recognises a freeze deny (kill_switch object, or only the
 *      kill_switch rule id) and ignores ordinary denies and allows
 *   2. gateFrozenAware(): a freeze throws SynoiFrozenError (also a
 *      SynoiDeniedError), retryable=false, exec never runs, exactly ONE
 *      gateway call even with waitForApproval on
 *   3. the message is "SynOI: agent frozen by <actor>: <reason>"
 *   4. an ordinary deny still throws a plain SynoiDeniedError
 *   5. decideOrThrowFrozen(): throws on freeze, returns ordinary decisions
 *   6. a fail-closed unreadable freeze state is reported as such
 *   7. permissive mode cannot turn a freeze into an allow
 *   8. withAgentId() sends X-SynOI-Agent-Id and keeps the other headers
 */

import { SynoiDeniedError } from '../src/index'
import {
  frozenInfo, gateFrozenAware, decideOrThrowFrozen, withAgentId, isFrozenError,
  SynoiFrozenError,
} from '../src/frozen'

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error('FAIL:', msg); process.exit(1) }
  console.log('OK  ', msg)
}

function stub(body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === 'string' ? input : input.toString(), init: init ?? {} })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { f, calls }
}

const FROZEN = {
  action:       'deny',
  matched_rule: { id: 'kill_switch', note: 'agent:billing-bot' },
  reason:       'SynOI: agent frozen by Dana (admin-key:1a2b3c4d): runaway refunds [agent billing-bot]',
  receipt_id:   'rcpt-risk-1',
  kill_switch:  {
    frozen: true, scope: 'agent', target: 'billing-bot', actor: 'admin-key:1a2b3c4d', actor_name: 'Dana',
    reason: 'runaway refunds', frozen_at: 1, expires_at: null, freeze_id: 'ksf-1', freeze_receipt_id: 'rcpt-ks-freeze-1',
  },
}

async function main(): Promise<void> {
  const base = { gatewayUrl: 'http://gw.test', licenseKey: 'synoi-lk-TEST' }
  const ctx = { tool_name: 'refund.issue', tool_input: { amount: 5 } }

  // 1. recognition
  assert(frozenInfo(FROZEN)?.actor === 'admin-key:1a2b3c4d', 'frozenInfo: reads kill_switch object')
  assert(frozenInfo({ action: 'deny', matched_rule: { id: 'kill_switch' }, reason: 'x' }) !== null, 'frozenInfo: rule id alone is enough')
  assert(frozenInfo({ action: 'deny', matched_rule: { id: 'no-rm-rf' }, reason: 'x' }) === null, 'frozenInfo: ordinary deny is not a freeze')
  assert(frozenInfo({ action: 'allow', reason: 'ok', kill_switch: FROZEN.kill_switch }) === null, 'frozenInfo: never on allow')

  // 2 + 3. gateFrozenAware on a freeze
  {
    const { f, calls } = stub(FROZEN)
    let ran = false
    let err: unknown = null
    try {
      await gateFrozenAware(ctx, () => { ran = true }, { ...base, fetcher: f, waitForApproval: true })
    } catch (e) { err = e }
    assert(err instanceof SynoiFrozenError, 'gateFrozenAware: throws SynoiFrozenError')
    assert(err instanceof SynoiDeniedError, 'SynoiFrozenError is still a SynoiDeniedError (old catch blocks keep working)')
    assert((err as SynoiFrozenError).retryable === false, 'retryable is false')
    assert(!ran, 'exec did not run')
    assert(calls.length === 1, `exactly one gateway call, no retry / no approval poll (got ${calls.length})`)
    assert((err as Error).message.startsWith('SynOI: agent frozen by Dana (admin-key:1a2b3c4d): runaway refunds'),
      `message names actor and reason: ${(err as Error).message}`)
    assert(isFrozenError(err), 'isFrozenError: true')
  }

  // 4. ordinary deny unchanged
  {
    const { f } = stub({ action: 'deny', matched_rule: { id: 'no-refunds' }, reason: 'refunds off' })
    let err: unknown = null
    try { await gateFrozenAware(ctx, () => 1, { ...base, fetcher: f }) } catch (e) { err = e }
    assert(err instanceof SynoiDeniedError && !(err instanceof SynoiFrozenError), 'ordinary deny: plain SynoiDeniedError')
    assert(!isFrozenError(err), 'isFrozenError: false for ordinary deny')
  }

  // 5. decideOrThrowFrozen
  {
    const { f } = stub(FROZEN)
    let err: unknown = null
    try { await decideOrThrowFrozen(ctx, { ...base, fetcher: f }) } catch (e) { err = e }
    assert(err instanceof SynoiFrozenError && (err as SynoiFrozenError).frozen.target === 'billing-bot',
      'decideOrThrowFrozen: throws with structured FrozenInfo')
    assert((err as SynoiFrozenError).receipt_id === 'rcpt-risk-1', 'decideOrThrowFrozen: carries the deny receipt id')
    const { f: f2 } = stub({ action: 'allow', reason: 'ok' })
    const d = await decideOrThrowFrozen(ctx, { ...base, fetcher: f2 })
    assert(d.action === 'allow', 'decideOrThrowFrozen: passes ordinary decisions through')
  }

  // 6. unreadable
  {
    const { f } = stub({ action: 'deny', matched_rule: { id: 'kill_switch.unreadable' },
      reason: 'SynOI: kill switch state could not be read; failing closed', kill_switch: { frozen: true, unreadable: true } })
    let err: unknown = null
    try { await gateFrozenAware(ctx, () => 1, { ...base, fetcher: f }) } catch (e) { err = e }
    assert(err instanceof SynoiFrozenError && (err as SynoiFrozenError).frozen.unreadable === true, 'unreadable: frozen.unreadable true')
    assert(/could not be read/.test((err as Error).message), 'unreadable: says so')
  }

  // 7. permissive mode
  {
    const { f } = stub(FROZEN)
    let err: unknown = null
    try { await gateFrozenAware(ctx, () => 1, { ...base, fetcher: f, mode: 'permissive' }) } catch (e) { err = e }
    assert(err instanceof SynoiFrozenError, 'permissive mode: a freeze still blocks')
  }

  // 8. withAgentId
  {
    const { f, calls } = stub({ action: 'allow', reason: 'ok' })
    await decideOrThrowFrozen(ctx, { ...base, fetcher: withAgentId('billing-bot', f) })
    const h = new Headers(calls[0]!.init.headers)
    assert(h.get('x-synoi-agent-id') === 'billing-bot', 'withAgentId: header sent')
    assert(h.get('authorization') === 'Bearer synoi-lk-TEST', 'withAgentId: Authorization kept')
  }

  console.log('All SDK frozen-handling tests passed.')
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
