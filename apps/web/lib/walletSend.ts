'use client';

import { useAccount } from 'wagmi';
import {
  createWalletClient,
  custom,
  encodeFunctionData,
  numberToHex,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type EIP1193Provider,
  type Hash,
  type Hex,
} from 'viem';
import { notSent } from './walletError';

/**
 * Sends a transaction through the connected wallet with one plain `eth_sendTransaction`.
 *
 * Not wagmi's writeContract/sendTransaction: when a wallet refuses `eth_sendTransaction`'s params,
 * viem retries with `wallet_sendTransaction`, and HashPack refuses that as unsupported, which hides
 * its real complaint. This sends only the fields every wallet accepts (no `chainId` or `type`; the
 * chain was checked before the send) and never retries, so an error is the wallet's own.
 */
export function useWalletSend() {
  const { connector, address } = useAccount();

  async function send(tx: { to: Address; data?: Hex; value?: bigint; gas: bigint }): Promise<Hash> {
    if (!connector || !address) throw notSent('Connect your wallet first.');
    const provider = (await connector.getProvider()) as EIP1193Provider;
    const wallet = createWalletClient({ transport: custom(provider, { retryCount: 0 }) });
    const params = {
      from: address,
      to: tx.to,
      ...(tx.data ? { data: tx.data } : {}),
      value: numberToHex(tx.value ?? 0n),
      gas: numberToHex(tx.gas),
    };
    try {
      return await wallet.request({ method: 'eth_sendTransaction', params: [params] }, { retryCount: 0 });
    } catch (err) {
      console.error('[tx] eth_sendTransaction refused', { params, err });
      throw err;
    }
  }

  function writeContract<
    const abi extends Abi,
    name extends ContractFunctionName<abi, 'nonpayable' | 'payable'>,
  >(call: {
    address: Address;
    abi: abi;
    functionName: name;
    args: ContractFunctionArgs<abi, 'nonpayable' | 'payable', name>;
    gas: bigint;
    value?: bigint;
  }): Promise<Hash> {
    const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as never);
    return send({ to: call.address, data, gas: call.gas, value: call.value });
  }

  return { send, writeContract };
}
