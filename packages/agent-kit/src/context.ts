import type { AgentDetail, ConfigResponse } from '@reputed/shared';
import { ReputedError, type ReputedClient } from '@reputed/sdk';
import type { Address } from 'viem';
import { ReputedAgentError } from './errors';
import type { AgentGateway } from './gateway';
import type { MirrorClient } from './mirror';

// What payments and reviews need from a connected agent. Reputed.connect builds it once; tests build
// it from fakes. Nothing in it is secret: the key stays inside the gateway's Hedera Client.

export type ActionMirror = Pick<MirrorClient, 'getAccount' | 'getContractId' | 'getContractResult' | 'getTransaction'>;

export interface AgentContext {
  /** This agent: its ID, the account that owns it, and the human behind it. */
  agentId: string;
  owner: Address;
  creator: Address;
  gateway: AgentGateway;
  mirror: ActionMirror;
  /** Reads other agents from the Reputed API. */
  api: Pick<ReputedClient, 'getAgent'>;
  config: ConfigResponse;
  /** POSTs JSON to the Reputed API and returns the parsed body; errors are ReputedAgentError API_ERROR. */
  postJson<T>(path: string, body: unknown): Promise<T>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Agent IDs are uint256 values written in decimal. */
export function agentIdOf(agentId: string | number | bigint): string {
  const id = String(agentId);
  if (!/^\d{1,78}$/.test(id)) throw new ReputedAgentError('INVALID_ARGUMENT', `Agent IDs are decimal numbers, got "${id}".`);
  return id;
}

/** Another agent from the Reputed API, with the SDK's errors turned into this package's codes. */
export async function loadAgent(ctx: AgentContext, agentId: string): Promise<AgentDetail> {
  try {
    return await ctx.api.getAgent(agentId);
  } catch (error) {
    if (error instanceof ReputedError) {
      if (error.code === 'AGENT_NOT_FOUND') {
        throw new ReputedAgentError('AGENT_NOT_FOUND', `Reputed does not know agent ${agentId}.`, { cause: error });
      }
      throw new ReputedAgentError(error.code === 'INVALID_ARGUMENT' ? 'INVALID_ARGUMENT' : 'API_ERROR', error.message, { cause: error });
    }
    throw error;
  }
}

/** Refuses a send the account cannot cover. Hedera wants the whole gas limit (or amount plus fee) available when it is sent. */
export async function requireTinybar(ctx: AgentContext, tinybar: bigint, what: string): Promise<void> {
  const account = await ctx.mirror.getAccount(ctx.gateway.accountId);
  const have = BigInt(account?.balance.balance ?? 0);
  if (have < tinybar) {
    throw new ReputedAgentError(
      'INSUFFICIENT_HBAR',
      `Account ${ctx.gateway.accountId} has ${formatHbar(have)} HBAR but needs about ${formatHbar(tinybar)} HBAR to ${what}. Fund it (testnet faucet: https://portal.hedera.com/faucet) and try again.`,
    );
  }
}

export const TINYBAR_PER_HBAR = 100_000_000n;

export function formatHbar(tinybar: bigint): string {
  const sign = tinybar < 0n ? '-' : '';
  const abs = tinybar < 0n ? -tinybar : tinybar;
  const fraction = (abs % TINYBAR_PER_HBAR).toString().padStart(8, '0').replace(/0+$/, '');
  return `${sign}${abs / TINYBAR_PER_HBAR}${fraction ? `.${fraction}` : ''}`;
}
