/**
 * @synoi/sdk/dist/frozen - clear handling for a kill-switch freeze.
 *
 * When an operator freezes an agent (or every agent in a tenant), the gateway
 * answers /v1/risk/evaluate with action 'deny', matched_rule.id 'kill_switch'
 * (or 'kill_switch.unreadable' when it cannot read its freeze state and fails
 * closed), and a `kill_switch` object saying who froze it, why and until when.
 *
 * A freeze is not a transient failure. Retrying, backing off or waiting for
 * approval will not help until a tenant admin unfreezes, so everything here
 * surfaces it as a typed, non-retryable SynoiFrozenError:
 *
 *   import { gateFrozenAware, SynoiFrozenError } from '@synoi/sdk/dist/frozen'
 *   try {
 *     await gateFrozenAware(ctx, () => tool.exec(), cfg)
 *   } catch (e) {
 *     if (e instanceof SynoiFrozenError) stopTheAgentLoop(e.message)   // do not retry
 *   }
 *
 * Agent-scope freezes key on an agent id the caller declares. decide() has no
 * agent id field yet, so withAgentId() wraps the fetcher to send it as the
 * X-SynOI-Agent-Id header:
 *
 *   const cfg = { fetcher: withAgentId('billing-bot') }
 *
 * Kept in its own file (not index.ts) so the existing SDK surface is
 * unchanged. No em dashes. No AI attribution.
 */

import {
  decide, gate, SynoiDeniedError,
  type GateContext, type RiskDecision, type SynoiConfig,
} from './index'

/** What the gateway says about the freeze that stopped this call. */
export interface FrozenInfo {
  scope?:             'tenant' | 'agent'
  target?:            string
  actor?:             string
  actor_name?:        string | null
  reason?:            string
  frozen_at?:         number
  expires_at?:        number | null
  freeze_id?:         string
  freeze_receipt_id?: string | null
  /** The gateway could not read its freeze state and denied (fail closed). */
  unreadable?:        boolean
}

const KILL_SWITCH_RULE = /^kill_switch(\.|$)/

/** The freeze behind a decision, or null when the decision is not a freeze. */
export function frozenInfo(decision: unknown): FrozenInfo | null {
  if (!decision || typeof decision !== 'object') return null
  const d = decision as { action?: unknown; matched_rule?: { id?: unknown }; kill_switch?: unknown }
  if (d.action !== 'deny') return null
  if (d.kill_switch && typeof d.kill_switch === 'object') {
    const k = d.kill_switch as FrozenInfo & { frozen?: unknown }
    return {
      scope:             k.scope,
      target:            k.target,
      actor:             k.actor,
      actor_name:        k.actor_name ?? null,
      reason:            k.reason,
      frozen_at:         k.frozen_at,
      expires_at:        k.expires_at ?? null,
      freeze_id:         k.freeze_id,
      freeze_receipt_id: k.freeze_receipt_id ?? null,
      unreadable:        k.unreadable === true,
    }
  }
  const id = d.matched_rule?.id
  if (typeof id === 'string' && KILL_SWITCH_RULE.test(id)) {
    return { unreadable: id === 'kill_switch.unreadable' }
  }
  return null
}

/** "SynOI: agent frozen by <actor>: <reason>", the wording every surface uses. */
export function frozenMessage(info: FrozenInfo, fallbackReason?: string): string {
  if (info.unreadable) return 'SynOI: kill switch state could not be read; failing closed'
  const who = info.actor_name ? `${info.actor_name} (${info.actor})` : (info.actor ?? 'an operator')
  const why = info.reason ?? fallbackReason ?? 'no reason given'
  return `SynOI: agent frozen by ${who}: ${why}`
}

/** Thrown instead of SynoiDeniedError when the denial is a freeze. Never retry it. */
export class SynoiFrozenError extends SynoiDeniedError {
  readonly frozen:    FrozenInfo
  /** Always false: a freeze lasts until a tenant admin unfreezes (or it expires). */
  readonly retryable: false = false
  constructor(info: FrozenInfo, opts?: { receipt_id?: string; matched_rule?: { id?: string; note?: string }; message?: string }) {
    super(opts?.message ?? frozenMessage(info), { receipt_id: opts?.receipt_id, matched_rule: opts?.matched_rule })
    this.name   = 'SynoiFrozenError'
    this.frozen = info
  }
}

/** True for a SynoiFrozenError, or a plain SynoiDeniedError raised by a freeze. */
export function isFrozenError(err: unknown): boolean {
  if (err instanceof SynoiFrozenError) return true
  return err instanceof SynoiDeniedError && typeof err.matched_rule?.id === 'string' &&
    KILL_SWITCH_RULE.test(err.matched_rule.id)
}

/**
 * Turn the SynoiDeniedError that gate() throws for a freeze into a
 * SynoiFrozenError. Returns null for anything that is not a freeze.
 */
export function toFrozenError(err: unknown): SynoiFrozenError | null {
  if (err instanceof SynoiFrozenError) return err
  if (!isFrozenError(err)) return null
  const e = err as SynoiDeniedError
  const unreadable = e.matched_rule?.id === 'kill_switch.unreadable'
  // gate() words it "Denied by SynOI policy (rule: kill_switch): <gateway reason>",
  // and the gateway reason already is the full "SynOI: agent frozen by ..." line.
  const at = e.message.indexOf('SynOI: ')
  const message = at >= 0 ? e.message.slice(at) : undefined
  return new SynoiFrozenError({ unreadable }, { receipt_id: e.receipt_id, matched_rule: e.matched_rule, message })
}

/** Throw SynoiFrozenError if this decision is a freeze; otherwise do nothing. */
export function throwIfFrozen(decision: RiskDecision): void {
  const info = frozenInfo(decision)
  if (!info) return
  const d = decision as RiskDecision & { receipt_id?: string }
  // Prefer the gateway's own line: it adds the scope and expiry.
  const message = typeof d.reason === 'string' && d.reason.startsWith('SynOI: ') ? d.reason : frozenMessage(info, d.reason)
  throw new SynoiFrozenError(info, { receipt_id: d.receipt_id, matched_rule: d.matched_rule, message })
}

/** decide(), but a freeze throws SynoiFrozenError instead of returning a deny. */
export async function decideOrThrowFrozen(ctx: GateContext, cfg: SynoiConfig = {}, dispatch = false): Promise<RiskDecision> {
  const decision = await decide(ctx, cfg, dispatch)
  throwIfFrozen(decision)
  return decision
}

/**
 * gate(), but a freeze surfaces as SynoiFrozenError. One gateway call, no
 * retry, no approval wait: gate() never retries a deny, and a freeze is a deny.
 */
export async function gateFrozenAware<T>(ctx: GateContext, exec: () => Promise<T> | T, cfg: SynoiConfig = {}): Promise<T> {
  try {
    return await gate(ctx, exec, cfg)
  } catch (err) {
    throw toFrozenError(err) ?? err
  }
}

/** A fetcher that adds X-SynOI-Agent-Id, so agent-scope freezes can match this caller. */
export function withAgentId(agentId: string, fetcher: typeof fetch = fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers)
    headers.set('X-SynOI-Agent-Id', agentId)
    return fetcher(input, { ...init, headers })
  }) as typeof fetch
}
