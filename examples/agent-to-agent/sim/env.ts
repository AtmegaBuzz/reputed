import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { generatePrivateKey } from 'viem/accounts';

// .env.test: the simulation's settings and keys. It is gitignored (.env.*) because it holds private
// keys. Agent keys are generated here on the first run and written to the file before any HBAR is
// sent to them, so a funded key is never lost and every later run drives the same agents.

export const ENV_PATH = fileURLToPath(new URL('../.env.test', import.meta.url));

const TEMPLATE = `# Reputation simulation (pnpm simulate). Holds private keys: gitignored, never commit or paste it.

# The Reputed server (pnpm dev at the repo root).
REPUTED_API_URL=http://localhost:4000

# Two teams of agents, each backed by a different verified human: one API key per human, from
# /dashboard. Reviews between agents of the same human do not count.
TEAM_A_NAME=Team A
TEAM_A_API_KEY=
TEAM_B_NAME=Team B
TEAM_B_API_KEY=

# A funded Hedera testnet account (ECDSA key, hex) that creates and tops up the agent accounts.
FUNDER_KEY=

# Optional, shown with their defaults.
AGENTS_PER_TEAM=3
ROUNDS=4
MIN_SCORE=60
# The chance that a hirer still gives an agent below MIN_SCORE a trial job, so it can earn its way back.
PROBATION=0.5
# On each team, one agent has a slump and another a streak each run, so scores move both ways. 0 turns it off.
SWINGS=1
# The most HBAR one run may send from the funder.
FUND_LIMIT_HBAR=50
# Override an agent's persona: steady, sloppy or erratic. For example A1_PERSONA=erratic.

# Agent keys: generated on the first run and reused on every run. Do not edit or delete them: each
# one is an agent that is already registered and holds HBAR.
`;

export class SimEnv {
  #text: string;
  #values: Record<string, string>;
  /** True when this run created the file from the template. */
  readonly created: boolean;

  private constructor(text: string, created: boolean) {
    this.#text = text;
    this.#values = parseEnv(text) as Record<string, string>;
    this.created = created;
  }

  static load(): SimEnv {
    if (existsSync(ENV_PATH)) return new SimEnv(readFileSync(ENV_PATH, 'utf8'), false);
    writeFileSync(ENV_PATH, TEMPLATE, { mode: 0o600 });
    return new SimEnv(TEMPLATE, true);
  }

  /** The shell wins over the file, so `ROUNDS=8 pnpm simulate` works without editing it. */
  get(name: string): string | undefined {
    const value = process.env[name]?.trim() || this.#values[name]?.trim();
    return value || undefined;
  }

  number(name: string, fallback: number): number {
    const raw = this.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${name} in .env.test must be a number, got "${raw}".`);
    return value;
  }

  /** The agent's key from the file, or a new one written to the file right away. */
  agentKey(id: string): { key: `0x${string}`; generated: boolean } {
    const name = `${id}_KEY`;
    const existing = this.#values[name]?.trim();
    if (existing) return { key: `0x${existing.replace(/^0x/, '')}`, generated: false };
    const key = generatePrivateKey();
    this.#set(name, key);
    this.#save();
    return { key, generated: true };
  }

  #set(name: string, value: string): void {
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    this.#text = pattern.test(this.#text) ? this.#text.replace(pattern, line) : `${this.#text.trimEnd()}\n${line}\n`;
    this.#values[name] = value;
  }

  #save(): void {
    writeFileSync(ENV_PATH, this.#text, { mode: 0o600 });
  }
}
