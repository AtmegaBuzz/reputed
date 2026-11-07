import type { Address, AgentInteractions, AgentSummary, InteractionPeer, InteractionStats } from '@reputed/shared';
import type { LiveView } from '../indexer/runtime.ts';
import { compareConsensus, toIso, type ConsensusTimestamp } from './time.ts';
import type { ClassifiedReview } from './types.ts';

// Who an agent has dealt with, from reviews both ways: the reviews it received (from the account that
// sent them) and the reviews its own account gave other agents. A review that counts stands for a job
// that was paid for, so this is the agent's trading graph as the chain records it. Jobs that were
// refused or never reviewed leave no trace here.

export const MAX_PEERS = 50;

interface Tally {
  reviews: number;
  counted: number;
  sum: number;
  last: ClassifiedReview | null;
}

const emptyTally = (): Tally => ({ reviews: 0, counted: 0, sum: 0, last: null });

const valueOf = (review: ClassifiedReview) => review.normalizedValue ?? Number(review.value) / 10 ** review.valueDecimals;

function add(tally: Tally, review: ClassifiedReview): void {
  tally.reviews += 1;
  if (review.counted) tally.counted += 1;
  tally.sum += valueOf(review);
  if (!tally.last || compareConsensus(review.timestamp, tally.last.timestamp) > 0) tally.last = review;
}

function stats(tally: Tally): InteractionStats {
  return {
    reviews: tally.reviews,
    counted: tally.counted,
    average: tally.reviews ? Math.round((tally.sum / tally.reviews) * 100) / 100 : null,
    lastValue: tally.last ? valueOf(tally.last) : null,
    lastAt: tally.last ? toIso(tally.last.timestamp) : null,
  };
}

/** Lowercase owner and current wallet → the agents behind them. */
function agentsByAddress(view: LiveView): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const put = (address: string | null | undefined, agentId: string) => {
    if (!address) return;
    const key = address.toLowerCase();
    const set = map.get(key) ?? new Set<string>();
    set.add(agentId);
    map.set(key, set);
  };
  for (const identity of view.state.identities.values()) {
    put(identity.owner, identity.agentId);
    put(identity.walletHistory.at(-1)?.wallet, identity.agentId);
  }
  return map;
}

export function interactionsOf(view: LiveView, agentId: string, summarize: (agentId: string) => AgentSummary | null): AgentInteractions {
  const byAddress = agentsByAddress(view);
  const me = view.state.identities.get(agentId);
  const mine = new Set([me?.owner, me?.walletHistory.at(-1)?.wallet].filter((a): a is Address => Boolean(a)).map((a) => a.toLowerCase()));

  const peers = new Map<string, { address: string; agentId: string | null; given: Tally; received: Tally }>();
  const peer = (key: string, address: string, peerAgentId: string | null) => {
    let found = peers.get(key);
    if (!found) {
      found = { address, agentId: peerAgentId, given: emptyTally(), received: emptyTally() };
      peers.set(key, found);
    }
    return found;
  };

  for (const review of view.result.reviews) {
    const client = review.client.toLowerCase();
    if (review.agentId === agentId) {
      // Received. The sender is a peer agent only when its address belongs to exactly one agent.
      if (mine.has(client)) continue;
      const owned = byAddress.get(client);
      const only = owned?.size === 1 ? [...owned][0]! : null;
      add(peer(only ? `agent:${only}` : `address:${client}`, client, only).received, review);
    } else if (mine.has(client)) {
      // Given: this agent's account reviewed another agent.
      const owner = view.state.identities.get(review.agentId)?.owner?.toLowerCase() ?? client;
      add(peer(`agent:${review.agentId}`, owner, review.agentId).given, review);
    }
  }

  const latest = (p: { given: Tally; received: Tally }): ConsensusTimestamp => {
    const times = [p.given.last?.timestamp, p.received.last?.timestamp].filter((t): t is ConsensusTimestamp => Boolean(t));
    return times.sort(compareConsensus).at(-1)!;
  };

  const list: InteractionPeer[] = [...peers.values()]
    .sort((a, b) => compareConsensus(latest(b), latest(a)))
    .slice(0, MAX_PEERS)
    .map((p) => ({
      address: p.address as Address,
      agent: p.agentId ? summarize(p.agentId) : null,
      agentCount: byAddress.get(p.address)?.size ?? 0,
      given: stats(p.given),
      received: stats(p.received),
      lastAt: toIso(latest(p)),
    }));

  return { agentId, peers: list, updatedAt: toIso(view.asOf) };
}
