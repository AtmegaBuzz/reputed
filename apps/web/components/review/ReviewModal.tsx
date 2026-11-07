'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReadContract, useSignMessage } from 'wagmi';
import type { Hash } from 'viem';
import {
  HEDERA_TESTNET,
  REPUTATION_REGISTRY,
  creatorRegistryAbi,
  reputationRegistryAbi,
  serializeReviewFile,
  type Address,
  type AgentDetail,
  type ReviewFile,
  type ReviewFileResponse,
} from '@reputed/shared';
import { CREATOR_REGISTRY, GAS } from '@/lib/contracts';
import { useDebounced } from '@/lib/useDebounced';
import { NotSentError } from '@/lib/walletError';
import { useWalletSend } from '@/lib/walletSend';
import { CostHint } from '../CostHint';
import { InlineError } from '../InlineError';
import { TransactionButton, type TxPhase } from '../TransactionButton';
import { WalletButton } from '../WalletButton';
import { clearReviewAttempt, loadReviewAttempt, saveReviewAttempt, type ReviewAttempt } from './attempts';
import { Dialog, DialogDone } from './Dialog';
import { findFeedback } from './mirror';
import { PaymentField } from './PaymentField';
import {
  MAX_COMMENT_LENGTH,
  MAX_FILE_BYTES,
  MISCONDUCT_CATEGORIES,
  QUALITY_CATEGORIES,
  buildReviewFile,
  draftBytes,
  postReviewFile,
  type ReviewDraft,
} from './reviewFile';
import { usePaymentCheck, type PaymentState } from './usePaymentCheck';

const QUICK_PICKS = [100, 75, 50, 25, 0];
const MAX_ENDPOINT_LENGTH = 256;

type Step = 'sign-file' | 'upload' | 'sign-tx';

const STEP_TEXT: Record<Step, string> = {
  'sign-file': 'Sign your review in your wallet. This one costs nothing.',
  upload: 'Uploading review…',
  'sign-tx': 'Sign giveFeedback in your wallet.',
};

function agentEndpoints(agent: AgentDetail): { label: string; value: string }[] {
  const { a2a, mcp, web } = agent.endpoints;
  const list = [
    { label: 'A2A', value: a2a },
    { label: 'MCP', value: mcp },
    { label: 'Website', value: web },
  ];
  return list.filter((e): e is { label: string; value: string } => Boolean(e.value) && e.value!.length <= MAX_ENDPOINT_LENGTH);
}

function Eligibility({ agent, client }: { agent: AgentDetail; client: Address }) {
  const humanBacked = useReadContract({
    address: CREATOR_REGISTRY,
    abi: creatorRegistryAbi,
    functionName: 'isHumanBacked',
    args: [client],
    chainId: HEDERA_TESTNET.id,
  });

  if (humanBacked.isLoading) {
    return (
      <p className="muted" role="status">
        Checking whether your review will count…
      </p>
    );
  }
  if (humanBacked.isError) {
    return <InlineError message="Couldn’t check whether this wallet is human-backed." onRetry={() => void humanBacked.refetch()} />;
  }
  if (humanBacked.data === false) {
    return (
      <div className="banner-inline">
        Your review will be recorded but won’t count toward the score. <Link href="/verify">Verify with World ID</Link>
      </div>
    );
  }
  if (agent.creator?.toLowerCase() === client.toLowerCase()) {
    return <div className="banner-inline">You’re this agent’s creator, so your review will be recorded but won’t count toward the score.</div>;
  }
  return null;
}

/** What goes in the file: only a payment that passed every check is cited. */
function citedProof(state: PaymentState): string | undefined {
  return state.kind === 'verified' ? state.payment.txId : undefined;
}

interface FormProps {
  agent: AgentDetail;
  client: Address;
  /** True while the dialog should not close: something is waiting on the wallet or on Hedera. */
  onBusyChange: (busy: boolean) => void;
  /** True while this form holds work a disconnected wallet must not take away. */
  onHoldChange: (hold: boolean) => void;
  /** Gets how many reviews this wallet had when it sent this one, to spot the new one in the API. */
  onConfirmed: (reviewsBefore: number) => void;
  onClose: () => void;
}

/**
 * The form and its send. `submit` runs in order: build the file, sign it, upload it, record the
 * attempt, then ask the wallet for giveFeedback. Everything before the wallet is free and repeatable;
 * from the wallet on, a retry is only offered once Hedera has been checked for the first send.
 */
function ReviewForm({ agent, client, onBusyChange, onHoldChange, onConfirmed, onClose }: FormProps) {
  const endpoints = useMemo(() => agentEndpoints(agent), [agent]);
  // Read once: a reload lands here with the review still on its way, or with its outcome unknown.
  const [resumed] = useState(() => loadReviewAttempt(client, agent.agentId));
  const restored = resumed?.draft;
  const [value, setValue] = useState(restored?.value ?? 50);
  const [tag1, setTag1] = useState<ReviewFile['tag1']>(restored?.tag1 ?? 'quality');
  const [qualityCategory, setQualityCategory] = useState<string>(
    restored?.tag1 === 'quality' ? restored.tag2 : QUALITY_CATEGORIES[0].value,
  );
  const [misconductCategory, setMisconductCategory] = useState<string>(
    restored?.tag1 === 'misconduct' ? restored.tag2 : MISCONDUCT_CATEGORIES[0].value,
  );
  const [endpoint, setEndpoint] = useState(restored?.endpoint ?? endpoints[0]?.value ?? '');
  const [comment, setComment] = useState(restored?.comment ?? '');
  const [selected, setSelected] = useState('');
  const [pasted, setPasted] = useState(restored?.proofOfPayment ?? '');
  const [step, setStep] = useState<Step | null>(null);
  const [phase, setPhase] = useState<TxPhase>('idle');
  const [paymentSending, setPaymentSending] = useState(false);
  const reviewsBefore = useRef(resumed?.reviewsBefore ?? 0);
  const attempt = useRef<ReviewAttempt | null>(resumed);
  // Set once this send reaches the wallet. Stopping sooner leaves any earlier attempt's record alone.
  const walletAsked = useRef(false);
  const uploaded = useRef<{ key: string; response: ReviewFileResponse } | null>(
    resumed ? { key: JSON.stringify(resumed.draft), response: resumed.upload } : null,
  );

  const { signMessageAsync } = useSignMessage();
  const { writeContract: writeContractAsync } = useWalletSend();

  const settledPaste = useDebounced(pasted);
  const payment = usePaymentCheck(agent, client, pasted.trim() ? pasted : selected, pasted !== settledPaste);

  const isOwner = client.toLowerCase() === agent.owner.toLowerCase();
  const tag2 = tag1 === 'quality' ? qualityCategory : misconductCategory;
  const draft: ReviewDraft = {
    agentId: agent.agentId,
    client,
    value,
    tag1,
    tag2,
    endpoint: endpoint.trim(),
    comment,
    proofOfPayment: citedProof(payment.state),
  };
  const bytes = draftBytes(draft);
  const tooLong = bytes >= MAX_FILE_BYTES;

  const busy = step !== null || phase === 'signing' || phase === 'confirming';
  const locked = busy || phase === 'unknown';
  const hold = locked || phase === 'done';
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  useEffect(() => onHoldChange(hold), [hold, onHoldChange]);
  useEffect(
    () => () => {
      onBusyChange(false);
      onHoldChange(false);
    },
    [onBusyChange, onHoldChange],
  );

  function forget() {
    attempt.current = null;
    clearReviewAttempt(client, agent.agentId);
  }

  function finished() {
    forget();
    onConfirmed(reviewsBefore.current);
  }

  /** The published file, reused on a retry unless the form changed. Nothing is on-chain yet at this point. */
  async function publish(key: string): Promise<ReviewFileResponse> {
    if (uploaded.current?.key === key) return uploaded.current.response;
    try {
      const file = buildReviewFile(draft, new Date());
      setStep('sign-file');
      const signature = await signMessageAsync({ account: client, message: { raw: serializeReviewFile(file) } });
      setStep('upload');
      const response = await postReviewFile(file, signature);
      uploaded.current = { key, response };
      return response;
    } catch (err) {
      // Nothing reached the wallet, so TransactionButton offers a plain Retry.
      throw new NotSentError(err);
    }
  }

  async function submit(): Promise<Hash> {
    reviewsBefore.current = agent.reviews.filter((r) => r.clientAddress.toLowerCase() === client.toLowerCase()).length;
    walletAsked.current = false;
    try {
      const upload = await publish(JSON.stringify(draft));
      attempt.current = { startedAt: Date.now(), reviewsBefore: reviewsBefore.current, draft, upload };
      saveReviewAttempt(client, agent.agentId, attempt.current);
      walletAsked.current = true;
      setStep('sign-tx');
      // The file names this wallet, so the transaction must come from it even if the wallet has moved on.
      return await writeContractAsync({
        address: REPUTATION_REGISTRY,
        abi: reputationRegistryAbi,
        functionName: 'giveFeedback',
        args: [BigInt(agent.agentId), BigInt(value), 0, tag1, tag2, draft.endpoint, upload.feedbackUri, upload.feedbackHash],
        gas: GAS.giveFeedback,
      });
    } finally {
      setStep(null);
    }
  }

  // A payment left unresolved has to be fixed or cleared, so it is never silently dropped from the review.
  const paymentChosen = (pasted.trim() || selected) !== '' && payment.state.kind !== 'unavailable';
  const paymentOpen = (paymentChosen && payment.state.kind !== 'verified') || paymentSending;
  const canSubmit = !isOwner && !tooLong && draft.endpoint !== '' && !paymentOpen;

  return (
    <>
      <fieldset className="review-fields" disabled={locked} hidden={phase === 'done'}>
        {isOwner ? <InlineError message="You can’t review your own agent." /> : <Eligibility agent={agent} client={client} />}

        <PaymentField
          agent={agent}
          client={client}
          check={payment}
          selected={selected}
          pasted={pasted}
          onSelect={setSelected}
          onPaste={setPasted}
          onSending={setPaymentSending}
          onPaid={(proof) => {
            setSelected('');
            setPasted(proof);
          }}
        />

        <div className="field">
          <div className="field-head">
            <label htmlFor="review-rating">Rating</label>
            <output htmlFor="review-rating" className="review-number">
              {value}
            </output>
          </div>
          <input
            id="review-rating"
            className="review-range"
            type="range"
            min={0}
            max={100}
            step={1}
            value={value}
            onChange={(e) => setValue(Number(e.target.value))}
          />
          <div className="chips" role="group" aria-label="Quick ratings">
            {QUICK_PICKS.map((pick) => (
              <button
                key={pick}
                type="button"
                className={`chip chip-toggle${pick === value ? ' is-on' : ''}`}
                aria-pressed={pick === value}
                onClick={() => setValue(pick)}
              >
                {pick}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span id="review-type">Type</span>
          <div className="chips" role="group" aria-labelledby="review-type">
            {(['quality', 'misconduct'] as const).map((type) => (
              <button
                key={type}
                type="button"
                className={`chip chip-toggle${type === tag1 ? ' is-on' : ''}`}
                aria-pressed={type === tag1}
                onClick={() => setTag1(type)}
              >
                {type === 'quality' ? 'Quality' : 'Misconduct'}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label htmlFor="review-category">Category</label>
          {tag1 === 'quality' ? (
            <select id="review-category" className="input" value={qualityCategory} onChange={(e) => setQualityCategory(e.target.value)}>
              {QUALITY_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <>
              <select id="review-category" className="input" value={misconductCategory} onChange={(e) => setMisconductCategory(e.target.value)}>
                {MISCONDUCT_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <p className="note-warn">Counts against the creator once 2 creators confirm.</p>
            </>
          )}
        </div>

        <div className="field">
          <label htmlFor="review-endpoint">Endpoint used</label>
          {endpoints.length > 0 ? (
            <select id="review-endpoint" className="input" value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
              {endpoints.map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}: {e.value}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                id="review-endpoint"
                className="input"
                autoComplete="off"
                maxLength={MAX_ENDPOINT_LENGTH}
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
              <span className="muted">This agent lists no endpoints, so name the one you used.</span>
            </>
          )}
        </div>

        <div className="field">
          <div className="field-head">
            <label htmlFor="review-comment">Comment</label>
            <span className="muted">
              {comment.length} / {MAX_COMMENT_LENGTH}
            </span>
          </div>
          <textarea
            id="review-comment"
            className="input"
            rows={4}
            maxLength={MAX_COMMENT_LENGTH}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          {tooLong && (
            <span className="error-text" role="alert">
              This review is {bytes.toLocaleString('en-GB')} bytes, and it must be under {MAX_FILE_BYTES.toLocaleString('en-GB')}. Shorten the comment.
            </span>
          )}
        </div>
      </fieldset>

      <div className={`review-submit${step ? ' has-step' : ''}${phase === 'done' ? ' tx-finished' : ''}`}>
        {step && (
          <p className="tx-note" role="status">
            {STEP_TEXT[step]}
          </p>
        )}
        <TransactionButton
          label="Submit review"
          disabled={!canSubmit}
          resendRisk="Submitting again could post a second review."
          resumeHash={resumed?.hash}
          resumeStartedAt={resumed && !resumed.hash ? resumed.startedAt : undefined}
          onSend={submit}
          onSubmitted={(hash) => {
            if (!attempt.current) return;
            attempt.current = { ...attempt.current, hash };
            saveReviewAttempt(client, agent.agentId, attempt.current);
          }}
          onFailed={forget}
          onNotSent={() => {
            if (walletAsked.current) forget();
          }}
          onConfirmed={finished}
          findSent={(signal) => {
            const sent = attempt.current;
            return sent ? findFeedback(agent.agentId, client, sent.upload.feedbackHash, sent.startedAt, signal) : Promise.resolve(null);
          }}
          onFound={finished}
          onPhase={setPhase}
        />
        {phase === 'idle' && <CostHint usd={0.02} />}
        {phase === 'done' && (
          <>
            <p className="muted">Your review is on Hedera. It joins the list below once it’s indexed, usually within a minute.</p>
            <DialogDone onClose={onClose} />
          </>
        )}
      </div>
    </>
  );
}

interface Props {
  agent: AgentDetail;
  client: Address | undefined;
  open: boolean;
  onClose: () => void;
  onConfirmed: (reviewsBefore: number) => void;
}

export function ReviewModal({ agent, client, open, onClose, onConfirmed }: Props) {
  const [busy, setBusy] = useState(false);
  const [hold, setHold] = useState(false);
  // A wallet that disconnects mid-review must not take the form with it: its watcher is what finishes the job.
  const [lastClient, setLastClient] = useState(client);
  if (client && client !== lastClient) setLastClient(client);
  const formClient = client ?? (hold ? lastClient : undefined);
  // Disconnected, nothing here can move on by itself, so closing has to stay possible.
  const closeBlocked = busy && client !== undefined;

  return (
    <Dialog open={open} onClose={onClose} busy={closeBlocked} labelledBy="review-title" className="dialog-review">
      <header className="dialog-head">
        <h2 id="review-title">Review {agent.name}</h2>
        <button type="button" className="toast-close" aria-label="Close" disabled={closeBlocked} onClick={onClose}>
          ×
        </button>
      </header>
      {formClient ? (
        // Keyed by wallet: another wallet's form must not show this one's review in progress.
        <ReviewForm
          key={formClient}
          agent={agent}
          client={formClient}
          onBusyChange={setBusy}
          onHoldChange={setHold}
          onConfirmed={onConfirmed}
          onClose={onClose}
        />
      ) : (
        <div className="row">
          <p className="muted">Connect your wallet to leave a review.</p>
          <WalletButton />
        </div>
      )}
    </Dialog>
  );
}
