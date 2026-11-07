import type { Server } from 'node:http';
import type { AgentDetail, Review } from '@reputed/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ROLES } from '../agents';
import { discoverPeer, hirePeer } from '../hirer';
import { CARD_PATH, jobMemo } from '../protocol';
import { startProvider, type Behavior } from '../provider';
import { SKILLS } from '../skills';
import type { Agent } from '../types';

// Both halves of the protocol over real HTTP on localhost, with Reputed and Hedera replaced by a small
// shared world: payments are rows, reviews update a plain average, and the gates read those scores.

interface Payment { id: string; from: string; to: string; tinybar: bigint; ts: number; memo: string }

class World {
  agents = new Map<string, AgentDetail>();
  payments = new Map<string, Payment>();
  reviews = new Map<string, { value: number; client: string; tag1?: string; tag2: string }[]>();
  clock = Math.floor(Date.now() / 1000);

  add(agentId: string, owner: string, url: string): void {
    this.agents.set(agentId, {
      agentId, name: `Agent ${agentId}`, description: '', tags: [], owner: owner as `0x${string}`, wallet: owner as `0x${string}`,
      creator: `0x${agentId.padStart(40, 'c')}`, humanBacked: true, score: { value: 100, tier: 'Tier 1', isNew: true }, creatorScore: 100,
      reviewsCounted: 0, registeredAt: '', acceptsX402: false, status: 'active', endpoints: { a2a: url }, agentUri: '', operatorChanged: false,
      credentials: [], reviews: [], reviewsExcluded: 0, penaltiesConfirmed: 0, updatedAt: '', scoresStale: false,
    });
  }

  agent(agentId: string, owner: string, accountId: string): Agent {
    const world = this;
    const get = (id: string) => {
      const found = world.agents.get(String(id));
      if (!found) throw new Error('not found');
      return structuredClone(found);
    };
    return {
      agentId, owner: owner as `0x${string}`, creator: `0x${agentId.padStart(40, 'c')}`, accountId,
      reputation: async () => get(agentId),
      verifyCounterparty: async (id, options = {}) => {
        const peer = get(String(id));
        if (options.humanBackedOnly && !peer.humanBacked) return { ok: false, reason: 'NOT_HUMAN_BACKED', message: 'not human-backed', agent: peer };
        if (options.minScore !== undefined && peer.score.value < options.minScore) {
          return { ok: false, reason: 'SCORE_TOO_LOW', message: `scores ${peer.score.value}, below ${options.minScore}`, agent: peer };
        }
        return { ok: true, agent: peer };
      },
      pay: async (id, hbar, options) => {
        const peer = get(String(id));
        const txId = `0.0.1-${++world.clock}-000000001`;
        world.payments.set(txId, { id: txId, from: owner, to: `acct:${peer.agentId}`, tinybar: BigInt(Math.round(hbar * 1e8)), ts: world.clock, memo: options?.memo ?? '' });
        return { transactionId: txId, agentId: peer.agentId, to: `acct:${peer.agentId}`, tinybar: BigInt(Math.round(hbar * 1e8)), consensusTimestamp: `${world.clock}.0` };
      },
      verifyPayment: async (txId, { from, minHbar = 0, memo }) => {
        const p = world.payments.get(txId);
        if (!p) return { ok: false, reason: 'NOT_FOUND', message: 'no such payment' };
        if (memo !== undefined && p.memo !== memo) return { ok: false, reason: 'WRONG_MEMO', message: 'wrong memo' };
        if (p.from !== from || p.to !== accountId) return { ok: false, reason: 'WRONG_PARTIES', message: 'wrong parties' };
        if (p.tinybar < BigInt(Math.round(minHbar * 1e8))) return { ok: false, reason: 'TOO_SMALL', message: 'too small' };
        return { ok: true, transactionId: txId, tinybar: p.tinybar, consensusTimestamp: `${p.ts}.0` };
      },
      review: async (id, input) => {
        const list = world.reviews.get(String(id)) ?? [];
        list.push({ value: input.value, client: owner, tag2: input.tag2, ...(input.tag1 ? { tag1: input.tag1 } : {}) });
        world.reviews.set(String(id), list);
        const peer = world.agents.get(String(id))!;
        const average = list.reduce((sum, r) => sum + r.value, 0) / list.length;
        peer.score = { value: average, tier: average >= 90 ? 'Tier 1' : average >= 75 ? 'Tier 2' : 'Tier 3', isNew: false };
        peer.creatorScore = average;
        peer.reviewsCounted = list.length;
        const review = { clientAddress: owner, feedbackIndex: list.length, value: input.value, counted: true } as unknown as Review;
        peer.reviews = [...peer.reviews, review];
        return { agentId: String(id), feedbackIndex: list.length, feedbackUri: 'hcs://0.0.1/1', feedbackHash: '0x00', transactionId: 'tx', value: input.value };
      },
      waitForReview: async (receipt) => {
        const peer = get(receipt.agentId);
        return { review: peer.reviews.find((r) => r.feedbackIndex === receipt.feedbackIndex)!, agent: peer };
      },
    } as Agent;
  }
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function provider(world: World, agent: Agent, faulty: number[] = [], port = 0) {
  const server = await startProvider({ agent, role: ROLES.b, url: 'pending', port, faultyJobs: new Set(faulty), log: () => {} });
  servers.push(server);
  const address = server.address();
  const url = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;
  return { server, url };
}

/** B (Hash Notary) serves; A hires it. The card URL must equal B's registered endpoint, so B is restarted on its port. */
async function setup(faulty: number[] = [], behavior?: (served: number) => Behavior) {
  const world = new World();
  const first = await provider(world, world.agent('2', '0xbb', '0.0.2'));
  const port = Number(new URL(first.url).port);
  first.server.close();
  servers.length = 0;
  const url = `http://localhost:${port}`;
  world.add('1', '0xaa', 'http://localhost:1');
  world.add('2', '0xbb', url);
  const b = world.agent('2', '0xbb', 'acct:2');
  const server = await startProvider({ agent: b, role: ROLES.b, url, port, faultyJobs: new Set(faulty), ...(behavior ? { behavior } : {}), log: () => {} });
  servers.push(server);
  const a = world.agent('1', '0xaa', 'acct:1');
  return { world, a, b, url };
}

describe('two agents', () => {
  it('a faulty provider loses score and then loses the business', async () => {
    const { world, a, url } = await setup([2]);
    const lines: string[] = [];
    const outcomes = await hirePeer({ agent: a, peerRole: ROLES.b, peerUrl: url, rounds: 4, minScore: 60, log: (l) => lines.push(l) });
    expect(outcomes.map((o) => o.kind)).toEqual(['rated', 'rated', 'refused']);
    expect(outcomes.slice(0, 2).map((o) => (o.kind === 'rated' ? o.value : null))).toEqual([95, 20]);
    expect(world.agents.get('2')!.score.value).toBe(57.5);
    expect(world.payments.size).toBe(2);
    expect(lines.some((l) => l.includes('not hiring'))).toBe(true);
  });

  it('a provider that keeps the payment and delivers nothing is reported for failed settlement', async () => {
    const { world, a, url } = await setup([], () => 'ghost');
    const outcomes = await hirePeer({ agent: a, peerRole: ROLES.b, peerUrl: url, rounds: 1, minScore: 60, log: () => {} });
    expect(outcomes).toMatchObject([{ kind: 'rated', value: 0 }]);
    expect(world.payments.size).toBe(1);
    expect(world.reviews.get('2')).toMatchObject([{ value: 0, tag1: 'misconduct', tag2: 'failed-settlement' }]);
  });

  it('a correct but slow answer is rated 80', async () => {
    const { world, a, url } = await setup([], () => 'slow');
    const outcomes = await hirePeer({ agent: a, peerRole: ROLES.b, peerUrl: url, rounds: 1, minScore: 60, log: () => {} });
    expect(outcomes).toMatchObject([{ kind: 'rated', value: 80 }]);
    expect(world.agents.get('2')!.score.value).toBe(80);
  });

  it('an honest provider keeps its score', async () => {
    const { world, a, url } = await setup();
    const outcomes = await hirePeer({ agent: a, peerRole: ROLES.b, peerUrl: url, rounds: 3, minScore: 60, log: () => {} });
    expect(outcomes.every((o) => o.kind === 'rated' && o.value === 95)).toBe(true);
    expect(world.agents.get('2')!.score.value).toBe(95);
  });

  it('the provider takes each payment once, only from the hirer, and only after the quote', async () => {
    const { world, a, url } = await setup();
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const ask = () => post('/jobs', { hirerAgentId: '1', skill: 'sha256', input: SKILLS.sha256.makeInput(1, 'x') });

    const q1 = await ask();
    expect(q1.status).toBe(402);
    const memo1 = jobMemo(q1.body['jobId'] as string);
    const early = await a.pay('2', 0.1, { memo: memo1 });
    world.payments.get(early.transactionId)!.ts -= 3_600;
    expect((await post(`/jobs/${q1.body['jobId']}/deliver`, { paymentTransactionId: early.transactionId })).body['code']).toBe('PAYMENT_BEFORE_QUOTE');

    const paid = await a.pay('2', 0.1, { memo: memo1 });
    expect((await post(`/jobs/${q1.body['jobId']}/deliver`, { paymentTransactionId: paid.transactionId })).status).toBe(200);
    expect((await post(`/jobs/${q1.body['jobId']}/deliver`, { paymentTransactionId: paid.transactionId })).status).toBe(409);
    const q2 = await ask();
    // A payment for another job, even A's own, does not buy this one: the memo names the job.
    expect((await post(`/jobs/${q2.body['jobId']}/deliver`, { paymentTransactionId: paid.transactionId })).body['code']).toBe('WRONG_MEMO');

    // Someone else's payment to B does not buy A's job.
    world.add('3', '0xcc', 'http://localhost:3');
    const stranger = await world.agent('3', '0xcc', 'acct:3').pay('2', 0.1, { memo: jobMemo(q2.body['jobId'] as string) });
    expect((await post(`/jobs/${q2.body['jobId']}/deliver`, { paymentTransactionId: stranger.transactionId })).body['code']).toBe('WRONG_PARTIES');
    expect((await post('/jobs/00000000-0000-0000-0000-000000000000/deliver', { paymentTransactionId: paid.transactionId })).status).toBe(404);
  });

  it('a job quoted in the hirer’s name cannot be paid for with the hirer’s payment for another job', async () => {
    // The attack: someone asks for a quote naming A as hirer, then cites A's payment for A's own job.
    const { a, url } = await setup();
    const post = async (path: string, body: unknown) =>
      (await fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json())) as Record<string, string>;
    const sniped = await post('/jobs', { hirerAgentId: '1', skill: 'sha256', input: { text: 'attacker input' } });
    const honest = await post('/jobs', { hirerAgentId: '1', skill: 'sha256', input: { text: 'A input' } });
    const payment = await a.pay('2', 0.1, { memo: jobMemo(honest['jobId']!) });
    expect((await post(`/jobs/${sniped['jobId']}/deliver`, { paymentTransactionId: payment.transactionId }))['code']).toBe('WRONG_MEMO');
    expect((await post(`/jobs/${honest['jobId']}/deliver`, { paymentTransactionId: payment.transactionId }))['output']).toBeDefined();
  });

  it('the provider refuses hirers with no human behind them, and bad input', async () => {
    const { world, url } = await setup();
    world.agents.get('1')!.humanBacked = false;
    const res = await fetch(`${url}/jobs`, { method: 'POST', body: JSON.stringify({ hirerAgentId: '1', skill: 'sha256', input: { text: 'hi' } }) });
    expect(res.status).toBe(403);
    world.agents.get('1')!.humanBacked = true;
    const bad = await fetch(`${url}/jobs`, { method: 'POST', body: JSON.stringify({ hirerAgentId: '1', skill: 'sha256', input: { text: 5 } }) });
    expect(bad.status).toBe(400);
  });

  it('the hirer does not trust a card whose endpoint is not the one the agent registered', async () => {
    const { world, a, url } = await setup();
    world.agents.get('2')!.endpoints = { a2a: 'https://somewhere-else.example' };
    await expect(discoverPeer({ agent: a, peerRole: ROLES.b, peerUrl: url, rounds: 1, minScore: 0, log: () => {} })).rejects.toThrow(/registered the endpoint/);
    const card = await (await fetch(`${url}${CARD_PATH}`)).json();
    expect(card.reputed.agentId).toBe('2');
  });
});

describe('skills', () => {
  it('each checker accepts the honest answer and rejects the faulty one', () => {
    for (const skill of Object.values(SKILLS)) {
      for (let job = 1; job <= 6; job++) {
        const input = skill.parseInput(skill.makeInput(job, `agent #${job * 13}`));
        expect(skill.check(input, skill.perform(input, false)).correct).toBe(true);
        expect(skill.check(input, skill.perform(input, true)).correct).toBe(false);
      }
    }
  });
});
