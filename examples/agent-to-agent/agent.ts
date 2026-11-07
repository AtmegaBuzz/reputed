// One agent. Run two of these with different keys (`pnpm agent:a`, `pnpm agent:b`), or both at once
// with `pnpm demo`. Each one:
//   1. connects to Reputed with its own API key (registers, links to its human, gets its credential),
//   2. serves its skill over HTTP,
//   3. hires the other agent ROUNDS times: pays it, checks the answer, rates it on-chain,
//   4. keeps serving until stopped, so the other agent can finish too.
import { Client, PrivateKey } from '@hiero-ledger/sdk';
import { Reputed, ReputedAgentError } from '@reputed/agent-kit';
import { HEDERA_TESTNET } from '@reputed/shared';
import { privateKeyToAccount } from 'viem/accounts';
import { other, ROLES, type Side } from './agents';
import { hirePeer, type JobOutcome } from './hirer';
import { logger, scoreLine } from './log';
import { startProvider } from './provider';
import { parseJobList } from './skills';
import type { Agent } from './types';

const side = process.argv[2] as Side;
if (side !== 'a' && side !== 'b') {
  console.error('Usage: tsx --env-file=.env agent.ts <a|b>');
  process.exit(2);
}
const role = ROLES[side];
const peerRole = ROLES[other(side)];
const S = side.toUpperCase();
const P = other(side).toUpperCase();
const log = logger(side, `${S} ${role.name}`);

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    log(`${name} is not set. Copy .env.example to .env and fill it in (see README.md).`);
    process.exit(2);
  }
  return value;
}

const port = Number(process.env[`${S}_PORT`] || role.defaultPort);
const peerPort = Number(process.env[`${P}_PORT`] || peerRole.defaultPort);
const url = `http://localhost:${port}`;
const peerUrl = `http://localhost:${peerPort}`;
const rounds = Number(process.env['ROUNDS'] || 3);
const minScore = Number(process.env['MIN_SCORE'] || 60);
const faultyJobs = parseJobList(process.env[`${S}_FAULTY_JOBS`]);

/** The account behind a key, from the Mirror Node, so .env only needs the key. */
async function accountFor(key: string): Promise<string> {
  const given = process.env[`${S}_ACCOUNT_ID`]?.trim();
  if (given) return given;
  const evm = privateKeyToAccount(`0x${key.replace(/^0x/, '')}`).address;
  const res = await fetch(`${HEDERA_TESTNET.mirrorNode}/api/v1/accounts/${evm}`);
  if (!res.ok) {
    log(`No testnet account exists for ${evm} yet. Send it some HBAR (that creates it) or set ${S}_ACCOUNT_ID.`);
    process.exit(2);
  }
  return ((await res.json()) as { account: string }).account;
}

function summary(outcomes: JobOutcome[]): string {
  return outcomes
    .map((o) => (o.kind === 'rated' ? `job ${o.job}: rated ${o.value}${o.counted ? '' : ` (not counted: ${o.exclusionReason})`}` : `job ${o.job}: ${o.kind} (${o.reason})`))
    .join('; ');
}

async function main(): Promise<void> {
  const key = env(`${S}_PRIVATE_KEY`);
  const apiKey = env(`${S}_API_KEY`);
  const accountId = await accountFor(key);
  const client = Client.forTestnet().setOperator(accountId, PrivateKey.fromStringECDSA(key.replace(/^0x/, '')));
  log(`Starting as Hedera account ${accountId}`);

  const reputed = await Reputed.connect({
    client,
    apiKey,
    agent: { name: role.name, description: role.description, endpoints: { a2a: url }, tags: ['example', role.skill] },
    // One state file per agent: two processes writing one file could drop each other's progress.
    state: `.reputed/agent-${side}.json`,
    logger: (message) => log(`[reputed] ${message}`),
  });
  log(`Agent #${reputed.agentId}, backed by the human ${reputed.creator}`);

  // The server indexes the link a few seconds after it lands. Serving or hiring before then would
  // make the other agent see this one as not human-backed.
  for (let i = 0; ; i++) {
    const me = await reputed.reputation().catch(() => null);
    if (me?.humanBacked) {
      log(`On Reputed: ${scoreLine(me)}`);
      break;
    }
    if (i === 0) log('Waiting for Reputed to index this agent…');
    if (i > 60) throw new Error('Reputed has not shown this agent as human-backed after 3 minutes. Is the server running and indexing?');
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  const agent: Agent = {
    agentId: reputed.agentId,
    owner: reputed.owner,
    creator: reputed.creator,
    accountId,
    reputation: () => reputed.reputation(),
    verifyCounterparty: (id, options) => reputed.verifyCounterparty(id, options),
    pay: (id, hbar, options) => reputed.pay(id, hbar, options),
    verifyPayment: (txId, options) => reputed.verifyPayment(txId, options),
    review: (id, input) => reputed.review(id, input),
    waitForReview: (receipt, options) => reputed.waitForReview(receipt, options),
  };

  const server = await startProvider({ agent, role, url, port, faultyJobs, log });
  log(`Serving ${role.skill} at ${url} for ${role.priceHbar} HBAR a job${faultyJobs.size ? ` (wrong answers on job ${[...faultyJobs].join(', ')})` : ''}`);

  const stop = () => {
    server.close();
    client.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const outcomes = await hirePeer({ agent, peerRole, peerUrl, rounds, minScore, log });
  log(`Done hiring: ${summary(outcomes) || 'no jobs'}`);
  const me = await reputed.reputation();
  log(`Now: ${scoreLine(me)}`);
  process.send?.({ type: 'done', side, agentId: reputed.agentId, outcomes: outcomes.map((o) => ({ job: o.job, kind: o.kind })) });
  if (!process.send) log('Still serving so the other agent can finish. Ctrl+C to stop.');
}

main().catch((error) => {
  log(error instanceof ReputedAgentError ? `${error.code}: ${error.message}${error.transactionId ? ` (${error.transactionId})` : ''}` : `Error: ${(error as Error).message}`);
  process.send?.({ type: 'failed', side });
  process.exit(1);
});
