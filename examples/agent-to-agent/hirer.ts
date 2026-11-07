import { ReputedAgentError } from '@reputed/agent-kit';
import { ReputedError } from '@reputed/sdk';
import type { AgentDetail } from '@reputed/shared';
import { MAX_PRICE_HBAR, type Role } from './agents';
import { scoreLine, type Log, score as fmt, short } from './log';
import { CARD_PATH, jobMemo, PROTOCOL, type AgentCard, type Delivery, type JobError, type Quote } from './protocol';
import { SKILLS, type Verdict } from './skills';
import type { Agent } from './types';

// The buying side, one job at a time:
//   1. Gate: ask Reputed whether the peer is human-backed and scores at least minScore. Stop hiring if not.
//   2. Quote: send the job, get a 402 with the price.
//   3. Pay: HBAR from this agent's account to the peer's registered wallet, with the job ID as memo.
//   4. Deliver: send the payment's transaction ID, get the answer.
//   5. Judge: check the answer independently.
//   6. Rate: review the peer on-chain, citing the payment, and wait for the server to score it.

export interface HireOptions {
  agent: Agent;
  /** The role this agent hires for: the peer's role. */
  peerRole: Role;
  peerUrl: string;
  rounds: number;
  minScore: number;
  log: Log;
  /** How long to wait for the peer to come up. */
  discoverTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type JobOutcome =
  | { job: number; kind: 'refused'; reason: string }
  | { job: number; kind: 'rated'; value: number; counted: boolean; exclusionReason?: string; before: AgentDetail; after: AgentDetail }
  | { job: number; kind: 'failed'; reason: string };

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function http<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...init.headers },
    signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

/**
 * Fetches the peer's card and checks its claims against Reputed: the agent ID must exist, be owned by
 * the address the card names, and have registered this very URL as its endpoint. Anyone can serve a
 * card claiming to be agent #7; only agent #7's owner could register #7's endpoint.
 */
export async function discoverPeer(options: HireOptions): Promise<{ card: AgentCard; agent: AgentDetail }> {
  const { agent, peerUrl, log } = options;
  const sleep = options.sleep ?? sleepMs;
  const deadline = Date.now() + (options.discoverTimeoutMs ?? 10 * 60_000);
  let said = false;
  while (true) {
    try {
      const { status, body } = await http<AgentCard>(`${peerUrl}${CARD_PATH}`, { timeoutMs: 5_000 });
      if (status === 200 && body?.protocol === PROTOCOL) {
        const check = await agent.verifyCounterparty(body.reputed.agentId, { humanBackedOnly: true });
        if (!check.ok && check.reason !== 'NOT_HUMAN_BACKED') throw new Error(check.message);
        const registered = check.agent.endpoints.a2a;
        if (check.agent.owner.toLowerCase() !== body.reputed.owner.toLowerCase()) {
          throw new Error(`the card says agent #${body.reputed.agentId} is owned by ${body.reputed.owner}, Reputed says ${check.agent.owner}`);
        }
        if (registered !== body.url || body.url !== peerUrl) {
          throw new Error(`agent #${body.reputed.agentId} registered the endpoint ${registered ?? '(none)'}, not ${peerUrl}`);
        }
        // Not human-backed yet usually means the server has not indexed the link: keep waiting.
        if (check.ok) return { card: body, agent: check.agent };
      }
    } catch (error) {
      // An unreachable peer is still starting; anything else is a real problem.
      const unreachable = error instanceof TypeError || (error as Error).name === 'TimeoutError' || error instanceof ReputedError;
      if (!unreachable) throw new Error(`Not trusting the agent at ${peerUrl}: ${(error as Error).message}`);
    }
    if (Date.now() > deadline) throw new Error(`No agent answered at ${peerUrl}. Is the other agent running?`);
    if (!said) log(`Waiting for the other agent at ${peerUrl}…`);
    said = true;
    await sleep(3_000);
  }
}

function rating(verdict: Verdict | null, delivery: Delivery | null, job: number): { value: number; tag1: 'quality' | 'misconduct'; tag2: string; comment: string } {
  if (!delivery || !verdict) {
    return { value: 0, tag1: 'misconduct', tag2: 'failed-settlement', comment: `Job ${job}: paid, nothing delivered.` };
  }
  if (!verdict.correct) return { value: 20, tag1: 'quality', tag2: 'accuracy', comment: `Job ${job}: wrong answer, ${verdict.detail}.` };
  const value = delivery.workMs <= 2_000 ? 95 : 80;
  return { value, tag1: 'quality', tag2: 'accuracy', comment: `Job ${job}: correct, ${verdict.detail} (${delivery.workMs} ms).` };
}

const errorText = (error: unknown) => (error instanceof ReputedAgentError ? `${error.code}: ${error.message}` : (error as Error).message);

/** One job against a discovered peer: gate, quote, pay, deliver, judge, rate. */
export async function runJob(options: HireOptions, card: AgentCard, job: number): Promise<JobOutcome> {
  const { agent, peerRole, log, minScore } = options;
  const skill = SKILLS[peerRole.skill];
  const peerId = card.reputed.agentId;

  // 1. Gate
  const gate = await agent.verifyCounterparty(peerId, { humanBackedOnly: true, minScore });
  if (!gate.ok) {
    log(`Job ${job}: not hiring ${card.name} #${peerId}. ${gate.message}`);
    return { job, kind: 'refused', reason: gate.reason };
  }
  const before = gate.agent;

  // 2. Quote
  const input = skill.makeInput(job, `agent #${agent.agentId}`);
  const asked = await http<Quote | JobError>(`${card.url}/jobs`, { method: 'POST', body: JSON.stringify({ hirerAgentId: agent.agentId, skill: skill.id, input }) });
  if (asked.status !== 402 || !asked.body || !('jobId' in asked.body)) {
    const reason = asked.body && 'message' in asked.body ? asked.body.message : `HTTP ${asked.status}`;
    log(`Job ${job}: ${card.name} would not quote: ${reason}`);
    return { job, kind: 'failed', reason };
  }
  const quote = asked.body;
  if (!(quote.priceHbar > 0 && quote.priceHbar <= MAX_PRICE_HBAR)) {
    log(`Job ${job}: ${card.name} quoted ${quote.priceHbar} HBAR, over the ${MAX_PRICE_HBAR} HBAR budget`);
    return { job, kind: 'failed', reason: 'over budget' };
  }

  // 3. Pay
  log(`Job ${job}: ${card.name} #${peerId} quoted ${quote.priceHbar} HBAR for ${skill.id} ${JSON.stringify(input)}; paying it`);
  const payment = await agent.pay(peerId, quote.priceHbar, { memo: jobMemo(quote.jobId) });

  // 4. Deliver. A provider that took the money and failed to answer is reported as misconduct.
  let delivery: Delivery | null = null;
  try {
    const got = await http<Delivery | JobError>(`${card.url}/jobs/${quote.jobId}/deliver`, {
      method: 'POST',
      body: JSON.stringify({ paymentTransactionId: payment.transactionId }),
      timeoutMs: 90_000,
    });
    if (got.status === 200 && got.body && 'output' in got.body) delivery = got.body;
    else log(`Job ${job}: paid ${payment.transactionId} but got HTTP ${got.status}: ${got.body && 'message' in got.body ? got.body.message : 'no answer'}`);
  } catch (error) {
    log(`Job ${job}: paid ${payment.transactionId} but the delivery failed: ${(error as Error).message}`);
  }

  // 5. Judge
  const verdict = delivery ? skill.check(input, delivery.output) : null;
  const rated = rating(verdict, delivery, job);
  log(`Job ${job}: ${verdict ? (verdict.correct ? 'correct' : 'WRONG') : 'not delivered'}. Rating ${card.name} ${rated.value}/100 (${rated.tag1}/${rated.tag2})`);

  // 6. Rate, then watch the score move
  const receipt = await agent.review(peerId, { ...rated, proofOfPayment: payment.transactionId, endpoint: card.url });
  log(`Job ${job}: review #${receipt.feedbackIndex} is on-chain (${receipt.transactionId}); waiting for Reputed to score it`);
  const { review, agent: after } = await agent.waitForReview(receipt);
  log(
    review.counted
      ? `Job ${job}: counted. ${card.name} ${fmt(before.score.value)} → ${fmt(after.score.value)}, its creator ${short(after.creator)} ${fmt(before.creatorScore)} → ${fmt(after.creatorScore)}`
      : `Job ${job}: recorded but not counted (${review.exclusionReason}).`,
  );
  return {
    job,
    kind: 'rated',
    value: rated.value,
    counted: review.counted,
    ...(review.exclusionReason ? { exclusionReason: review.exclusionReason } : {}),
    before,
    after,
  };
}

/** Hires the peer up to `rounds` times. Stops early once the gate refuses it. */
export async function hirePeer(options: HireOptions): Promise<JobOutcome[]> {
  const { card, agent: peer } = await discoverPeer(options);
  options.log(`Found ${scoreLine(peer)} at ${card.url}`);
  const outcomes: JobOutcome[] = [];
  for (let job = 1; job <= options.rounds; job++) {
    try {
      const outcome = await runJob(options, card, job);
      outcomes.push(outcome);
      if (outcome.kind === 'refused') break;
    } catch (error) {
      options.log(`Job ${job} failed: ${errorText(error)}`);
      outcomes.push({ job, kind: 'failed', reason: errorText(error) });
      // Out of HBAR, or a payment or review in an unknown state: do not carry on blindly.
      if (error instanceof ReputedAgentError && ['INSUFFICIENT_HBAR', 'TIMEOUT'].includes(error.code)) break;
    }
  }
  return outcomes;
}
