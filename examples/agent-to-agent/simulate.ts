// A reputation simulation on Hedera testnet. Two teams of agents, each team backed by a different
// verified human (one Reputed API key each), run side by side in this process. Every round each agent
// hires one agent of the other team, all at once: it checks the other agent's score on Reputed, asks
// for the job over HTTP, pays it in HBAR, checks the answer and rates it on-chain. Each agent has a
// persona (steady, sloppy, erratic) that decides how well it does the work, so ratings, and with them
// the agents' scores and their humans' scores, go up and down. Agents that fall below MIN_SCORE stop
// getting hired, except for the odd trial job that lets them earn their way back.
//
//   pnpm simulate            first run: creates and funds the agents, registers and links them
//   pnpm simulate --status   the scoreboard and balances only; sends nothing
//
// Settings and keys are in .env.test (gitignored). Agent keys are generated on the first run and saved
// before any HBAR is sent, so every run drives the same agents and their scores carry over.
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client, PrivateKey } from '@hiero-ledger/sdk';
import { Reputed, ReputedAgentError } from '@reputed/agent-kit';
import { ReputedClient } from '@reputed/sdk';
import { creatorRegistryAbi, grantAddress, HEDERA_TESTNET, type AgentDetail, type ConfigResponse } from '@reputed/shared';
import { createPublicClient, defineChain, getAddress, http, zeroAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { discoverPeer, runJob, type JobOutcome } from './hirer';
import { score as fmt, short, type Log } from './log';
import type { AgentCard } from './protocol';
import { startProvider } from './provider';
import { banner, bold, dim, memberLogger, printScoreboard, simLog, tagOf, teamColor, type BoardRow, type Scores, type Team } from './sim/board';
import { ENV_PATH, SimEnv } from './sim/env';
import { ACCOUNT_CREATE_FEE_HBAR, connectFunder, findAccount, hbar, send, topUpFor, waitForBalance, type Funder } from './sim/funding';
import { behaviorPersona, buildMembers, drawBehavior, drawForms, FORMS, isPersona, MAX_PER_TEAM, pairings, PRICE_HBAR, type Member, type PersonaId, type TeamId } from './sim/team';
import type { Agent } from './types';

const statusOnly = process.argv.includes('--status');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hex = (key: string): Hex => `0x${key.replace(/^0x/, '')}`;

function fail(message: string): never {
  simLog(message);
  process.exit(1);
}

// Settings ------------------------------------------------------------------------------------------

const env = SimEnv.load();
if (env.created) fail(`Created ${ENV_PATH}. Fill in TEAM_A_API_KEY, TEAM_B_API_KEY and FUNDER_KEY, then run pnpm simulate again.`);
const need = (name: string): string => env.get(name) ?? fail(`${name} is not set in ${ENV_PATH}.`);
const integer = (name: string, fallback: number, min: number, max: number): number => {
  const value = env.number(name, fallback);
  if (!Number.isInteger(value) || value < min || value > max) fail(`${name} must be a whole number from ${min} to ${max}.`);
  return value;
};

const apiUrl = (env.get('REPUTED_API_URL') ?? 'http://localhost:4000').replace(/\/+$/, '');
const perTeam = integer('AGENTS_PER_TEAM', 3, 1, MAX_PER_TEAM);
const rounds = integer('ROUNDS', 4, 1, 50);
const minScore = env.number('MIN_SCORE', 60);
const probation = env.number('PROBATION', 0.5);
const fundLimit = env.number('FUND_LIMIT_HBAR', 50);
const swings = !['0', 'false', 'off', 'no'].includes((env.get('SWINGS') ?? '1').toLowerCase());

const members = buildMembers(perTeam, (id) => {
  const persona = env.get(`${id}_PERSONA`);
  if (persona !== undefined && !isPersona(persona)) fail(`${id}_PERSONA must be steady, sloppy or erratic, got "${persona}".`);
  return persona as PersonaId | undefined;
});
const tagWidth = Math.max(...members.map((member) => tagOf(member).length));

// Keys first: a generated key is in .env.test before anything is sent to it.
const keys = new Map(members.map((member) => [member.id, env.agentKey(member.id)]));
const generated = members.filter((member) => keys.get(member.id)!.generated).map((member) => member.id);
const evmOf = (member: Member): Address => privateKeyToAccount(keys.get(member.id)!.key).address;

const stateFile = (member: Member) => fileURLToPath(new URL(`./.reputed/sim-${member.id.toLowerCase()}.json`, import.meta.url));

/** The agent ID and whether onboarding finished, from the agent kit's progress file. */
function savedState(member: Member, config: ConfigResponse): { agentId?: string; onboarded: boolean } {
  const path = stateFile(member);
  if (!existsSync(path) || !config.creatorRegistry) return { onboarded: false };
  try {
    const all = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { agentId?: string; serial?: number }>;
    const prefix = `${config.chainId}:${config.creatorRegistry.toLowerCase()}:`;
    const entry = Object.entries(all).find(([key]) => key.toLowerCase().startsWith(prefix))?.[1];
    return { ...(entry?.agentId ? { agentId: entry.agentId } : {}), onboarded: entry?.serial !== undefined };
  } catch {
    return { onboarded: false };
  }
}

// The deployment and the two humans ---------------------------------------------------------------

const api = new ReputedClient({ apiUrl });
let config: ConfigResponse;
try {
  config = (await (await fetch(`${apiUrl}/api/config`, { signal: AbortSignal.timeout(10_000) })).json()) as ConfigResponse;
} catch {
  fail(`No Reputed server answers at ${apiUrl}. Start it with pnpm dev at the repo root.`);
}
if (!config.creatorRegistry) fail('The Reputed server has no CreatorRegistry configured.');
const registry = getAddress(config.creatorRegistry);

const chain = defineChain({
  id: HEDERA_TESTNET.id,
  name: HEDERA_TESTNET.name,
  nativeCurrency: HEDERA_TESTNET.nativeCurrency,
  rpcUrls: { default: { http: [HEDERA_TESTNET.rpcUrl] } },
});
const rpc = createPublicClient({ chain, transport: http(HEDERA_TESTNET.rpcUrl, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }) });

const apiKeys: Record<TeamId, string> = { A: need('TEAM_A_API_KEY'), B: need('TEAM_B_API_KEY') };
const teams = {} as Record<TeamId, Team & { maxAgents: number; used: number }>;
for (const team of ['A', 'B'] as const) {
  const [creator, expiresAt, maxAgents, used, revoked] = await rpc.readContract({
    address: registry,
    abi: creatorRegistryAbi,
    functionName: 'grants',
    args: [grantAddress(apiKeys[team])],
  });
  if (creator === zeroAddress) fail(`TEAM_${team}_API_KEY was never authorized on CreatorRegistry ${registry}.`);
  if (revoked) fail(`TEAM_${team}_API_KEY was revoked by its creator.`);
  if (Number(expiresAt) * 1000 < Date.now()) fail(`TEAM_${team}_API_KEY has expired.`);
  teams[team] = { name: env.get(`TEAM_${team}_NAME`) ?? `Team ${team}`, creator: getAddress(creator), maxAgents, used };
}
if (teams.A.creator === teams.B.creator) {
  fail('Both API keys belong to the same human. Reviews between agents of one human do not count: use keys from two creators.');
}

function printRoster(): void {
  for (const team of ['A', 'B'] as const) {
    const t = teams[team];
    console.log(`  ${bold(`Team ${team}: ${t.name}`)} ${dim(`creator ${t.creator}, API key used for ${t.used} of ${t.maxAgents} agents`)}`);
    for (const member of members.filter((m) => m.team === team)) {
      const swing = member.form ? `  ${member.form === 'slump' ? '↓' : '↑'} ${FORMS[member.form].summary}` : '';
      console.log(`    ${teamColor(member)(tagOf(member).padEnd(tagWidth))}  sells ${member.skill.padEnd(6)}  ${member.persona.id.padEnd(7)} ${dim(member.persona.summary)}${swing}`);
    }
  }
}

async function scoreboard(title: string, agentIds: Map<string, string>, accounts: Map<string, string>, previous: Scores | null): Promise<Scores> {
  const rows: BoardRow[] = await Promise.all(
    members.map(async (member) => {
      const agentId = agentIds.get(member.id);
      const account = accounts.get(member.id);
      const [detail, balance] = await Promise.all([
        agentId ? api.getAgent(agentId).catch(() => null) : null,
        account ? findAccount(account).catch(() => null) : null,
      ]);
      return { member, detail, hbar: balance ? hbar(balance.tinybar) : null };
    }),
  );
  return printScoreboard(title, rows, teams, previous);
}

// --status ----------------------------------------------------------------------------------------

if (statusOnly) {
  banner('Status');
  printRoster();
  const agentIds = new Map<string, string>();
  const accounts = new Map<string, string>();
  for (const member of members) {
    const state = savedState(member, config);
    if (state.agentId) agentIds.set(member.id, state.agentId);
    const account = await findAccount(evmOf(member));
    if (account) accounts.set(member.id, account.accountId);
  }
  await scoreboard('Scores on Reputed now', agentIds, accounts, null);
  if (agentIds.size < members.length) simLog('Agents without an ID have not been onboarded yet: run pnpm simulate.');
  process.exit(0);
}

// Swings ------------------------------------------------------------------------------------------

if (swings) {
  // Current scores of agents that exist already; a new agent starts at its creator's score.
  const current = new Map(
    await Promise.all(
      members.map(async (member) => {
        const agentId = savedState(member, config).agentId;
        const detail = agentId ? await api.getAgent(agentId).catch(() => null) : null;
        return [member.id, detail?.score.value ?? 100] as const;
      }),
    ),
  );
  for (const [id, form] of drawForms(members, Math.random, (member) => (current.get(member.id) ?? 100) >= minScore)) {
    members.find((member) => member.id === id)!.form = form;
  }
}

// Funding ------------------------------------------------------------------------------------------

console.log(bold('\nReputed agent reputation simulation'));
console.log(
  dim(
    [
      'Each round, every agent hires one agent of the other team, all at the same time. The hirer:',
      `  1. checks the other agent on Reputed: backed by a verified human? scores at least ${minScore}?`,
      '  2. asks for the job over HTTP and gets a 402 quote,',
      `  3. pays it ${PRICE_HBAR} HBAR on Hedera, with the job ID as memo,`,
      '  4. gets the answer once the provider has found the payment on the Mirror Node,',
      '  5. checks the answer itself and rates it on-chain (ERC-8004 giveFeedback, review file on HCS),',
      "  6. waits for Reputed to score the review: the rated agent's score and its human's score move.",
      'Ratings: 95 correct and fast · 80 correct but slow · 20 wrong · 0 paid but nothing delivered.',
      `An agent below ${minScore} is refused, except for a trial job ${Math.round(probation * 100)}% of the time.`,
      ...(swings ? ['Swings: on each team one agent is in a slump this run and another on a streak, so both humans’ scores move both ways.'] : []),
    ].join('\n'),
  ),
);
banner('Agents');
printRoster();
if (generated.length) simLog(`Generated keys for ${generated.join(', ')} and saved them in ${ENV_PATH}.`);

banner('Funding');
const funderKey = need('FUNDER_KEY');
let funder: Funder & { tinybar: bigint };
try {
  funder = await connectFunder(funderKey, privateKeyToAccount(hex(funderKey)).address);
} catch (error) {
  fail((error as Error).message);
}
simLog(`Funder ${funder.accountId} holds ${hbar(funder.tinybar).toFixed(2)} HBAR`);

const funding = await Promise.all(
  members.map(async (member) => {
    const account = await findAccount(evmOf(member));
    const onboarded = account !== null && savedState(member, config).onboarded;
    const balance = account ? hbar(account.tinybar) : 0;
    return { member, account, balance, onboarded, amount: topUpFor(balance, rounds, onboarded) };
  }),
);
const total = funding.reduce((sum, item) => sum + item.amount, 0);
// Creating an account by sending HBAR to its EVM address charges the sender a creation fee on top.
const creationFees = funding.filter((item) => item.account === null).length * ACCOUNT_CREATE_FEE_HBAR;
if (total > fundLimit) fail(`This run would send ${total.toFixed(1)} HBAR, over FUND_LIMIT_HBAR=${fundLimit}. Lower ROUNDS or raise the limit.`);
if (total > 0 && hbar(funder.tinybar) < total + creationFees + 1) {
  fail(`The funder needs ${(total + creationFees + 1).toFixed(1)} HBAR for this run and holds ${hbar(funder.tinybar).toFixed(2)}.`);
}

const accounts = new Map<string, string>();
await Promise.all(
  funding.map(async ({ member, account, balance, onboarded, amount }) => {
    const log = memberLogger(member, tagWidth);
    if (amount === 0) {
      log(`Account ${account!.accountId} holds ${balance.toFixed(2)} HBAR: enough for ${rounds} rounds`);
      accounts.set(member.id, account!.accountId);
      return;
    }
    const why = !account ? 'new agent: creating its account' : onboarded ? `holds ${balance.toFixed(2)} HBAR` : `holds ${balance.toFixed(2)} HBAR and still has to onboard`;
    const txId = await send(funder, account ? { accountId: account.accountId } : { evmAddress: evmOf(member) }, amount, `Reputed simulation: fund ${member.id}`);
    log(`${why}; the funder sent ${amount.toFixed(1)} HBAR (${txId})`);
    const funded = await waitForBalance(evmOf(member), BigInt(Math.round((balance + amount) * 1e8)) - 1_000n);
    accounts.set(member.id, funded.accountId);
  }),
);
if (total > 0) simLog(`Sent ${total.toFixed(1)} HBAR in all${creationFees ? `, plus about ${creationFees.toFixed(1)} HBAR in account creation fees` : ''}.`);
funder.client.close();

// Onboarding ---------------------------------------------------------------------------------------

banner('Onboarding: register on ERC-8004, link to the human behind the API key, receive the credential');

interface Sim {
  member: Member;
  log: Log;
  accountId: string;
  client: Client;
  reputed: Reputed;
  agent: Agent;
  server?: Server;
  cards: Map<string, AgentCard>;
}

/** Reviews in flight at once. The server publishes at most 4 review files at a time (REVIEW_MAX_CONCURRENT). */
const reviewSlots = slots(3);

function slots(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve)); // the slot is handed over, not re-counted
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** The server answers "at capacity" or "too many requests" before anything is published or sent, so a retry is safe. */
async function retryWhenBusy<T>(work: () => Promise<T>, log: Log): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const busy = error instanceof ReputedAgentError && error.code === 'API_ERROR' && /retry in|too many|capacity/i.test(error.message);
      if (!busy || attempt >= 6) throw error;
      log(`Reputed is busy (${error.message}) Trying again in 5 s.`);
      await sleep(5_000);
    }
  }
}

const errorText = (error: unknown) => (error instanceof ReputedAgentError ? `${error.code}: ${error.message}` : (error as Error).message);

const connected = await Promise.allSettled(
  members.map(async (member): Promise<Sim> => {
    const log = memberLogger(member, tagWidth);
    const accountId = accounts.get(member.id)!;
    const client = Client.forTestnet().setOperator(accountId, PrivateKey.fromStringECDSA(keys.get(member.id)!.key.slice(2)));
    try {
      const reputed = await Reputed.connect({
        client,
        apiKey: apiKeys[member.team],
        apiUrl,
        agent: { name: member.name, description: member.role.description, endpoints: { a2a: member.url }, tags: ['simulation', member.skill] },
        state: stateFile(member),
        logger: (message) => log(dim(message)),
      });
      log(`Agent #${reputed.agentId} on account ${accountId}, backed by ${teams[member.team].name} (${short(reputed.creator)})`);
      const agent: Agent = {
        agentId: reputed.agentId,
        owner: reputed.owner,
        creator: reputed.creator,
        accountId,
        reputation: () => reputed.reputation(),
        verifyCounterparty: (id, options) => reputed.verifyCounterparty(id, options),
        pay: (id, amount, options) => reputed.pay(id, amount, options),
        verifyPayment: (txId, options) => reputed.verifyPayment(txId, options),
        review: (id, input) => reviewSlots(() => retryWhenBusy(() => reputed.review(id, input), log)),
        waitForReview: (receipt, options) => reputed.waitForReview(receipt, options),
      };
      return { member, log, accountId, client, reputed, agent, cards: new Map() };
    } catch (error) {
      log(`Onboarding failed: ${errorText(error)}`);
      client.close();
      throw error;
    }
  }),
);
const failed = connected.filter((result) => result.status === 'rejected').length;
const sims = connected.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
function shutdown(code: number): never {
  for (const sim of sims) {
    sim.server?.close();
    sim.client.close();
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(130));
if (failed) {
  simLog(`${failed} agent(s) could not onboard. Run pnpm simulate again: onboarding carries on where it stopped.`);
  shutdown(1);
}
const simOf = new Map(sims.map((sim) => [sim.member.id, sim]));
const agentIds = new Map(sims.map((sim) => [sim.member.id, sim.reputed.agentId]));

// The server indexes a new link a few seconds after it lands; until then the agent is not human-backed.
await Promise.all(
  sims.map(async (sim) => {
    for (let i = 0; ; i++) {
      const me = await sim.reputed.reputation().catch(() => null);
      if (me?.humanBacked) return;
      if (i === 0) sim.log('Waiting for Reputed to index the link to its human…');
      if (i >= 60) {
        sim.log('Reputed still does not show this agent as human-backed after 4 minutes. Is the server indexing?');
        shutdown(1);
      }
      await sleep(4_000);
    }
  }),
);

// Serving and discovery ----------------------------------------------------------------------------

banner('Agents open for business');
for (const sim of sims) {
  try {
    sim.server = await startProvider({
      agent: sim.agent,
      role: sim.member.role,
      url: sim.member.url,
      port: sim.member.port,
      faultyJobs: new Set(),
      behavior: () => drawBehavior(behaviorPersona(sim.member)),
      log: sim.log,
    });
  } catch (error) {
    sim.log(`Cannot serve on port ${sim.member.port}: ${(error as Error).message}. Is another simulation running?`);
    shutdown(1);
  }
  sim.log(`Serving ${sim.member.skill} at ${sim.member.url} for ${PRICE_HBAR} HBAR a job`);
}

// Each agent reads the other team's cards and checks them against Reputed: the owner on the card must
// own that agent ID, and the agent must have registered this very URL.
await Promise.all(
  sims.map(async (sim) => {
    const peers = sims.filter((peer) => peer.member.team !== sim.member.team);
    for (const peer of peers) {
      const { card } = await discoverPeer({ agent: sim.agent, peerRole: peer.member.role, peerUrl: peer.member.url, rounds, minScore: 0, log: sim.log, discoverTimeoutMs: 60_000 });
      sim.cards.set(peer.member.id, card);
    }
    sim.log(`Read and checked the cards of ${peers.map((peer) => `${peer.member.id} #${peer.reputed.agentId}`).join(', ')}: owners and endpoints match Reputed`);
  }),
);

const startBalances = new Map<string, number>();
for (const sim of sims) {
  const account = await findAccount(sim.accountId).catch(() => null);
  if (account) startBalances.set(sim.member.id, hbar(account.tinybar));
}
const start = await scoreboard('Scoreboard before round 1', agentIds, accounts, null);

// Rounds -------------------------------------------------------------------------------------------

interface JobResult {
  hirer: Sim;
  provider: Sim;
  kind: 'rated' | 'refused' | 'failed';
  trial: boolean;
  value?: number;
  counted?: boolean;
  reason?: string;
}

const RATING_LABELS: Record<number, string> = { 95: 'correct and fast', 80: 'correct but slow', 20: 'WRONG answer', 0: 'paid, nothing delivered (misconduct)' };

async function hire(hirer: Sim, provider: Sim, round: number): Promise<JobResult> {
  const card = hirer.cards.get(provider.member.id)!;
  const peer = `${tagOf(provider.member)} #${card.reputed.agentId}`;
  let trial = false;
  try {
    const gate = await hirer.agent.verifyCounterparty(card.reputed.agentId, { humanBackedOnly: true, minScore });
    if (gate.ok) {
      hirer.log(`Round ${round}: hiring ${peer}, which scores ${fmt(gate.agent.score.value)} (${gate.agent.score.tier})`);
    } else if (gate.reason === 'SCORE_TOO_LOW' && Math.random() < probation) {
      trial = true;
      hirer.log(`Round ${round}: ${peer} scores ${fmt(gate.agent.score.value)}, below ${minScore}. Giving it a trial job anyway`);
    } else {
      hirer.log(`Round ${round}: NOT hiring ${peer}. ${gate.message}`);
      return { hirer, provider, kind: 'refused', trial, reason: gate.message };
    }
    // minScore 0: the gate above has already decided.
    const outcome: JobOutcome = await runJob({ agent: hirer.agent, peerRole: provider.member.role, peerUrl: provider.member.url, rounds, minScore: 0, log: hirer.log }, card, round);
    if (outcome.kind === 'rated') return { hirer, provider, kind: 'rated', trial, value: outcome.value, counted: outcome.counted, ...(outcome.exclusionReason ? { reason: outcome.exclusionReason } : {}) };
    return { hirer, provider, kind: outcome.kind, trial, reason: outcome.reason };
  } catch (error) {
    hirer.log(`Round ${round}: the job for ${peer} failed: ${errorText(error)}`);
    return { hirer, provider, kind: 'failed', trial, reason: errorText(error) };
  }
}

function describe(result: JobResult): string {
  const who = `${tagOf(result.hirer.member)} → ${tagOf(result.provider.member)}`.padEnd(tagWidth * 2 + 3);
  const trial = result.trial ? ' (trial job)' : '';
  if (result.kind === 'refused') return `${who}  refused: ${result.reason}`;
  if (result.kind === 'failed') return `${who}  failed${trial}: ${result.reason}`;
  const counted = result.counted ? '' : `, NOT counted (${result.reason})`;
  return `${who}  rated ${String(result.value).padStart(2)}/100${trial}: ${RATING_LABELS[result.value!] ?? ''}${counted}`;
}

const results: JobResult[] = [];
let previous = start;
for (let round = 1; round <= rounds; round++) {
  const pairs = pairings(perTeam, round);
  banner(`Round ${round} of ${rounds}: ${pairs.length} jobs at the same time`);
  simLog(`Hirer → hired: ${pairs.map((pair) => `${pair.hirer} → ${pair.provider}`).join(', ')}`);
  const roundResults = await Promise.all(pairs.map((pair) => hire(simOf.get(pair.hirer)!, simOf.get(pair.provider)!, round)));
  results.push(...roundResults);
  console.log(bold(`\n  Round ${round}: what happened`));
  for (const result of roundResults) console.log(`  ${describe(result)}`);
  previous = await scoreboard(`Scoreboard after round ${round}`, agentIds, accounts, previous);
}

// Result -------------------------------------------------------------------------------------------

banner('Result');
const end = await Promise.all(
  sims.map(async (sim) => {
    const [detail, account] = await Promise.all([api.getAgent(sim.reputed.agentId).catch(() => null), findAccount(sim.accountId).catch(() => null)]);
    return { sim, detail, hbar: account ? hbar(account.tinybar) : null };
  }),
);
for (const { sim, detail, hbar: balance } of end) {
  const before = start.agents.get(sim.member.id);
  const after = detail?.score.value;
  const was = startBalances.get(sim.member.id);
  sim.log(
    `score ${fmt(before)} → ${bold(fmt(after))} (${detail?.score.tier ?? '—'}), ${detail?.reviewsCounted ?? '—'} counted review(s) · HBAR ${was?.toFixed(2) ?? '—'} → ${balance?.toFixed(2) ?? '—'}`,
  );
}
for (const team of Object.values(teams)) {
  const key = team.creator.toLowerCase();
  const after = end.find((item) => item.detail?.creator?.toLowerCase() === key)?.detail?.creatorScore;
  const before = start.creators.get(key);
  const moved = after !== undefined && after !== null && before !== undefined ? ` (${after >= before ? '+' : ''}${(after - before).toFixed(2)})` : '';
  simLog(`Creator ${team.name} (${short(team.creator)}): ${fmt(before)} → ${bold(fmt(after))}${moved}`);
}
const rated = results.filter((result) => result.kind === 'rated');
const tally = (value: number) => rated.filter((result) => result.value === value).length;
simLog(
  `${results.length} jobs: ${rated.length} rated (${tally(95)} correct and fast, ${tally(80)} slow, ${tally(20)} wrong, ${tally(0)} not delivered), ` +
    `${results.filter((result) => result.kind === 'refused').length} refused, ${results.filter((result) => result.trial).length} trial jobs, ${results.filter((result) => result.kind === 'failed').length} failed`,
);
simLog(`Run it again and the same agents carry on from these scores. pnpm simulate --status shows them without running jobs.`);
shutdown(0);
