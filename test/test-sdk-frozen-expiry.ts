/**
 * test-sdk-frozen-expiry.ts - F1: SynoiFrozenError / frozenMessage() say when
 * the freeze ends. The gateway now gives every freeze a 24 h expiry unless
 * until_lifted was sent; expires_at null means "until lifted". No expires_at
 * at all (older gateway) gets no suffix.
 */

import { frozenMessage, SynoiFrozenError } from '../src/frozen'

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error('FAIL:', msg); process.exit(1) }
  console.log('OK  ', msg)
}

const BASE = 'SynOI: agent frozen by Dana (admin-key:1a2b3c4d): runaway refunds'
const info = { actor: 'admin-key:1a2b3c4d', actor_name: 'Dana', reason: 'runaway refunds' }
const EXP = Date.UTC(2026, 10, 2, 0, 0, 0)

const m1 = frozenMessage({ ...info, expires_at: EXP })
assert(m1 === `${BASE} until 2026-11-02T00:00:00.000Z`, `timed freeze -> "until <ISO>" (got: ${m1})`)
const m2 = frozenMessage({ ...info, expires_at: null })
assert(m2 === `${BASE} until lifted`, `expires_at null -> "until lifted" (got: ${m2})`)
const m3 = frozenMessage({ ...info })
assert(m3 === BASE, `no expires_at -> no suffix (got: ${m3})`)
const e = new SynoiFrozenError({ ...info, expires_at: EXP })
assert(e.message === m1 && e.retryable === false, 'SynoiFrozenError default message carries the expiry')
assert(frozenMessage({ unreadable: true, expires_at: null }) === 'SynOI: kill switch state could not be read; failing closed',
  'unreadable wording unchanged')

console.log('All frozen-expiry tests passed.')
