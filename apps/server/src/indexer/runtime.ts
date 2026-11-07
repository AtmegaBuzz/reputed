import { SCORING_CONFIG, type ScoringConfig } from '../scoring/config.ts';
import { computeScores } from '../scoring/score.ts';
import { buildSnapshot, computeInputsHash, epochEnd, epochOf } from '../scoring/snapshot.ts';
import { compareConsensus, fromMillis, toNanos, type ConsensusTimestamp } from '../scoring/time.ts';
import type { ScoreResult, Snapshot } from '../scoring/types.ts';
import { parseAgentProfile, type AgentProfile } from './agentFile.ts';
import { enrichState } from './enrich.ts';
import { foldEvents, type ChainState } from './fold.ts';
import { ingestAll, type LogSource } from './ingest.ts';
import { buildInputs, scoringScope, unlinkedCreatorAgents } from './inputs.ts';
import { MirrorClient } from './mirror.ts';
import { loadScorerSettings, type ScorerSettings } from './settings.ts';
import { Store } from './store.ts';

const LIVE_AS_OF = 'live_as_of';
const STALE_AFTER_EPOCHS = 2;
const MAX_TRACKED_AGENTS = 256;
// Anyone can pile reviews onto a shared-registry agent, so neither a request nor a sync may be
// made to read all of them at once. What is left over waits for a later sync.
const LOOKUPS_PER_REQUEST = 10;
const LOOKUPS_PER_SYNC = 10;
const MAX_CACHED_PROFILES = 4_096;

export type AgentLookup = 'missing' | 'ready' | 'cold';

export interface LiveView {
  asOf: ConsensusTimestamp;
  state: ChainState;
  result: ScoreResult;
}

export interface BuiltEpoch {
  snapshot: Snapshot;
  /** Reviews whose facts are not cached yet: the epoch must not be published until this is 0. */
  pending: number;
}

export interface RuntimeDeps {
  store: Store;
  mirror: MirrorClient;
  settings: ScorerSettings;
  config?: ScoringConfig;
  fetch?: typeof fetch;
  /** Wall clock in milliseconds. */
  now?: () => number;
  maxTrackedAgents?: number;
}

/**
 * Two views of one pure computation. The epoch snapshot uses a fixed boundary and only linked
 * agents, so anyone can reproduce it. The live view uses the mirror's latest consensus time and
 * also agents someone asked for, so a new review shows on the page before the next epoch.
 */
export class ScorerRuntime {
  readonly store: Store;
  readonly mirror: MirrorClient;
  readonly settings: ScorerSettings;
  readonly config: ScoringConfig;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly clock: () => number;
  private readonly maxTrackedAgents: number;
  private live: LiveView | null = null;
  /** Told about every new live view, so /api/events can push changes instead of clients polling. */
  private readonly liveListeners = new Set<(view: LiveView) => void>();
  /** Reviews whose last lookup failed: held out of both views until a sync resolves them. */
  private unresolved: Set<string> = new Set();
  /** Lookups under way, so visitors to one agent share one set of Mirror reads. */
  private readonly lookups = new Map<string, Promise<boolean>>();
  private readonly profiles = new Map<string, AgentProfile>();

  constructor(deps: RuntimeDeps) {
    this.store = deps.store;
    this.mirror = deps.mirror;
    this.settings = deps.settings;
    this.config = deps.config ?? SCORING_CONFIG;
    this.fetchImpl = deps.fetch;
    this.clock = deps.now ?? Date.now;
    this.maxTrackedAgents = deps.maxTrackedAgents ?? MAX_TRACKED_AGENTS;

    const { identityRegistry, reputationRegistry, creatorRegistry } = this.settings;
    const addresses = [
      ['identity', identityRegistry],
      ['reputation', reputationRegistry],
      ['creatorRegistry', creatorRegistry],
    ] as const;
    for (const [source, address] of addresses) {
      if (this.store.bindSource(source, address)) {
        console.warn(`scorer: the ${source} address changed, re-reading its events from the start`);
      }
    }
    // Saved, so a scorer that keeps restarting cannot keep earning a fresh grace period.
    if (!this.store.getMeta(this.watchKey())) this.store.setMeta(this.watchKey(), this.now());
  }

  private watchKey(): string {
    return `scores_watched_from:${this.config.configVersion}:${this.config.epochSeconds}`;
  }

  /** The wall clock, as a consensus timestamp. */
  now(): ConsensusTimestamp {
    return fromMillis(this.clock());
  }

  /**
   * Measured on the wall clock: a dead scorer stops moving the mirror's time, so scores would never
   * age against it. Only this series counts, since another series' epoch numbers are not comparable.
   *
   * With nothing published yet, the same two epochs run from when this cache first saw the series.
   * That gives a fresh deployment its grace period, and then reports a scorer that has never
   * published as stale for good. A wiped cache starts the wait again, until the first sync restores
   * the latest snapshot from the topic.
   */
  scoresStale(): boolean {
    const now = this.now();
    const latest = this.store.latestPublishedSnapshot(this.config);
    if (latest) return epochOf(now, this.config) - latest.epoch >= STALE_AFTER_EPOCHS;
    const waited = toNanos(now) - toNanos(this.store.getMeta(this.watchKey())!);
    return waited >= BigInt(STALE_AFTER_EPOCHS * this.config.epochSeconds) * 1_000_000_000n;
  }

  /** Agents scored in the live view only. */
  private extraAgentIds(state: ChainState): string[] {
    return [...this.store.trackedAgents(), ...unlinkedCreatorAgents(state)];
  }

  private sources(): LogSource[] {
    const { identityRegistry, reputationRegistry, creatorRegistry } = this.settings;
    return [
      { source: 'identity', address: identityRegistry },
      { source: 'reputation', address: reputationRegistry },
      ...(creatorRegistry
        ? [{ source: 'creatorRegistry' as const, address: creatorRegistry }]
        : []),
    ];
  }

  private enrichOptions(asOf: ConsensusTimestamp) {
    return {
      asOf,
      epochBoundary: epochEnd(epochOf(asOf, this.config), this.config),
      reviewsTopicId: this.settings.reviewsTopicId,
      ipfsGateway: this.settings.ipfsGateway,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    };
  }

  /**
   * Reads the mirror's consensus time before ingesting, so every log at or below the returned time
   * has been seen. Throws when the mirror is down, leaving the previous view in place. A failure
   * on one review does not throw: it holds that review, and so any epoch needing it, back.
   */
  async sync(): Promise<ConsensusTimestamp> {
    const asOf = await this.mirror.latestConsensusTimestamp();
    await ingestAll(this.store, this.mirror, this.sources());

    const state = foldEvents(this.store.eventsUpTo(asOf));
    const linked = scoringScope(state);
    const extras = new Set(this.extraAgentIds(state).filter((agentId) => !linked.has(agentId)));
    const options = this.enrichOptions(asOf);
    const failed = await enrichState(this.store, this.mirror, state, linked, options);
    const held = await enrichState(this.store, this.mirror, state, extras, {
      ...options,
      maxLookups: LOOKUPS_PER_SYNC,
    });
    this.unresolved = new Set([...failed, ...held]);

    this.refreshLive(asOf);
    return asOf;
  }

  /**
   * The SDK's payment gate reads status from this view, so it only ever moves forward. A lookup that
   * began before a sync must not bring back the time before a compromise report the sync found.
   */
  private refreshLive(asOf: ConsensusTimestamp): void {
    const current = this.store.getMeta(LIVE_AS_OF);
    const newest = current && compareConsensus(current, asOf) > 0 ? current : asOf;
    this.store.setMeta(LIVE_AS_OF, newest);
    this.live = this.buildLive(newest);
    for (const listener of this.liveListeners) {
      try {
        listener(this.live);
      } catch {
        // A listener's failure must not stop the sync that refreshed the view.
      }
    }
  }

  /** Calls `listener` with each new live view. Returns the function that stops it. */
  onLiveView(listener: (view: LiveView) => void): () => void {
    this.liveListeners.add(listener);
    return () => this.liveListeners.delete(listener);
  }

  private buildLive(asOf: ConsensusTimestamp): LiveView {
    const state = foldEvents(this.store.eventsUpTo(asOf));
    const { inputs } = buildInputs(state, this.store, {
      asOf,
      reviewsTopicId: this.settings.reviewsTopicId,
      extraAgentIds: this.extraAgentIds(state),
      unresolved: this.unresolved,
    });
    return { asOf, state, result: computeScores(inputs, this.config, asOf) };
  }

  /** Null before the first sync has ever completed. */
  view(): LiveView | null {
    if (this.live) return this.live;
    const asOf = this.store.getMeta(LIVE_AS_OF);
    if (asOf) this.live = this.buildLive(asOf);
    return this.live;
  }

  /**
   * Each list request reads every listed profile, so a file is read and parsed once, not per request.
   * Only a found file is kept: enrichment never replaces one, but a miss can turn into a file later.
   */
  agentProfile(uri: string): AgentProfile {
    const cached = this.profiles.get(uri);
    if (cached) return cached;
    const body = this.store.agentFile(uri)?.body ?? null;
    const profile = parseAgentProfile(body);
    if (body !== null) {
      if (this.profiles.size >= MAX_CACHED_PROFILES) {
        this.profiles.delete(this.profiles.keys().next().value!);
      }
      this.profiles.set(uri, profile);
    }
    return profile;
  }

  /** Only 'cold' reads the mirror, so that is the case a caller has to ration. */
  agentLookup(agentId: string): AgentLookup {
    const view = this.view();
    if (!view?.state.identities.has(agentId)) return 'missing';
    return view.result.agents.some((agent) => agent.agentId === agentId) ? 'ready' : 'cold';
  }

  isLookingUp(agentId: string): boolean {
    return this.lookups.has(agentId);
  }

  /** Starts scoring an agent nobody linked, because someone asked for it. False if it does not exist. */
  trackAgent(agentId: string): Promise<boolean> {
    const running = this.lookups.get(agentId);
    if (running) return running;
    const lookup = this.lookUp(agentId).finally(() => this.lookups.delete(agentId));
    this.lookups.set(agentId, lookup);
    return lookup;
  }

  private async lookUp(agentId: string): Promise<boolean> {
    const lookup = this.agentLookup(agentId);
    if (lookup !== 'cold') return lookup === 'ready';
    const view = this.view()!;

    const failed = await enrichState(this.store, this.mirror, view.state, new Set([agentId]), {
      ...this.enrichOptions(view.asOf),
      maxLookups: LOOKUPS_PER_REQUEST,
    });
    for (const key of failed) this.unresolved.add(key);
    this.store.trackAgent(agentId, this.maxTrackedAgents);
    this.refreshLive(view.asOf);
    return true;
  }

  buildEpoch(epoch: number): BuiltEpoch {
    const asOf = epochEnd(epoch, this.config);
    const state = foldEvents(this.store.eventsUpTo(asOf));
    const { inputs, pending } = buildInputs(state, this.store, {
      asOf,
      reviewsTopicId: this.settings.reviewsTopicId,
      unresolved: this.unresolved,
    });
    const result = computeScores(inputs, this.config, asOf);
    const inputsHash = computeInputsHash(inputs, this.config, asOf);
    return { snapshot: buildSnapshot(epoch, inputsHash, result), pending };
  }
}

let shared: ScorerRuntime | undefined;

/** One store per process: the read routes and the epoch loop must see the same cache. */
export function getScorerRuntime(): ScorerRuntime {
  if (!shared) {
    const settings = loadScorerSettings();
    shared = new ScorerRuntime({
      settings,
      store: new Store(settings.dbPath),
      mirror: new MirrorClient({ baseUrl: settings.mirrorNode }),
      config: settings.epochSeconds
        ? { ...SCORING_CONFIG, epochSeconds: settings.epochSeconds }
        : SCORING_CONFIG,
    });
  }
  return shared;
}
