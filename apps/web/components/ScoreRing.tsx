'use client';

import type { Tier } from '@reputed/shared';
import { useChange } from '@/lib/live';

interface Props {
  /** 0-100 */
  value: number;
  tier: Tier;
  isNew?: boolean;
  size?: 'sm' | 'lg';
}

const TIER_CLASS: Record<Tier, string> = {
  'Tier 1': 'tier-1',
  'Tier 2': 'tier-2',
  'Tier 3': 'tier-3',
};

const RADIUS = 44;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The score as a ring. When the score changes while shown, the ring moves and flashes the change. */
export function ScoreRing({ value, tier, isNew = false, size = 'sm' }: Props) {
  const clamped = Math.min(100, Math.max(0, value));
  const rounded = Math.round(clamped);
  const change = useChange(value);
  const label = `Score ${rounded} out of 100, ${isNew ? 'new' : tier}`;
  const direction = change ? (change.delta > 0 ? ' is-up' : ' is-down') : '';
  return (
    <div className={`score-ring score-ring-${size} ${isNew ? 'tier-new' : TIER_CLASS[tier]}${direction}`} role="img" aria-label={label}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="ring-track" cx="50" cy="50" r={RADIUS} />
        <circle
          className="ring-value"
          cx="50"
          cy="50"
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - clamped / 100)}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <span className="ring-number">{rounded}</span>
      {change && (
        <span key={change.key} className="score-delta" aria-hidden="true">
          {change.delta > 0 ? '▲' : '▼'} {Math.abs(change.delta) >= 10 ? Math.round(Math.abs(change.delta)) : Math.abs(change.delta).toFixed(1)}
        </span>
      )}
    </div>
  );
}
