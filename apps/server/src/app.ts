import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Address } from 'viem';
import type { CreatorRegistryGateway } from './chain.ts';
import type { ReviewBudget, WorldConfig } from './config.ts';
import { registerErrorHandling } from './errors.ts';
import type { ReviewPublisher } from './hedera.ts';
import { registerAgentFileRoute } from './routes/agentFile.ts';
import { registerEventRoutes } from './routes/events.ts';
import { DEFAULT_RATE_LIMITS, type RateLimits } from './routes/rateLimits.ts';
import { registerReviewFileRoute } from './routes/reviewFile.ts';
import { registerRpSignatureRoute } from './routes/rpSignature.ts';
import { registerSessionRoutes } from './routes/session.ts';
import { registerVerifyRoute } from './routes/verify.ts';
import { getScorerRuntime, type ScorerRuntime } from './indexer/runtime.ts';
import { registerReadRoutes } from './scoring/routes.ts';
import type { VerificationStore } from './verificationStore.ts';
import type { WorldVerifier } from './world/client.ts';

export interface AppDeps {
  world: WorldConfig;
  /** Signs session tokens. */
  sessionSecret: string;
  identityRegistry: Address;
  corsOrigins: string[];
  /** IPs or CIDRs of the proxies in front of the server. Empty when there are none. */
  trustProxy: string[];
  verifier: WorldVerifier;
  registry: CreatorRegistryGateway;
  store: VerificationStore;
  publisher: ReviewPublisher;
  reviewBudget: ReviewBudget;
}

export interface AppOptions {
  logger?: FastifyServerOptions['logger'];
  rateLimits?: Partial<RateLimits>;
  /** Off in route tests, so they do not depend on the read side's environment. */
  readRoutes?: boolean;
  /** The process-wide runtime when unset. */
  scorer?: ScorerRuntime;
}

/**
 * Wires every route behind one error handler, one CORS policy and per-route rate limits.
 * The rate-limit plugin is registered with global: false so each route picks its own key and
 * bucket (routes/rateLimits.ts). Dependencies arrive as interfaces so tests pass fakes.
 */
export async function buildApp(deps: AppDeps, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // Default request logs carry IPs and URLs; the plan allows only transaction
    // IDs and nullifier hashes.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: deps.trustProxy.length > 0 ? deps.trustProxy : false,
    // The largest legitimate body is a few KB (an agent file, an IDKit result).
    bodyLimit: 64 * 1024,
  });

  registerErrorHandling(app);
  await app.register(cors, { origin: deps.corsOrigins });
  await app.register(rateLimit, { global: false });

  const rateLimits = { ...DEFAULT_RATE_LIMITS, ...options.rateLimits };
  registerRpSignatureRoute(app, deps.world, rateLimits);
  registerVerifyRoute(app, { ...deps, rateLimits });
  registerSessionRoutes(app, { secret: deps.sessionSecret, rateLimits });
  registerAgentFileRoute(app, rateLimits);
  registerReviewFileRoute(app, {
    identityRegistry: deps.identityRegistry,
    publisher: deps.publisher,
    rateLimits,
    budget: deps.reviewBudget,
  });

  if (options.readRoutes !== false) {
    const scorer = options.scorer ?? getScorerRuntime();
    registerReadRoutes(app, scorer, rateLimits);
    registerEventRoutes(app, scorer, rateLimits);
  }
  return app;
}
