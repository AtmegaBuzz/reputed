import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { ScoresEvent } from '@reputed/shared';
import type { FastifyInstance } from 'fastify';
import { ApiHttpError } from '../errors.ts';
import type { LiveView } from '../indexer/runtime.ts';
import { toIso } from '../scoring/time.ts';
import { byIp, DEFAULT_RATE_LIMITS, limiter, type RateLimits } from './rateLimits.ts';

// GET /api/events: Server-Sent Events, so pages show score changes as the scorer makes them instead
// of polling. The live view is rebuilt on every sync (every few seconds) whether or not anything
// changed, so an event goes out only when the fingerprint of scores and reviews changes. The event
// carries no scores: clients refetch what they show, through the ordinary rate-limited routes.

export interface LiveSource {
  view(): LiveView | null;
  onLiveView(listener: (view: LiveView) => void): () => void;
}

export interface EventOptions {
  /** Open streams across all clients. Each one is a socket, so this bounds what a crowd can hold open. */
  maxClients?: number;
  /** Comment lines keep proxies from closing an idle stream. */
  heartbeatMs?: number;
}

/** What a client would see change: every agent's score and counts, every creator's score, the reviews. */
export function fingerprint(view: LiveView): { version: string; agents: Map<string, string> } {
  const agents = new Map(
    view.result.agents.map((agent) => [agent.agentId, `${agent.score}|${agent.isNew}|${agent.counted}|${agent.excluded}|${agent.penaltiesConfirmed}`]),
  );
  const hash = createHash('sha256');
  for (const [agentId, state] of agents) hash.update(`${agentId}:${state};`);
  for (const creator of view.result.creators) hash.update(`${creator.creator}:${creator.score};`);
  hash.update(`reviews:${view.result.reviews.length};revoked:${view.result.reviews.filter((r) => r.revokedAt !== null).length};`);
  hash.update(`identities:${view.state.identities.size};links:${view.state.links.size};compromised:${view.state.compromisedAt.size}`);
  return { version: hash.digest('hex').slice(0, 16), agents };
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function registerEventRoutes(app: FastifyInstance, source: LiveSource, rateLimits: RateLimits = DEFAULT_RATE_LIMITS, options: EventOptions = {}): void {
  const maxClients = options.maxClients ?? 500;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const connectLimit = limiter(app, rateLimits.agentListByIp, byIp('events'));
  const clients = new Set<PassThrough>();

  const initial = source.view();
  let last = initial ? fingerprint(initial) : null;
  let lastEvent: ScoresEvent | null = initial && last ? { version: last.version, asOf: toIso(initial.asOf), changed: [] } : null;

  const stop = source.onLiveView((view) => {
    const next = fingerprint(view);
    if (last && next.version === last.version) return;
    const changed = [...next.agents].filter(([agentId, state]) => last?.agents.get(agentId) !== state).map(([agentId]) => agentId);
    last = next;
    lastEvent = { version: next.version, asOf: toIso(view.asOf), changed };
    const data = frame('scores', lastEvent);
    for (const client of clients) client.write(data);
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n');
  }, heartbeatMs);
  heartbeat.unref();

  app.addHook('onClose', async () => {
    stop();
    clearInterval(heartbeat);
    for (const client of clients) client.end();
    clients.clear();
  });

  app.get('/api/events', async (req, reply) => {
    await connectLimit(req);
    if (clients.size >= maxClients) throw new ApiHttpError(503, 'RATE_LIMITED', 'Too many live connections right now. Retry in 30 seconds.', 30);

    const stream = new PassThrough();
    clients.add(stream);
    req.raw.on('close', () => {
      clients.delete(stream);
      stream.end();
    });
    // How long EventSource waits before reconnecting, then the current version, so a client that
    // reconnects can tell whether it missed an update.
    stream.write('retry: 3000\n\n');
    if (lastEvent) stream.write(frame('hello', lastEvent));

    reply
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache, no-transform')
      .header('x-accel-buffering', 'no');
    return reply.send(stream);
  });
}
