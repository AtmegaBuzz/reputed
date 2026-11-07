import {
  BaseError,
  ChainMismatchError,
  InsufficientFundsError,
  InvalidInputRpcError,
  InvalidParamsRpcError,
  MethodNotFoundRpcError,
  MethodNotSupportedRpcError,
  UnauthorizedProviderError,
  UserRejectedRequestError,
} from 'viem';
import { ConnectorAccountNotFoundError, ConnectorChainMismatchError } from 'wagmi';

const TOP_UP = 'Not enough HBAR. Top up from the testnet faucet.';
const WRONG_CHAIN = 'Your wallet is on another network. Switch it to Hedera Testnet, then retry.';
const UNSUPPORTED = 'Your wallet refused this request as unsupported, so nothing was sent. Check the browser console for details.';
// A wallet that does not implement the send method refuses it before signing anything.
const UNSUPPORTED_TEXT = /unsupported method|method not (found|supported)/i;
const ACCOUNT_GONE = 'Your wallet no longer shares this account with this site. Switch back to it, then try again.';

/**
 * Thrown by a send when it stopped before asking the wallet for the transaction, for example at a
 * refused signature or a failed upload. Nothing can have reached the chain, so Retry is safe.
 */
export class NotSentError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : 'Something went wrong.');
    this.name = 'NotSentError';
  }
}

export const notSent = (message: string) => new NotSentError(new Error(message));

export interface WalletErrorText {
  /** The user said no in their wallet. */
  rejected: boolean;
  message: string;
  /**
   * Certain that no transaction left the wallet. When false the outcome is unknown: a wallet can report
   * an error after the relay accepted the transaction, so it must not be sent again without checking.
   */
  notSent: boolean;
}

/** Plain language for anything a wallet or relay throws, and what it says about the transaction. */
export function describeWalletError(err: unknown): WalletErrorText {
  if (err instanceof NotSentError) return { ...describeWalletError(err.original), notSent: true };
  // wagmi throws these before it contacts the wallet.
  if (err instanceof ConnectorAccountNotFoundError || (err instanceof Error && err.name === 'ConnectorNotConnectedError')) {
    return { rejected: false, message: ACCOUNT_GONE, notSent: true };
  }
  if (err instanceof ConnectorChainMismatchError) return { rejected: false, message: WRONG_CHAIN, notSent: true };
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return { rejected: true, message: '', notSent: true };
    if (err.walk((e) => e instanceof InsufficientFundsError)) return { rejected: false, message: TOP_UP, notSent: true };
    // The relay words a low balance in Hedera's terms, which viem does not classify.
    if (/insufficient (funds|balance|payer|account)/i.test(err.message)) return { rejected: false, message: TOP_UP, notSent: true };
    if (err.walk((e) => e instanceof UnauthorizedProviderError)) return { rejected: false, message: ACCOUNT_GONE, notSent: true };
    if (err.walk((e) => e instanceof ChainMismatchError)) return { rejected: false, message: WRONG_CHAIN, notSent: true };
    if (err.walk((e) => e instanceof MethodNotSupportedRpcError || e instanceof MethodNotFoundRpcError) || UNSUPPORTED_TEXT.test(err.message)) {
      return { rejected: false, message: UNSUPPORTED, notSent: true };
    }
    // The wallet turned the request down before signing it, so nothing was sent. Its words say why.
    const refused = err.walk((e) => e instanceof InvalidParamsRpcError || e instanceof InvalidInputRpcError);
    if (refused instanceof BaseError) {
      return { rejected: false, message: `Your wallet refused this transaction, so nothing was sent: ${refused.details || refused.shortMessage}`, notSent: true };
    }
    // Anything else may have come back after the relay accepted the send, so the outcome is open.
    return { rejected: false, message: err.shortMessage, notSent: false };
  }
  const message = err instanceof Error ? (err.message.split('\n')[0] ?? 'Something went wrong.') : 'Something went wrong.';
  if (UNSUPPORTED_TEXT.test(message)) return { rejected: false, message: UNSUPPORTED, notSent: true };
  const rejected = /user (rejected|denied)/i.test(message);
  return { rejected, message, notSent: rejected };
}
