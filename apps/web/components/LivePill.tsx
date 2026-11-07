'use client';

import { useLive, useNow } from '@/lib/live';

const STATUS = {
  connecting: { label: 'Connecting', title: 'Connecting to live score updates' },
  live: { label: 'Live', title: 'Scores update here as soon as Reputed rescores' },
  polling: { label: 'Refreshing', title: 'Live updates are unavailable, so scores refresh every 10 seconds' },
} as const;

/** Whether scores on the page are live, and a flash when the server reports a change. */
export function LivePill() {
  const { status, lastChangeAt } = useLive();
  const now = useNow(1_000);
  const justChanged = lastChangeAt !== null && now - lastChangeAt < 2_500;
  const { label, title } = STATUS[status];
  return (
    <span className={`pill live-pill is-${status}${justChanged ? ' just-changed' : ''}`} title={title} role="status" aria-live="polite">
      <span className="live-dot" aria-hidden="true" />
      {justChanged ? 'Updated' : label}
    </span>
  );
}
