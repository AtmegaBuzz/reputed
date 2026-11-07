import { Client, PrivateKey } from '@hiero-ledger/sdk';
import { recoverMessageAddress, getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { ReputedAgentError } from '../src/errors';
import { clientGateway } from '../src/gateway';

describe('clientGateway.signMessage', () => {
  it('signs EIP-191 with the Client’s own operator signer, byte-identical to viem', async () => {
    const key = PrivateKey.generateECDSA();
    const client = Client.forTestnet().setOperator('0.0.1234', key);
    try {
      const message = new TextEncoder().encode('{"agentId":7,"value":92}');
      const signature = await clientGateway(client).signMessage(message);
      const account = privateKeyToAccount(`0x${key.toStringRaw()}` as Hex);
      expect(signature).toBe(await account.signMessage({ message: { raw: message } }));
      expect(await recoverMessageAddress({ message: { raw: message }, signature })).toBe(getAddress(`0x${key.publicKey.toEvmAddress()}`));
    } finally {
      client.close();
    }
  });

  it('works for many keys and lengths (both recovery parities occur)', async () => {
    for (let i = 0; i < 12; i++) {
      const key = PrivateKey.generateECDSA();
      const client = Client.forTestnet().setOperator('0.0.1234', key);
      try {
        const message = new TextEncoder().encode('x'.repeat(i * 37));
        const signature = await clientGateway(client).signMessage(message);
        expect(await recoverMessageAddress({ message: { raw: message }, signature })).toBe(getAddress(`0x${key.publicKey.toEvmAddress()}`));
      } finally {
        client.close();
      }
    }
  });

  it('refuses an Ed25519 operator with UNSUPPORTED_KEY', async () => {
    const client = Client.forTestnet().setOperator('0.0.1234', PrivateKey.generateED25519());
    try {
      await clientGateway(client).signMessage(new Uint8Array([1, 2, 3]));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ReputedAgentError);
      expect((error as ReputedAgentError).code).toBe('UNSUPPORTED_KEY');
    } finally {
      client.close();
    }
  });

  it('refuses a custom signer whose signature does not recover to the key', async () => {
    const key = PrivateKey.generateECDSA();
    const other = PrivateKey.generateECDSA();
    const client = Client.forTestnet().setOperatorWith('0.0.1234', key.publicKey, async (message) => other.sign(message));
    try {
      await clientGateway(client).signMessage(new Uint8Array([1]));
      expect.unreachable();
    } catch (error) {
      expect((error as ReputedAgentError).code).toBe('UNSUPPORTED_KEY');
    } finally {
      client.close();
    }
  });
});
