import type { SkillId } from './skills';

// The two agents. Each sells one skill and buys the other's. Names matter: on a later run the agent
// kit finds the agent this account already registered under the same name, instead of registering a
// new one.

export type Side = 'a' | 'b';

export interface Role {
  side: Side;
  name: string;
  description: string;
  skill: SkillId;
  priceHbar: number;
  defaultPort: number;
}

export const ROLES: Record<Side, Role> = {
  a: {
    side: 'a',
    name: 'Factor Finder',
    description: 'Finds the prime factors of a number, for 0.1 HBAR a job. Reputed agent-to-agent example.',
    skill: 'factor',
    priceHbar: 0.1,
    defaultPort: 4101,
  },
  b: {
    side: 'b',
    name: 'Hash Notary',
    description: 'Notarizes a text with its SHA-256 digest, for 0.1 HBAR a job. Reputed agent-to-agent example.',
    skill: 'sha256',
    priceHbar: 0.1,
    defaultPort: 4102,
  },
};

export const other = (side: Side): Side => (side === 'a' ? 'b' : 'a');

/** The most a hirer pays for one job, whatever the provider quotes. */
export const MAX_PRICE_HBAR = 0.5;
