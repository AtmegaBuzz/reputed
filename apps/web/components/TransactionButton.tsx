'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';
import type { Hash } from 'viem';
import { HEDERA_TESTNET, hashscan } from '@reputed/shared';
import { RECONCILE_WINDOW_MS, SLOW_AFTER_MS, confirmTx, lookForSend, type ConfirmedTx, type TxFailure } from '@/lib/confirmTx';
import { NotSentError, describeWalletError } from '@/lib/walletError';
import { useToast } from './Toasts';

// One button for every on-chain write. It owns the lifecycle after the click: the wallet signature,
// polling the Mirror Node for the outcome, and the case where the wallet errored or the tab closed
// before a hash was known. A transaction is sent again only from `idle` (after a clear failure or
// rejection) or, once a clean search of Hedera found nothing, by a click that names the risk.

type TxState =
  | { step: 'idle' }
  | { step: 'signing' }
  // Sent, and the outcome is not known yet. There is deliberately no way to send again from here:
  // a slow or failing poll says nothing about the transaction, so a second send could run it twice.
  | { step: 'confirming'; hash: Hash; slow: boolean }
  | { step: 'confirmed'; hash: Hash }
  | { step: 'failed'; message: string; hash?: Hash }
  | { step: 'rejected' }
  // The wallet may have sent it, but no hash came back. Sending stays locked until a search finds it,
  // or until the window has passed with a clean look that found nothing. Then it takes a deliberate click.
  | { step: 'unknown'; view: 'looking' | 'unavailable' | 'absent'; lookUntil: number; walletErrored: boolean }
  | { step: 'found' };

/** Where the button is, for a caller to lock its form. `idle` includes after a failure. */
export type TxPhase = 'idle' | 'signing' | 'confirming' | 'unknown' | 'not-found' | 'done';

function phaseOf(state: TxState): TxPhase {
  switch (state.step) {
    case 'signing':
    case 'confirming':
      return state.step;
    case 'unknown':
      return state.view === 'absent' ? 'not-found' : 'unknown';
    case 'confirmed':
    case 'found':
      return 'done';
    default:
      return 'idle';
  }
}

interface Props<Found> {
  label: string;
  /** Asks the wallet to sign and send, then returns the transaction hash (for example writeContractAsync). */
  onSend: () => Promise<Hash>;
  /** Runs once the Mirror Node records success. `logs` are `{address, topics, data}`. */
  onConfirmed?: (tx: ConfirmedTx) => void;
  /** Runs as soon as the hash is known, so the caller can save it and resume after a closed tab. */
  onSubmitted?: (hash: Hash) => void;
  /** Runs when the transaction reached the chain and failed, so `hash` is set. */
  onFailed?: (failure: TxFailure) => void;
  /** Runs when nothing was sent: the user cancelled, or the send stopped short of the chain. */
  onNotSent?: () => void;
  /**
   * Looks for this transaction when the send failed with no hash, since it may have landed anyway.
   * Gives null if it isn't there, and throws if it could not look, which never counts as absent.
   */
  findSent: (signal: AbortSignal) => Promise<Found | null>;
  /** Runs when `findSent` finds it, in place of `onConfirmed`. */
  onFound: (found: Found) => void;
  /** Reads a transaction that succeeded on-chain but may not have done its job. A result turns it into a failure. */
  inspect?: (tx: ConfirmedTx) => Omit<TxFailure, 'hash'> | null;
  onPhase?: (phase: TxPhase) => void;
  /** What a second send would do, shown before offering one. */
  resendRisk?: string;
  /** A transaction sent earlier: starts in the confirming state and watches it. Read on mount. */
  resumeHash?: Hash | undefined;
  /** When a send began that left no hash: starts by searching for it. Read on mount. */
  resumeStartedAt?: number | undefined;
  disabled?: boolean;
}

function TxLink({ hash, children }: { hash: Hash; children: string }) {
  return (
    <a href={hashscan.tx(hash)} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** Resuming after a reload: a hash is watched, a start time with no hash is searched for. */
function startingState(resumeHash: Hash | undefined, resumeStartedAt: number | undefined): TxState {
  if (resumeHash) return { step: 'confirming', hash: resumeHash, slow: false };
  if (resumeStartedAt !== undefined) {
    return { step: 'unknown', view: 'looking', lookUntil: resumeStartedAt + RECONCILE_WINDOW_MS, walletErrored: false };
  }
  return { step: 'idle' };
}

export function TransactionButton<Found>({
  label,
  onSend,
  onConfirmed,
  onSubmitted,
  onFailed,
  onNotSent,
  findSent,
  onFound,
  inspect,
  onPhase,
  resendRisk = 'Sending again could run it twice.',
  resumeHash,
  resumeStartedAt,
  disabled = false,
}: Props<Found>) {
  const { isConnected, chainId, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { toast } = useToast();
  const [state, setState] = useState<TxState>(() => startingState(resumeHash, resumeStartedAt));
  // Bumped by Refresh to look again at once.
  const [attempt, setAttempt] = useState(0);

  // Callbacks are read through a ref so the polling effects do not restart when a parent re-renders.
  const latest = useRef({ onConfirmed, onFailed, onNotSent, findSent, onFound, inspect, onPhase, toast });
  useEffect(() => {
    latest.current = { onConfirmed, onFailed, onNotSent, findSent, onFound, inspect, onPhase, toast };
  });

  const phase = phaseOf(state);
  useEffect(() => latest.current.onPhase?.(phase), [phase]);

  const watching = state.step === 'confirming' ? state.hash : null;
  useEffect(() => {
    if (!watching) return;
    const controller = new AbortController();
    const markSlow = () => setState((current) => (current.step === 'confirming' ? { ...current, slow: true } : current));
    const slowTimer = setTimeout(markSlow, SLOW_AFTER_MS);

    confirmTx(watching, { signal: controller.signal }).then(
      (outcome) => {
        const { onConfirmed, onFailed, inspect, toast } = latest.current;
        if (outcome.status === 'unknown') {
          // Polling has stopped. Refresh starts it again, and sending again is never offered.
          markSlow();
          return;
        }
        const failure = outcome.status === 'reverted' ? outcome : inspect?.(outcome);
        if (failure) {
          setState({ step: 'failed', message: failure.reason, hash: outcome.hash });
          toast('error', failure.reason);
          onFailed?.({ ...failure, hash: outcome.hash });
        } else if (outcome.status === 'confirmed') {
          setState({ step: 'confirmed', hash: outcome.hash });
          toast('success', 'Transaction confirmed');
          onConfirmed?.(outcome);
        }
      },
      () => {
        // Aborted: this button unmounted, or Refresh started a new look.
      },
    );

    return () => {
      controller.abort();
      clearTimeout(slowTimer);
    };
  }, [watching, attempt]);

  const lookUntil = state.step === 'unknown' && state.view === 'looking' ? state.lookUntil : null;
  useEffect(() => {
    if (lookUntil === null) return;
    const controller = new AbortController();

    lookForSend((signal) => latest.current.findSent(signal), lookUntil, controller.signal).then(
      (result) => {
        if (result.status === 'found') {
          setState({ step: 'found' });
          latest.current.toast('success', 'It went through');
          latest.current.onFound(result.value);
        } else {
          const view = result.status;
          setState((current) => (current.step === 'unknown' ? { ...current, view } : current));
        }
      },
      () => {
        // Aborted: this button unmounted.
      },
    );

    return () => controller.abort();
  }, [lookUntil]);

  const onWrongNetwork = isConnected && chainId !== HEDERA_TESTNET.id;
  const locked = state.step === 'signing' || state.step === 'confirming' || state.step === 'confirmed' || state.step === 'found' || phase === 'unknown';
  const blocked = disabled || !isConnected || onWrongNetwork || locked;

  /**
   * Asks the wallet which chain it is on right now and switches it to Hedera testnet if needed.
   * wagmi's `chainId` can be stale (a wallet that changed network without telling the page), and
   * viem would then refuse the send with a chain mismatch. Nothing has been sent if this throws.
   */
  async function ensureTestnet() {
    try {
      const actual = await connector?.getChainId();
      if (actual !== undefined && actual !== HEDERA_TESTNET.id) await switchChainAsync({ chainId: HEDERA_TESTNET.id });
    } catch (err) {
      throw new NotSentError(err);
    }
  }

  async function run() {
    setState({ step: 'signing' });
    let hash: Hash;
    try {
      await ensureTestnet();
      hash = await onSend();
    } catch (err) {
      // The full error, with viem's cause chain, for debugging a wallet that words things its own way.
      console.error('[tx] send failed', err);
      const { rejected, message, notSent } = describeWalletError(err);
      if (rejected) {
        setState({ step: 'rejected' });
        toast('error', 'Cancelled in your wallet');
        latest.current.onNotSent?.();
      } else if (notSent) {
        setState({ step: 'failed', message });
        toast('error', message);
        latest.current.onNotSent?.();
      } else {
        // The wallet's own words don't go on screen: viem calls a relay failure "reverted", which nothing has shown.
        setState({ step: 'unknown', view: 'looking', lookUntil: Date.now() + RECONCILE_WINDOW_MS, walletErrored: true });
        toast('info', 'This may have gone through. Checking Hedera…');
      }
      return;
    }

    onSubmitted?.(hash);
    setState({ step: 'confirming', hash, slow: false });
    toast('info', 'Transaction submitted');
  }

  /** One more look now, then back to whichever view that look produced. */
  function checkAgain() {
    setState((current) => (current.step === 'unknown' ? { ...current, view: 'looking', lookUntil: Date.now() } : current));
  }

  const retrying = state.step === 'failed' || state.step === 'rejected';
  const anyway = phase === 'not-found';
  const buttonText = state.step === 'signing' ? 'Waiting for signature…' : retrying ? 'Retry' : anyway ? `${label} anyway` : label;

  return (
    <div className="tx">
      <button type="button" className={`btn ${state.step === 'unknown' ? 'btn-outline' : 'btn-primary'}`} disabled={blocked} onClick={run}>
        {buttonText}
      </button>
      <div className="tx-status" role="status">
        {!isConnected && <span className="muted">Connect your wallet first.</span>}
        {onWrongNetwork && <span className="muted">Switch to {HEDERA_TESTNET.name} to continue.</span>}
        {state.step === 'signing' && <span className="muted">Confirm the transaction in your wallet.</span>}
        {state.step === 'confirming' && !state.slow && (
          <span className="muted">
            Confirming on Hedera — usually a few seconds. <TxLink hash={state.hash}>View transaction</TxLink>
          </span>
        )}
        {state.step === 'confirming' && state.slow && (
          <span className="muted tx-slow">
            <span>
              Taking longer than usual. <TxLink hash={state.hash}>View transaction</TxLink>
            </span>
            <button type="button" className="btn btn-outline btn-small" onClick={() => setAttempt((n) => n + 1)}>
              Refresh
            </button>
          </span>
        )}
        {state.step === 'confirmed' && (
          <span className="pay-ok">
            Confirmed. <TxLink hash={state.hash}>View on HashScan</TxLink>
          </span>
        )}
        {state.step === 'found' && <span className="pay-ok">It went through. Hedera has it.</span>}
        {state.step === 'rejected' && <span className="error-text">Cancelled in your wallet.</span>}
        {state.step === 'failed' && (
          <span className="error-text">
            {state.message}
            {state.hash && (
              <>
                {' '}
                <TxLink hash={state.hash}>View on HashScan</TxLink>
              </>
            )}
          </span>
        )}
        {state.step === 'unknown' && state.view === 'looking' && (
          <span className="note-warn tx-unknown">
            <span>
              This may have gone through{state.walletErrored && ', even though your wallet reported an error'}. Checking Hedera before you can
              send again…
            </span>
          </span>
        )}
        {state.step === 'unknown' && state.view === 'unavailable' && (
          <span className="note-warn tx-unknown">
            <span>This may have gone through, and Hedera can’t be checked right now. Sending stays locked until it can.</span>
            <button type="button" className="btn btn-outline btn-small" onClick={checkAgain}>
              Check again
            </button>
          </span>
        )}
        {state.step === 'unknown' && state.view === 'absent' && (
          <span className="note-warn tx-unknown">
            <span>This hasn’t appeared on Hedera, but it still might. {resendRisk}</span>
            <button type="button" className="btn btn-outline btn-small" onClick={checkAgain}>
              Check again
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
