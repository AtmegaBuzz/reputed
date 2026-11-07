import {
  HEDERA_TESTNET,
  hashscan,
  type Address,
  type AgentDetail,
  type AgentInteractions,
  type AgentListResponse,
  type AgentStatus,
  type AgentSummary,
  type ConfigResponse,
  type Credential,
  type CreatorDetail,
  type CreatorGrantsResponse,
  type GrantSummary,
  type Review,
  type ReviewResponse,
} from '@reputed/shared';
// Read API over the live view. Everything here derives from ScorerRuntime.view(), which is
// local state: only a 'cold' lookup of an agent nobody linked or asked for before reaches the
// Mirror Node, and that path is rationed per IP and per process (createLookupGate).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiHttpError, badRequest, chainError } from '../errors.ts';
import type { AgentProfile } from '../indexer/agentFile.ts';
import { feedbackKey, type GrantRecord } from '../indexer/fold.ts';
import { agentInput, unlinkedCreatorAgents } from '../indexer/inputs.ts';
import type { LiveView, ScorerRuntime } from '../indexer/runtime.ts';
import {
  byIp,
  createLookupGate,
  DEFAULT_RATE_LIMITS,
  limiter,
  type RateLimits,
} from '../routes/rateLimits.ts';
import { interactionsOf } from './interactions.ts';
import { nextHalvingAt } from './misconduct.ts';
import { toIso } from './time.ts';
import { hashscanTxId } from './txid.ts';
import type { AgentResult, ClassifiedReview } from './types.ts';
import { agentWalletAt, ownerAt } from './wallets.ts';

const notFound = (what: string) => new ApiHttpError(404, 'NOT_FOUND', `${what} not found.`);

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  humanBacked: z.enum(['true', 'false']).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  owner: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((owner) => owner.toLowerCase())
    .optional(),
});

function currentWallet(view: LiveView, agentId: string): Address | null {
  return view.state.identities.get(agentId)?.walletHistory.at(-1)?.wallet ?? null;
}

function operatorChanged(view: LiveView, agentId: string): boolean {
  const link = view.state.links.get(agentId);
  const owner = view.state.identities.get(agentId)?.owner;
  return Boolean(link && owner && owner !== link.owner);
}

/** A compromise report wins over a transfer: the SDK's payment gate stops on this value. */
function statusOf(view: LiveView, agentId: string): AgentStatus {
  if (view.state.compromisedAt.has(agentId)) return 'compromised';
  return operatorChanged(view, agentId) ? 'operator-changed' : 'active';
}

/** A report on any agent recorded on the wallet voids it, unless it is a creator wallet. */
function walletVoided(view: LiveView, wallet: Address): boolean {
  if (view.state.creators.has(wallet)) return false;
  return [...view.state.links.values()].some(
    (link) =>
      view.state.compromisedAt.has(link.agentId) &&
      link.wallets.some((vouched) => vouched.wallet === wallet),
  );
}

/** The agent-level answer to CreatorRegistry.isHumanBacked, so the badge never outlives the link. */
function isHumanBacked(view: LiveView, agentId: string): boolean {
  const link = view.state.links.get(agentId);
  const wallet = currentWallet(view, agentId);
  return (
    link !== undefined &&
    wallet !== null &&
    !view.state.compromisedAt.has(agentId) &&
    !operatorChanged(view, agentId) &&
    link.wallets.some((vouched) => vouched.wallet === wallet) &&
    !walletVoided(view, wallet)
  );
}

function profileOf(runtime: ScorerRuntime, view: LiveView, agentId: string): AgentProfile {
  return runtime.agentProfile(view.state.identities.get(agentId)?.agentUri ?? '');
}

function toSummary(
  runtime: ScorerRuntime,
  view: LiveView,
  result: AgentResult,
  profile: AgentProfile,
): AgentSummary {
  const { agentId, creator } = result;
  const identity = view.state.identities.get(agentId);
  const registeredAt = identity?.registeredAt ?? view.state.links.get(agentId)?.linkedAt;
  const creatorResult = creator
    ? view.result.creators.find((item) => item.creator === creator)
    : undefined;
  return {
    agentId,
    name: profile.name ?? `Agent #${agentId}`,
    description: profile.description ?? '',
    ...(profile.image ? { image: profile.image } : {}),
    tags: profile.tags,
    owner: identity?.owner ?? creator ?? ZERO_ADDRESS,
    wallet: currentWallet(view, agentId),
    creator,
    humanBacked: isHumanBacked(view, agentId),
    score: { value: result.score, tier: result.tier, isNew: result.isNew },
    creatorScore: creatorResult?.score ?? null,
    reviewsCounted: result.counted,
    registeredAt: registeredAt ? toIso(registeredAt) : toIso(view.asOf),
    acceptsX402: profile.acceptsX402,
    status: statusOf(view, agentId),
  };
}

/** Anyone can append a response on-chain, so only the agent's own owner or wallet is shown. */
function responseTo(view: LiveView, review: ClassifiedReview): ReviewResponse | undefined {
  const agent = agentInput(view.state, review.agentId);
  const key = feedbackKey(review.agentId, review.client, review.feedbackIndex);
  const fromAgent = (view.state.responses.get(key) ?? []).filter(
    ({ responder, timestamp }) =>
      responder === ownerAt(agent, timestamp) || responder === agentWalletAt(agent, timestamp),
  );
  const latest = fromAgent.at(-1);
  if (!latest) return undefined;
  const { responder, uri, hash, timestamp } = latest;
  return { responder, uri, hash, createdAt: toIso(timestamp) };
}

function toReview(view: LiveView, review: ClassifiedReview): Review {
  const response = responseTo(view, review);
  return {
    clientAddress: review.client,
    feedbackIndex: review.feedbackIndex,
    value: review.normalizedValue ?? Number(review.value) / 10 ** review.valueDecimals,
    tag1: review.tag1,
    tag2: review.tag2,
    endpoint: review.endpoint,
    ...(review.comment !== undefined ? { comment: review.comment } : {}),
    createdAt: toIso(review.timestamp),
    paymentVerified: review.paymentVerified,
    counted: review.counted,
    ...(review.exclusionReason ? { exclusionReason: review.exclusionReason } : {}),
    reviewerHumanBacked: review.reviewerHumanBacked,
    feedbackUri: review.feedbackUri,
    txId: hashscanTxId(review.txHash, review.timestamp),
    ...(response ? { response } : {}),
  };
}

function credentialsOf(runtime: ScorerRuntime, view: LiveView, agentId: string): Credential[] {
  const link = view.state.links.get(agentId);
  const wallet = currentWallet(view, agentId) ?? link?.wallets.at(-1)?.wallet;
  // linkAgent and syncAgentWallet both vouch through _vouchFor, with the same human-backed metadata.
  const ownSerials = new Set(link?.wallets.map((vouched) => vouched.serial));
  const vouchSerials = new Set(
    [...view.state.links.values()].flatMap((item) => item.wallets.map(({ serial }) => serial)),
  );
  // A credential event can only come from the registry, so this is set whenever one exists.
  const issuer = (runtime.settings.creatorRegistry?.toLowerCase() ?? ZERO_ADDRESS) as Address;

  return view.state.credentials
    .filter(
      (credential) =>
        ownSerials.has(credential.serial) ||
        (credential.holder === wallet && !vouchSerials.has(credential.serial)),
    )
    .map((credential) => ({
      tokenId: runtime.settings.credentialTokenId ?? '',
      serial: credential.serial,
      kind: ownSerials.has(credential.serial) ? 'human-backed' : 'milestone',
      title: ownSerials.has(credential.serial) ? 'Human-backed' : `Credential #${credential.serial}`,
      issuedAt: toIso(credential.issuedAt),
      revoked: credential.revokedAt !== null,
      issuer,
      // A consensus timestamp opens the minting transaction on HashScan.
      txId: credential.issuedAt,
    }));
}

function agentDetail(runtime: ScorerRuntime, view: LiveView, result: AgentResult): AgentDetail {
  const { agentId } = result;
  const profile = profileOf(runtime, view, agentId);
  const compromisedAt = view.state.compromisedAt.get(agentId);
  const published = runtime.store.latestPublishedSnapshot();
  const registeredAt = view.state.identities.get(agentId)?.registeredAt;
  return {
    ...toSummary(runtime, view, result, profile),
    endpoints: profile.endpoints,
    agentUri: view.state.identities.get(agentId)?.agentUri ?? '',
    ...(registeredAt ? { registrationTxId: registeredAt } : {}),
    operatorChanged: operatorChanged(view, agentId),
    ...(compromisedAt ? { compromisedAt: toIso(compromisedAt) } : {}),
    credentials: credentialsOf(runtime, view, agentId),
    reviews: view.result.reviews
      .filter((review) => review.agentId === agentId)
      .map((review) => toReview(view, review))
      .reverse(),
    reviewsExcluded: result.excluded,
    penaltiesConfirmed: result.penaltiesConfirmed,
    updatedAt: toIso(view.asOf),
    ...(published ? { snapshotUrl: hashscan.topic(runtime.settings.scoresTopicId) } : {}),
    scoresStale: runtime.scoresStale(),
  };
}

function matches(summary: AgentSummary, query: string): boolean {
  const needle = query.toLowerCase();
  return [summary.name, summary.description, ...summary.tags].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

function listAgents(
  runtime: ScorerRuntime,
  view: LiveView | null,
  query: z.output<typeof listQuery>,
): AgentListResponse {
  const scoresStale = runtime.scoresStale();
  if (!view) {
    const stats = { agents: 0, humanBacked: 0, creators: 0, reviewsCounted: 0 };
    return { agents: [], stats, scoresStale };
  }
  // creator === null tells onboarding to resume at the Link step, and linkAgent needs a creator.
  const ownerCanLink = query.owner !== undefined && view.state.creators.has(query.owner as Address);
  // Lookups also add unlinked agents to the view, and a visit must not change this list.
  const unlinked = new Set(unlinkedCreatorAgents(view.state));
  const all = view.result.agents
    .filter((result) => result.creator !== null || unlinked.has(result.agentId))
    .map((result) => toSummary(runtime, view, result, profileOf(runtime, view, result.agentId)));
  const agents = all
    .filter((agent) => !query.q || matches(agent, query.q))
    // Web sends false when its toggle is off and expects every agent, so only true filters.
    .filter((agent) => query.humanBacked !== 'true' || agent.humanBacked)
    .filter((agent) => query.minScore === undefined || agent.score.value >= query.minScore)
    .filter(
      (agent) =>
        query.owner === undefined ||
        (agent.owner === query.owner && (agent.creator !== null || ownerCanLink)),
    )
    .sort((a, b) => b.score.value - a.score.value);

  return {
    agents,
    stats: {
      agents: all.length,
      humanBacked: all.filter((agent) => agent.humanBacked).length,
      creators: view.result.creators.length,
      reviewsCounted: all.reduce((total, agent) => total + agent.reviewsCounted, 0),
    },
    scoresStale,
  };
}

function creatorDetail(runtime: ScorerRuntime, view: LiveView, address: Address): CreatorDetail {
  const creator = view.result.creators.find((item) => item.creator === address);
  const registered = view.state.creators.get(address);
  if (!creator || !registered) throw notFound('Creator');
  return {
    address,
    verifiedAt: toIso(registered.registeredAt),
    score: creator.score,
    tier: creator.tier,
    penaltyTotal: creator.P,
    penalties: creator.penalties.map(({ agentId, category, points, confirmedAt, reports }) => ({
      agentId,
      category,
      points,
      confirmedAt: toIso(confirmedAt),
      nextHalvingAt: toIso(nextHalvingAt(confirmedAt, runtime.now(), runtime.config)),
      reports: reports.map(({ client, feedbackIndex, txHash, timestamp }) => ({
        clientAddress: client,
        feedbackIndex,
        txId: hashscanTxId(txHash, timestamp),
      })),
    })),
    agents: view.result.agents
      .filter((agent) => agent.creator === address)
      .map((result) => toSummary(runtime, view, result, profileOf(runtime, view, result.agentId))),
  };
}

const toGrantSummary = (
  runtime: ScorerRuntime,
  view: LiveView,
  grant: GrantRecord,
): GrantSummary => {
  const linked = [...view.state.links.values()].filter((link) => link.grantKey === grant.grantKey);
  const results = linked
    .map((link) => view.result.agents.find((agent) => agent.agentId === link.agentId))
    .filter((result): result is AgentResult => result !== undefined);
  return {
    grantKey: grant.grantKey,
    creator: grant.creator,
    authorizedAt: toIso(grant.authorizedAt),
    expiresAt: new Date(grant.expiresAt * 1000).toISOString(),
    maxAgents: grant.maxAgents,
    used: linked.length,
    revoked: grant.revokedAt !== null,
    // Judged on consensus time, like everything else in the view, so it can be replayed.
    expired: grant.expiresAt <= Number(view.asOf.split('.')[0]),
    agents: results.map((result) => toSummary(runtime, view, result, profileOf(runtime, view, result.agentId))),
  };
};

export function registerReadRoutes(
  app: FastifyInstance,
  runtime: ScorerRuntime,
  rateLimits: RateLimits = DEFAULT_RATE_LIMITS,
): void {
  const listLimit = limiter(app, rateLimits.agentListByIp, byIp('agents'));
  const agentLimit = limiter(app, rateLimits.agentByIp, byIp('agent'));
  const creatorLimit = limiter(app, rateLimits.creatorByIp, byIp('creator'));
  const lookupLimit = limiter(app, rateLimits.agentLookupByIp, byIp('agent-lookup'));
  const lookupGate = createLookupGate(rateLimits.agentLookupTotal);

  /** Joining a lookup already under way costs the mirror nothing, so it spends no allowance. */
  async function lookUp(req: FastifyRequest, agentId: string): Promise<void> {
    if (!runtime.isLookingUp(agentId)) await lookupLimit(req);
    // Asked again: the limiter yields, and the visitor ahead may have started this lookup meanwhile.
    const release = runtime.isLookingUp(agentId) ? undefined : lookupGate.acquire();
    try {
      if (!(await runtime.trackAgent(agentId))) throw notFound('Agent');
    } catch (err) {
      if (err instanceof ApiHttpError) throw err;
      req.log.error({ err: (err as Error).name }, 'agent lookup failed');
      throw chainError('Could not read this agent from the Mirror Node. Try again.');
    } finally {
      release?.();
    }
  }

  app.get('/api/agents', async (req): Promise<AgentListResponse> => {
    await listLimit(req);
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join('.') || 'query';
      throw badRequest(`Invalid query: check "${field}".`);
    }
    return listAgents(runtime, runtime.view(), parsed.data);
  });

  app.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId',
    async (req): Promise<AgentDetail> => {
      await agentLimit(req);
      const { agentId } = req.params;
      if (!/^\d{1,78}$/.test(agentId)) throw notFound('Agent');
      const id = BigInt(agentId).toString();

      const lookup = runtime.agentLookup(id);
      if (lookup === 'missing') throw notFound('Agent');
      if (lookup === 'cold') await lookUp(req, id);

      const view = runtime.view();
      const result = view?.result.agents.find((agent) => agent.agentId === id);
      if (!view || !result) throw notFound('Agent');
      return agentDetail(runtime, view, result);
    },
  );

  /** Agents this agent reviewed or was reviewed by: the graph on the agent page. */
  app.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/interactions',
    async (req): Promise<AgentInteractions> => {
      await agentLimit(req);
      const { agentId } = req.params;
      if (!/^\d{1,78}$/.test(agentId)) throw notFound('Agent');
      const id = BigInt(agentId).toString();
      const view = runtime.view();
      // Only agents already in the view: this route never starts a Mirror Node lookup.
      if (!view || !view.result.agents.some((agent) => agent.agentId === id)) throw notFound('Agent');
      return interactionsOf(view, id, (peerId) => {
        const result = view.result.agents.find((agent) => agent.agentId === peerId);
        return result ? toSummary(runtime, view, result, profileOf(runtime, view, peerId)) : null;
      });
    },
  );

  app.get<{ Params: { address: string } }>(
    '/api/creators/:address',
    async (req): Promise<CreatorDetail> => {
      await creatorLimit(req);
      const address = req.params.address.toLowerCase();
      const view = runtime.view();
      if (!view || !/^0x[0-9a-f]{40}$/.test(address)) throw notFound('Creator');
      return creatorDetail(runtime, view, address as Address);
    },
  );

  app.get<{ Params: { address: string } }>(
    '/api/creators/:address/grants',
    async (req): Promise<CreatorGrantsResponse> => {
      await creatorLimit(req);
      const address = req.params.address.toLowerCase();
      const view = runtime.view();
      if (!view || !/^0x[0-9a-f]{40}$/.test(address)) throw notFound('Creator');
      const grants = [...view.state.grants.values()]
        .filter((grant) => grant.creator === address)
        .map((grant) => toGrantSummary(runtime, view, grant));
      return { grants };
    },
  );

  const configLimit = limiter(app, rateLimits.agentListByIp, byIp('config'));
  app.get('/api/config', async (req): Promise<ConfigResponse> => {
    await configLimit(req);
    const { identityRegistry, creatorRegistry, credentialTokenId, mirrorNode } = runtime.settings;
    return {
      network: 'hedera-testnet',
      chainId: HEDERA_TESTNET.id,
      identityRegistry: identityRegistry.toLowerCase() as Address,
      creatorRegistry: (creatorRegistry?.toLowerCase() as Address | undefined) ?? null,
      credentialTokenId,
      mirrorNode,
    };
  });
}
