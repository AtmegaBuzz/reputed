import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AgentDetail } from '@reputed/shared';
import type { Role } from './agents';
import type { Log } from './log';
import { CARD_PATH, jobMemo, PROTOCOL, type AgentCard, type Delivery, type JobError, type JobRequest, type Quote } from './protocol';
import { SKILLS } from './skills';
import type { Agent } from './types';

// The selling side. Before quoting, it checks on Reputed that the hirer is a live agent with a verified
// human behind it. Before working, it checks on the Mirror Node that the hirer's account paid this
// account at least the price, after the quote, with the job's ID as its memo, in a transaction it has
// not accepted before.

/**
 * How the provider handles one paid job: answer correctly, answer wrongly, answer correctly but
 * slowly (over the hirer's 2-second bar), or keep the payment and deliver nothing.
 */
export type Behavior = 'honest' | 'wrong' | 'slow' | 'ghost';

/** How long a 'slow' job takes: past the 2 seconds the hirer rates 95 for. */
export const SLOW_WORK_MS = 2_500;

export interface ProviderOptions {
  agent: Agent;
  role: Role;
  url: string;
  port: number;
  /** Served-job numbers (1-based) that get a deliberately wrong answer. */
  faultyJobs: Set<number>;
  /** Decides each served job (1-based) instead of faultyJobs. The simulation draws it from a persona. */
  behavior?: (served: number) => Behavior;
  log: Log;
  /** How long a quote stays payable. */
  quoteTtlMs?: number;
}

interface Job {
  id: string;
  number: number;
  hirer: AgentDetail;
  input: unknown;
  createdAt: number;
  expiresAt: number;
  state: 'quoted' | 'checking' | 'done';
}

/** Hedera consensus time and this machine's clock can disagree by a little. */
const CLOCK_SKEW_S = 60;
const MAX_BODY_BYTES = 16 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'TOO_LARGE', 'The request body is too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'BAD_JSON', 'The request body is not JSON.');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startProvider(options: ProviderOptions): Promise<Server> {
  const { agent, role, url, faultyJobs, log } = options;
  const skill = SKILLS[role.skill];
  const ttl = options.quoteTtlMs ?? 5 * 60_000;
  const jobs = new Map<string, Job>();
  /** Payments already accepted, or being checked right now, so one payment buys one job. */
  const spent = new Set<string>();
  let served = 0;

  const card: AgentCard = {
    protocol: PROTOCOL,
    name: role.name,
    description: role.description,
    url,
    skills: [{ id: skill.id, description: skill.description, priceHbar: role.priceHbar }],
    reputed: { agentId: agent.agentId, owner: agent.owner, accountId: agent.accountId },
  };

  async function quote(body: unknown): Promise<Quote> {
    const request = body as Partial<JobRequest> | null;
    if (request?.skill !== skill.id) throw new HttpError(400, 'UNKNOWN_SKILL', `This agent only does "${skill.id}".`);
    if (typeof request.hirerAgentId !== 'string' || !/^\d+$/.test(request.hirerAgentId)) {
      throw new HttpError(400, 'BAD_REQUEST', 'hirerAgentId must be your agent ID.');
    }
    if (request.hirerAgentId === agent.agentId) throw new HttpError(400, 'BAD_REQUEST', 'An agent cannot hire itself.');
    let input: unknown;
    try {
      input = skill.parseInput(request.input);
    } catch (error) {
      throw new HttpError(400, 'BAD_INPUT', (error as Error).message);
    }

    // Only work for agents a verified human answers for. Compromised agents are refused regardless.
    const check = await agent.verifyCounterparty(request.hirerAgentId, { humanBackedOnly: true });
    if (!check.ok) {
      log(`Refused a job from #${request.hirerAgentId}: ${check.message}`);
      throw new HttpError(403, check.reason, check.message);
    }

    const now = Date.now();
    const job: Job = { id: randomUUID(), number: 0, hirer: check.agent, input, createdAt: now, expiresAt: now + ttl, state: 'quoted' };
    jobs.set(job.id, job);
    log(`Quoted ${role.priceHbar} HBAR to ${check.agent.name} #${check.agent.agentId} for a ${skill.id} job`);
    return { jobId: job.id, priceHbar: role.priceHbar, payTo: agent.accountId, expiresAt: new Date(job.expiresAt).toISOString() };
  }

  async function deliver(jobId: string, body: unknown): Promise<Delivery> {
    const job = jobs.get(jobId);
    if (!job) throw new HttpError(404, 'UNKNOWN_JOB', 'No such job.');
    if (job.state !== 'quoted') throw new HttpError(409, 'ALREADY_PAID', 'This job was already paid for.');
    if (Date.now() > job.expiresAt) throw new HttpError(410, 'QUOTE_EXPIRED', 'The quote expired. Ask for a new one.');
    const txId = (body as { paymentTransactionId?: unknown } | null)?.paymentTransactionId;
    if (typeof txId !== 'string') throw new HttpError(400, 'BAD_REQUEST', 'paymentTransactionId is required.');

    job.state = 'checking';
    let reserved: string | null = null;
    try {
      // The hirer's on-chain owner must be the payer: the same account its review will come from.
      // The memo must name this job: otherwise whoever sees the hirer's payment could cite it for their own job first.
      const check = await agent.verifyPayment(txId, { from: job.hirer.owner, minHbar: role.priceHbar, memo: jobMemo(job.id) });
      if (!check.ok) throw new HttpError(402, check.reason, check.message);
      if (spent.has(check.transactionId)) throw new HttpError(402, 'PAYMENT_REUSED', 'That payment already bought another job.');
      if (Number(check.consensusTimestamp) < job.createdAt / 1000 - CLOCK_SKEW_S) {
        throw new HttpError(402, 'PAYMENT_BEFORE_QUOTE', 'That payment was made before this job was quoted.');
      }
      spent.add(check.transactionId);
      reserved = check.transactionId;
    } catch (error) {
      job.state = 'quoted';
      throw error;
    }

    served += 1;
    job.number = served;
    const act = options.behavior?.(job.number) ?? (faultyJobs.has(job.number) ? 'wrong' : 'honest');
    const hirer = `${job.hirer.name} #${job.hirer.agentId}`;
    if (act === 'ghost') {
      // The payment stays spent: this is the failed settlement the hirer reports as misconduct.
      job.state = 'done';
      log(`Job ${job.number} for ${hirer}: took the payment (${reserved}) and delivered NOTHING`);
      throw new HttpError(503, 'UNAVAILABLE', 'The agent could not do this job.');
    }
    const started = performance.now();
    if (act === 'slow') await new Promise((resolve) => setTimeout(resolve, SLOW_WORK_MS));
    const output = skill.perform(job.input, act === 'wrong');
    const workMs = Math.round(performance.now() - started);
    job.state = 'done';
    const how = act === 'wrong' ? ' a deliberately WRONG answer' : act === 'slow' ? ` a correct answer, slowly (${workMs} ms)` : '';
    log(`Job ${job.number} for ${hirer}: payment ${reserved} checked on the Mirror Node, delivered${how}`);
    return { jobId, output, workMs };
  }

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'GET' && (path === CARD_PATH || path === '/')) return send(res, 200, card);
      if (req.method === 'POST' && path === '/jobs') return send(res, 402, await quote(await readJson(req)));
      const match = /^\/jobs\/([0-9a-f-]{36})\/deliver$/.exec(path);
      if (req.method === 'POST' && match) return send(res, 200, await deliver(match[1]!, await readJson(req)));
      send(res, 404, { code: 'NOT_FOUND', message: 'Unknown route.' } satisfies JobError);
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { code: error.code, message: error.message } satisfies JobError);
      log(`Error serving ${req.method} ${req.url}: ${(error as Error).message}`);
      send(res, 500, { code: 'INTERNAL', message: 'The agent hit an error.' } satisfies JobError);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
