import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { AgentSummary } from '@reputed/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveView } from '../src/indexer/runtime.ts';
import { fingerprint, registerEventRoutes, type LiveSource } from '../src/routes/events.ts';
import { interactionsOf } from '../src/scoring/interactions.ts';

// A live view with only the fields the interactions graph and the event fingerprint read.

const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const C = '0x00000000000000000000000000000000000000cc';
const HUMAN = '0x00000000000000000000000000000000000000dd';

interface ReviewSpec {
  agentId: string;
  client: string;
  value: number;
  at: number;
  counted?: boolean;
}

function view(reviews: ReviewSpec[], scores: Record<string, number> = {}, asOf = 1_794_000_100): LiveView {
  const identity = (agentId: string, owner: string) => [agentId, { agentId, owner, ownerHistory: [], walletHistory: [{ wallet: owner, from: '0' }], agentUri: '', registeredAt: '1.0' }] as const;
  return {
    asOf: `${asOf}.000000000`,
    state: {
      // Agent 4 shares an owner with agent 3, so reviews from that address name no single agent.
      identities: new Map([identity('1', A), identity('2', B), identity('3', C), identity('4', C)]),
      links: new Map(),
      compromisedAt: new Map(),
    },
    result: {
      agents: ['1', '2', '3', '4'].map((agentId) => ({ agentId, creator: null, score: scores[agentId] ?? 100, tier: 'Tier 1', isNew: false, counted: 0, excluded: 0, distinctReviewers: 0, penaltiesConfirmed: 0 })),
      creators: [],
      reviews: reviews.map((r, i) => ({
        agentId: r.agentId,
        client: r.client,
        feedbackIndex: i + 1,
        value: String(r.value),
        valueDecimals: 0,
        normalizedValue: r.value,
        counted: r.counted ?? true,
        timestamp: `${r.at}.000000000`,
        revokedAt: null,
      })),
    },
  } as unknown as LiveView;
}

const summary = (agentId: string) => ({ agentId, name: `Agent ${agentId}` }) as AgentSummary;

describe('interactions', () => {
  it('collects reviews given and received per peer, newest first', () => {
    const v = view([
      { agentId: '1', client: B, value: 95, at: 1_794_000_001 }, // B rated agent 1
      { agentId: '2', client: A, value: 20, at: 1_794_000_002 }, // agent 1 rated B
      { agentId: '1', client: B, value: 80, at: 1_794_000_003, counted: false },
      { agentId: '1', client: HUMAN, value: 60, at: 1_794_000_004 }, // a wallet with no agent
      { agentId: '1', client: C, value: 40, at: 1_794_000_005 }, // an address with two agents
      { agentId: '3', client: B, value: 90, at: 1_794_000_006 }, // nothing to do with agent 1
    ]);
    const { peers } = interactionsOf(v, '1', summary);
    expect(peers.map((p) => [p.agent?.agentId ?? null, p.address, p.agentCount])).toEqual([
      [null, C, 2],
      [null, HUMAN, 0],
      ['2', B, 1],
    ]);
    const b = peers[2]!;
    expect(b.received).toMatchObject({ reviews: 2, counted: 1, average: 87.5, lastValue: 80 });
    expect(b.given).toMatchObject({ reviews: 1, counted: 1, average: 20, lastValue: 20 });
    expect(b.lastAt).toBe(new Date(1_794_000_003_000).toISOString());
  });

  it('has no peers for an agent nobody has dealt with', () => {
    expect(interactionsOf(view([]), '1', summary).peers).toEqual([]);
  });
});

describe('fingerprint', () => {
  it('changes with a score or a new review, and names the agents that moved', () => {
    const before = fingerprint(view([{ agentId: '1', client: B, value: 95, at: 1 }]));
    const same = fingerprint(view([{ agentId: '1', client: B, value: 95, at: 1 }], {}, 1_794_000_200));
    const rescored = fingerprint(view([{ agentId: '1', client: B, value: 95, at: 1 }], { '2': 57.5 }));
    const reviewed = fingerprint(view([{ agentId: '1', client: B, value: 95, at: 1 }, { agentId: '3', client: A, value: 95, at: 2 }]));
    expect(same.version).toBe(before.version);
    expect(rescored.version).not.toBe(before.version);
    expect(reviewed.version).not.toBe(before.version);
    expect([...rescored.agents].filter(([id, s]) => before.agents.get(id) !== s).map(([id]) => id)).toEqual(['2']);
  });
});

describe('GET /api/events', () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  it('pushes a scores event when the view changes, and nothing when it does not', async () => {
    const listeners = new Set<(v: LiveView) => void>();
    const source: LiveSource = {
      view: () => view([]),
      onLiveView: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const app = Fastify();
    await app.register(rateLimit, { global: false });
    registerEventRoutes(app, source);
    apps.push(app);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const res = await fetch(`${address}/api/events`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) text += decoder.decode((await reader.read()).value, { stream: true });
    };

    await readUntil('event: hello');
    for (const listener of listeners) listener(view([], {}, 1_794_000_500)); // same scores, later time
    for (const listener of listeners) listener(view([], { '3': 42 }));
    await readUntil('event: scores');
    const data = JSON.parse(text.split('event: scores\ndata: ')[1]!.split('\n')[0]!);
    expect(data.changed).toEqual(['3']);
    expect(text.match(/event: scores/g)).toHaveLength(1);
    await reader.cancel();
  });
});
