'use client';

import { useChange } from '@/lib/live';

/** A number that flashes green or red for a moment when it changes while on screen. */
export function LiveNumber({ value, format = (v) => String(v) }: { value: number | null; format?: (value: number) => string }) {
  const change = useChange(value);
  const direction = change ? (change.delta > 0 ? 'is-up' : 'is-down') : '';
  return (
    <span key={change?.key} className={`live-number ${direction}`}>
      {value === null ? '—' : format(value)}
    </span>
  );
}
