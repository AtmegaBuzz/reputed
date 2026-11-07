import {
  AccountId,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  HbarUnit,
  ReceiptStatusError,
  TokenAssociateTransaction,
  TransferTransaction,
  type Client,
} from '@hiero-ledger/sdk';
import { bytesToHex, concat, getAddress, recoverMessageAddress, serializeSignature, stringToBytes, type Address, type Hex } from 'viem';
import { ReputedAgentError } from './errors';

// The only place the Hedera SDK sends or signs anything. Reads go through the Mirror Node, so onboarding
// needs just two operations from an account: execute a contract call and associate a token. Payments
// and reviews add an HBAR transfer and an EIP-191 signature. Tests implement these interfaces in memory
// and never touch a Client.

export interface TxOutcome {
  /** In the Mirror Node's spelling: 0.0.1234-1700000000-123456789. */
  transactionId: string;
  /** The receipt status, for example SUCCESS or CONTRACT_REVERT_EXECUTED. */
  status: string;
}

/** What onboarding needs from a Hedera account. Tests replace it with a fake. */
export interface HederaGateway {
  readonly accountId: string;
  executeContract(contractId: string, data: Hex, gas: bigint): Promise<TxOutcome>;
  associateToken(tokenId: string): Promise<TxOutcome>;
}

/** What payments and reviews need on top of onboarding: send HBAR, and sign a review file. */
export interface AgentGateway extends HederaGateway {
  /** Sends `tinybar` from this account to another account, as a plain CryptoTransfer. */
  transferHbar(toAccountId: string, tinybar: bigint, memo?: string): Promise<TxOutcome>;
  /**
   * An EIP-191 (personal_sign) signature over raw bytes by the operator key, as a 65-byte hex string.
   * Throws UNSUPPORTED_KEY when the operator is not an ECDSA (secp256k1) key.
   */
  signMessage(message: Uint8Array): Promise<Hex>;
}

/** 0.0.1234@1700000000.123456789 → 0.0.1234-1700000000-123456789 */
export function toMirrorTransactionId(id: string): string {
  const [account = '', time = ''] = id.split('@');
  return `${account}-${time.replace('.', '-')}`;
}

/** Waits for the receipt and reports its status. The receipt has no logs; the Mirror Node is read for those afterwards. */
async function settle(client: Client, response: { transactionId: { toString(): string }; getReceipt(client: Client): Promise<{ status: { toString(): string } }> }): Promise<TxOutcome> {
  const transactionId = toMirrorTransactionId(response.transactionId.toString());
  try {
    const receipt = await response.getReceipt(client);
    return { transactionId, status: receipt.status.toString() };
  } catch (error) {
    // A revert still has a transaction ID and a result on the Mirror Node, which says why.
    if (error instanceof ReceiptStatusError) return { transactionId, status: error.status.toString() };
    throw error;
  }
}

/**
 * Maps a failure before consensus (precheck) to an error code. Nothing was recorded or charged, so the
 * caller can drop any state it wrote for the send. Receipt errors carry a consensus result and are
 * handled by settle instead.
 */
function precheckFailure(error: unknown): ReputedAgentError | null {
  const status = (error as { status?: { toString(): string } } | null)?.status?.toString();
  if (!status || !(error instanceof Error) || error.name === 'ReceiptStatusError') return null;
  if (status === 'INSUFFICIENT_PAYER_BALANCE') {
    return new ReputedAgentError('INSUFFICIENT_HBAR', 'The agent account does not have enough HBAR to pay for this transaction.', { cause: error });
  }
  return new ReputedAgentError('TRANSACTION_FAILED', `Hedera rejected the transaction: ${status}.`, { cause: error });
}

/** The order of the secp256k1 group: an s above half of it is flipped to the low form wallets and viem produce. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * EIP-191 with the Client's own signer, so the private key is never asked for twice. A Hedera ECDSA
 * key signs keccak256(message), so signing the prefixed message yields a signature over exactly the
 * digest personal_sign uses. The signer returns r‖s without a recovery bit, so both parities are tried
 * against the key's EVM address. Any signer that does something else (another curve, a pre-hashed
 * KMS call) fails that check and is reported rather than producing a signature nobody can verify.
 */
async function signPersonal(
  transactionSigner: (message: Uint8Array) => Promise<Uint8Array>,
  signerAddress: Address,
  message: Uint8Array,
): Promise<Hex> {
  const prefixed = concat([stringToBytes(`\x19Ethereum Signed Message:\n${message.length}`), message]);
  const raw = await transactionSigner(prefixed);
  if (raw.length !== 64) {
    throw new ReputedAgentError('UNSUPPORTED_KEY', `The operator's signer returned ${raw.length} bytes, not a 64-byte ECDSA signature.`);
  }
  const r = bytesToHex(raw.slice(0, 32));
  const s = BigInt(bytesToHex(raw.slice(32, 64)));
  // Flipping s flips the recovery parity too, but both parities are tried below anyway.
  const low = s > SECP256K1_N / 2n ? SECP256K1_N - s : s;
  const sHex = `0x${low.toString(16).padStart(64, '0')}` as Hex;
  for (const yParity of [0, 1] as const) {
    const signature = serializeSignature({ r, s: sHex, yParity });
    try {
      if ((await recoverMessageAddress({ message: { raw: message }, signature })) === signerAddress) return signature;
    } catch {
      // Not a valid point for this parity: try the other one.
    }
  }
  throw new ReputedAgentError('UNSUPPORTED_KEY', `The operator's signature does not recover to its EVM address ${signerAddress}.`);
}

export function clientGateway(client: Client): AgentGateway {
  const operator = client.operatorAccountId;
  if (!operator) {
    throw new ReputedAgentError('NO_OPERATOR', 'The Hedera Client has no operator. Call client.setOperator(accountId, privateKey) first.');
  }

  return {
    accountId: operator.toString(),
    async executeContract(contractId, data, gas) {
      try {
        const response = await new ContractExecuteTransaction()
          .setContractId(ContractId.fromString(contractId))
          .setGas(Number(gas))
          // Calldata is ABI-encoded by viem upstream, so one ABI serves both the Mirror Node reads and the sends.
          .setFunctionParameters(Buffer.from(data.slice(2), 'hex'))
          .execute(client);
        return await settle(client, response);
      } catch (error) {
        throw precheckFailure(error) ?? error;
      }
    },
    async associateToken(tokenId) {
      try {
        const response = await new TokenAssociateTransaction().setAccountId(operator).setTokenIds([tokenId]).execute(client);
        return await settle(client, response);
      } catch (error) {
        throw precheckFailure(error) ?? error;
      }
    },
    async transferHbar(toAccountId, tinybar, memo) {
      const amount = Hbar.from(tinybar.toString(), HbarUnit.Tinybar);
      const tx = new TransferTransaction()
        .addHbarTransfer(operator, amount.negated())
        .addHbarTransfer(AccountId.fromString(toAccountId), amount);
      if (memo) tx.setTransactionMemo(memo);
      let response;
      try {
        response = await tx.execute(client);
      } catch (error) {
        throw precheckFailure(error) ?? error;
      }
      // Submitted: from here on the HBAR may have moved, so a lost receipt must not read as "not paid".
      try {
        return await settle(client, response);
      } catch (error) {
        const transactionId = toMirrorTransactionId(response.transactionId.toString());
        throw new ReputedAgentError(
          'TIMEOUT',
          `Payment ${transactionId} was submitted but its receipt could not be read. Look it up before paying again.`,
          { cause: error, transactionId },
        );
      }
    },
    async signMessage(message) {
      const signer = client.getOperator();
      if (!signer) throw new ReputedAgentError('NO_OPERATOR', 'The Hedera Client has no operator.');
      if (signer.publicKey.type !== 'secp256k1') {
        throw new ReputedAgentError(
          'UNSUPPORTED_KEY',
          `Reviews are signed with an EVM signature, so the agent account needs an ECDSA (secp256k1) key; account ${operator.toString()} has a ${signer.publicKey.type} key.`,
        );
      }
      return signPersonal(signer.transactionSigner, getAddress(`0x${signer.publicKey.toEvmAddress()}`), message);
    },
  };
}
