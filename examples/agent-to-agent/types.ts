import type { Reputed } from '@reputed/agent-kit';

/** The parts of a connected agent the provider and hirer use. Tests pass an in-memory stand-in. */
export type Agent = Pick<
  Reputed,
  'agentId' | 'owner' | 'creator' | 'reputation' | 'verifyCounterparty' | 'pay' | 'verifyPayment' | 'review' | 'waitForReview'
> & { readonly accountId: string };
