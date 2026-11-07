'use client';

import { useId, useRef, useState } from 'react';
import { formatEther, parseEther } from 'viem';
import { hashscan, type AgentDetail, type Address } from '@reputed/shared';
import { formatDateTime } from '@/lib/format';
import { AddressChip } from '../AddressChip';
import { CostHint } from '../CostHint';
import { EmptyState } from '../EmptyState';
import { CheckIcon } from '../icons';
import { InlineError } from '../InlineError';
import { useWalletSend } from '@/lib/walletSend';
import { TransactionButton, type TxPhase } from '../TransactionButton';
import { clearPaymentAttempt, loadPaymentAttempt, savePaymentAttempt, type PaymentAttempt } from './attempts';
import { MirrorUnavailableError, consensusToMs, findSentPayment, toSdkTransactionId, type PaymentParties, type VerifiedPayment } from './mirror';
import type { PaymentCheck, PaymentState } from './usePaymentCheck';

/** A plain transfer uses 21,000 gas on testnet. The limit leaves room for a contract wallet. */
const PAYMENT_GAS = 100_000n;
const AMOUNT = /^(\d+\.?\d{0,8}|\.\d{1,8})$/;
const WEIBARS_PER_TINYBAR = 10n ** 10n;

/** Hedera's EVM value is in tinybars scaled up by 10^10, so 8 decimals is the finest amount it can carry. */
function toWeibars(amount: string): bigint | null {
  const trimmed = amount.trim();
  if (!AMOUNT.test(trimmed)) return null;
  const value = parseEther(trimmed);
  return value > 0n ? value : null;
}

function hbarText(amount: number): string {
  return amount.toFixed(8).replace(/\.?0+$/, '');
}

interface SendProps {
  agent: AgentDetail;
  client: Address;
  wallet: Address;
  parties: PaymentParties | null;
  usedIds: ReadonlySet<string>;
  expanded: boolean;
  onSending: (sending: boolean) => void;
  /** Gets the proof to cite: the hash, or the transaction ID when a lost send was found on Hedera. */
  onPaid: (proof: string) => void;
}

/**
 * Pays the agent's wallet from inside the review form. The amount and start time are written down
 * before the wallet is asked, so a send that lost its hash can be found on Hedera by amount.
 */
function SendPayment({ agent, client, wallet, parties, usedIds, expanded, onSending, onPaid }: SendProps) {
  const id = useId();
  const price = agent.endpoints.x402PriceHbar;
  // Read once: a reload lands here with the payment still on its way, or with its outcome unknown.
  const [resumed] = useState(() => loadPaymentAttempt(client, agent.agentId));
  const attempt = useRef<PaymentAttempt | null>(resumed);
  const [amount, setAmount] = useState(() => {
    if (resumed) return formatEther(BigInt(resumed.weibars));
    return price === undefined ? '' : hbarText(price);
  });
  const [phase, setPhase] = useState<TxPhase>('idle');
  const { send: sendTransactionAsync } = useWalletSend();
  const value = toWeibars(amount);
  const entered = amount.trim() !== '';
  // The amount is fixed once a send is in flight, and free again if a clean search found nothing.
  const editable = phase === 'idle' || phase === 'not-found';

  const forget = () => {
    attempt.current = null;
    clearPaymentAttempt(client, agent.agentId);
  };

  function send() {
    attempt.current = { startedAt: Date.now(), weibars: value!.toString() };
    savePaymentAttempt(client, agent.agentId, attempt.current);
    return sendTransactionAsync({ to: wallet, value: value!, gas: PAYMENT_GAS });
  }

  /** Throws until both accounts are known, because that says nothing about the payment. */
  function findSent(signal: AbortSignal): Promise<VerifiedPayment | null> {
    const sent = attempt.current;
    if (!sent) return Promise.resolve(null);
    if (!parties) return Promise.reject(new MirrorUnavailableError());
    return findSentPayment(parties, BigInt(sent.weibars) / WEIBARS_PER_TINYBAR, sent.startedAt, usedIds, signal);
  }

  return (
    <details className={`pay-send${phase === 'done' ? ' tx-finished' : ''}`} open={expanded || phase !== 'idle' || undefined}>
      <summary>Pay this agent now</summary>
      <div className="row muted">
        To <AddressChip address={wallet} />
      </div>
      <div className="field" hidden={phase === 'done'}>
        <label htmlFor={id}>Amount (HBAR)</label>
        <input
          id={id}
          className="input"
          inputMode="decimal"
          autoComplete="off"
          disabled={!editable}
          value={amount}
          aria-invalid={entered && value === null}
          onChange={(e) => setAmount(e.target.value)}
        />
        {entered && value === null && <span className="error-text">Enter an amount above 0, with up to 8 decimal places.</span>}
      </div>
      <TransactionButton
        label="Send payment"
        disabled={value === null}
        resendRisk="Sending again could pay this agent twice."
        resumeHash={resumed?.hash}
        resumeStartedAt={resumed && !resumed.hash ? resumed.startedAt : undefined}
        onSend={send}
        onSubmitted={(hash) => {
          if (!attempt.current) return;
          attempt.current = { ...attempt.current, hash };
          savePaymentAttempt(client, agent.agentId, attempt.current);
        }}
        onFailed={forget}
        onNotSent={forget}
        onConfirmed={({ hash }) => {
          forget();
          onPaid(hash);
        }}
        findSent={findSent}
        onFound={(payment) => {
          forget();
          onPaid(payment.txId);
        }}
        onPhase={(next) => {
          setPhase(next);
          onSending(next === 'signing' || next === 'confirming' || next === 'unknown');
        }}
      />
      {phase === 'idle' && <CostHint usd={0.01} />}
    </details>
  );
}

function PaymentStatus({ state, onRetry, onClear }: { state: PaymentState; onRetry: () => void; onClear: () => void }) {
  const clear = (
    <button type="button" className="btn btn-outline btn-small" onClick={onClear}>
      Clear
    </button>
  );
  switch (state.kind) {
    case 'none':
      return <p className="note-warn">Without a verified payment, your review will be recorded but won’t count toward the score.</p>;
    case 'unavailable':
      return null;
    case 'checking':
      return (
        <p className="muted" role="status">
          Checking the payment on Hedera…
        </p>
      );
    case 'invalid':
      return (
        <div className="pay-problem">
          <span className="error-text">That isn’t a transaction ID. Paste 0.0.x@seconds.nanos, 0.0.x-seconds-nanos or a 0x hash.</span>
          {clear}
        </div>
      );
    case 'not-found':
      return state.searching ? (
        <p className="muted" role="status">
          Looking for this payment on Hedera. A new one takes a few seconds to appear.
        </p>
      ) : (
        <div className="pay-problem">
          <span className="error-text">This payment wasn’t found on Hedera.</span>
          <button type="button" className="btn btn-outline btn-small" onClick={onRetry}>
            Refresh
          </button>
          {clear}
        </div>
      );
    case 'rejected':
      return (
        <div className="pay-problem">
          <span className="error-text">{state.message}</span>
          {clear}
        </div>
      );
    case 'error':
      return <InlineError message="Couldn’t reach the Mirror Node to check this payment." onRetry={onRetry} />;
    case 'verified': {
      const { payment } = state;
      return (
        <p className="pay-ok pay-verified" role="status">
          <CheckIcon /> Payment verified: {payment.amount} on {formatDateTime(new Date(consensusToMs(payment.consensusTimestamp)).toISOString())}.{' '}
          <a href={hashscan.tx(payment.consensusTimestamp)} target="_blank" rel="noreferrer">
            <span className="mono">{toSdkTransactionId(payment.txId) ?? payment.txId}</span>
          </a>
        </p>
      );
    }
  }
}

interface Props {
  agent: AgentDetail;
  client: Address;
  check: PaymentCheck;
  selected: string;
  pasted: string;
  onSelect: (txId: string) => void;
  onPaste: (text: string) => void;
  onSending: (sending: boolean) => void;
  onPaid: (proof: string) => void;
}

export function PaymentField({ agent, client, check, selected, pasted, onSelect, onPaste, onSending, onPaid }: Props) {
  const id = useId();
  const { state, recent, usedIds } = check;
  const clear = () => {
    onSelect('');
    onPaste('');
  };

  if (state.kind === 'unavailable') {
    return (
      <fieldset className="field-group">
        <legend>Payment</legend>
        <p className="note-warn">{state.message} Your review will be recorded but won’t count toward the score.</p>
      </fieldset>
    );
  }

  return (
    <fieldset className="field-group">
      <legend>Payment</legend>

      {recent.isLoading ? (
        <span className="skeleton skeleton-text" aria-hidden="true" />
      ) : recent.isError ? (
        <InlineError message="Couldn’t load your recent payments from the Mirror Node." onRetry={recent.refetch} />
      ) : check.parties === null ? null : recent.payments.length === 0 ? (
        <EmptyState message="No recent payments from this wallet to this agent." action={{ label: 'Refresh', onClick: recent.refetch }} />
      ) : (
        <div className="field">
          <label htmlFor={`${id}-recent`}>Recent payments to this agent</label>
          <select
            id={`${id}-recent`}
            className="input"
            value={selected}
            onChange={(e) => {
              onPaste('');
              onSelect(e.target.value);
            }}
          >
            <option value="">Choose a payment</option>
            {recent.payments.map((p) => (
              <option key={p.txId} value={p.txId} disabled={usedIds.has(p.txId)}>
                {p.amount} · {formatDateTime(new Date(consensusToMs(p.consensusTimestamp)).toISOString())}
                {usedIds.has(p.txId) ? ' · already used' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="field">
        <label htmlFor={`${id}-paste`}>Or paste a transaction ID</label>
        <input
          id={`${id}-paste`}
          className="input mono"
          autoComplete="off"
          spellCheck={false}
          placeholder="0.0.1234@1700000000.000000000"
          maxLength={128}
          value={pasted}
          onChange={(e) => {
            onSelect('');
            onPaste(e.target.value);
          }}
        />
      </div>

      <PaymentStatus state={state} onRetry={check.retry} onClear={clear} />
      {agent.wallet && (
        <SendPayment
          agent={agent}
          client={client}
          wallet={agent.wallet}
          parties={check.parties}
          usedIds={usedIds}
          expanded={check.parties !== null && !recent.isLoading && !recent.isError && recent.payments.length === 0}
          onSending={onSending}
          onPaid={(proof) => {
            onPaid(proof);
            recent.refetch();
          }}
        />
      )}
    </fieldset>
  );
}
