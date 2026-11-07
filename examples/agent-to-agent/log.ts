import type { AgentDetail } from '@reputed/shared';

// Each agent prefixes its lines, so the two can share one terminal (`pnpm demo`).

const COLORS = { a: '\x1b[36m', b: '\x1b[35m', demo: '\x1b[33m' } as const;
const useColor = process.stdout.isTTY && !process.env['NO_COLOR'];

export type Log = (message: string) => void;

export function logger(tag: keyof typeof COLORS, label: string): Log {
  const prefix = useColor ? `${COLORS[tag]}[${label}]\x1b[0m` : `[${label}]`;
  return (message) => {
    for (const line of message.split('\n')) console.log(`${prefix} ${line}`);
  };
}

export const short = (address: string | null | undefined): string =>
  address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'nobody';

export const score = (value: number | null | undefined): string => (value === null || value === undefined ? '—' : value.toFixed(2));

/** "Hash Notary #192: 57.50 (Tier 3), creator 0xA879…De6B 57.50" */
export function scoreLine(agent: AgentDetail): string {
  const inherited = agent.score.isNew ? ', inherited from its creator' : '';
  return `${agent.name} #${agent.agentId}: ${score(agent.score.value)} (${agent.score.tier}${inherited}), ${agent.reviewsCounted} review(s) counted · creator ${short(agent.creator)}: ${score(agent.creatorScore)}`;
}
