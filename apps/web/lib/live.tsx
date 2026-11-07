'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ScoresEvent } from '@reputed/shared';
import { API_URL } from './api';

// Live scores. The server pushes an event on /api/events whenever a score or review changes (it
// rescores every few seconds); the pages then refetch what they show. If the stream cannot be opened
// (an older server, or too many connections), the pages poll instead and the stream is retried.

/** Query keys whose data moves with scores. Only queries a page is showing are refetched. */
const LIVE_KEYS = ['agents', 'agent', 'creator', 'interactions'] as const;
const POLL_MS = 10_000;
const RETRY_MS = 30_000;

export type LiveStatus = 'connecting' | 'live' | 'polling';

interface LiveState {
  status: LiveStatus;
  /** When the server last reported a change, in ms since the epoch. */
  lastChangeAt: number | null;
}

const LiveContext = createContext<LiveState>({ status: 'connecting', lastChangeAt: null });

export function useLive(): LiveState {
  return useContext(LiveContext);
}

export function LiveUpdates({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LiveState>({ status: 'connecting', lastChangeAt: null });

  useEffect(() => {
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let version: string | null = null;
    let stopped = false;

    const refresh = () => {
      for (const key of LIVE_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
    };
    const setStatus = (status: LiveStatus) => setState((s) => (s.status === status ? s : { ...s, status }));
    const startPolling = () => {
      setStatus('polling');
      poll ??= setInterval(refresh, POLL_MS);
    };
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };

    const connect = () => {
      if (stopped) return;
      if (typeof EventSource === 'undefined') return startPolling();
      source = new EventSource(`${API_URL}/api/events`);
      source.addEventListener('open', () => {
        stopPolling();
        setStatus('live');
      });
      // Sent on every (re)connect: a different version means something changed while disconnected.
      source.addEventListener('hello', (event) => {
        const data = JSON.parse((event as MessageEvent<string>).data) as ScoresEvent;
        if (version !== null && data.version !== version) refresh();
        version = data.version;
      });
      source.addEventListener('scores', (event) => {
        const data = JSON.parse((event as MessageEvent<string>).data) as ScoresEvent;
        version = data.version;
        refresh();
        setState({ status: 'live', lastChangeAt: Date.now() });
      });
      source.addEventListener('error', () => {
        // CONNECTING: the browser reconnects by itself. CLOSED: the server refused the stream.
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          source = null;
          retry = setTimeout(connect, RETRY_MS);
        }
        startPolling();
      });
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      stopPolling();
      if (retry) clearTimeout(retry);
    };
  }, [queryClient]);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}

/** Re-renders every `ms`, for "2 minutes ago" text and anything that fades with time. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * The change since the value last changed, held for `holdMs` so the UI can flash it. Null on the
 * first render and once the hold is over, so a page load never flashes.
 */
export function useChange(value: number | null | undefined, holdMs = 2_600): { delta: number; key: number } | null {
  const [previous, setPrevious] = useState(value);
  const [change, setChange] = useState<{ delta: number; key: number } | null>(null);
  if (value !== previous) {
    // Adjusting state while rendering is React's documented way to react to a changed prop.
    setPrevious(value);
    if (typeof value === 'number' && typeof previous === 'number' && Math.abs(value - previous) >= 0.005) {
      setChange({ delta: value - previous, key: Date.now() });
    }
  }
  useEffect(() => {
    if (!change) return;
    const timer = setTimeout(() => setChange(null), holdMs);
    return () => clearTimeout(timer);
  }, [change, holdMs]);
  return change;
}
