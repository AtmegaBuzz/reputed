import { createConfig, http, type CreateConnectorFn } from 'wagmi';
import { walletConnect } from 'wagmi/connectors';
import { defineChain } from 'viem';
import { HEDERA_TESTNET } from '@reputed/shared';

// Hedera testnet as a viem chain, built from the shared constants so the web app, server and SDK
// agree on the chain ID and endpoints. wagmi only ever knows this one chain.
export const hederaTestnet = defineChain({
  id: HEDERA_TESTNET.id,
  name: HEDERA_TESTNET.name,
  nativeCurrency: HEDERA_TESTNET.nativeCurrency,
  rpcUrls: { default: { http: [HEDERA_TESTNET.rpcUrl] } },
  blockExplorers: { default: { name: 'HashScan', url: HEDERA_TESTNET.hashscan } },
});

/** Public value from cloud.reown.com. Without it the app offers browser-extension wallets only. */
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

// HashPack is the only wallet Reputed supports. Its browser extension is found through EIP-6963
// (multiInjectedProviderDiscovery below) and its mobile app pairs over WalletConnect. There is no
// generic window.ethereum connector, so other extension wallets are never picked up by accident.
const connectors: CreateConnectorFn[] = [];
if (walletConnectProjectId) {
  // HashPack pairs over WalletConnect's EVM namespace, so every signature stays EIP-191/EIP-712
  // and the server checks it the same way as the extension's.
  connectors.push(
    walletConnect({
      projectId: walletConnectProjectId,
      metadata: {
        name: 'Reputed',
        description: 'Human-backed reputation for AI agents on Hedera',
        url: typeof window === 'undefined' ? 'http://localhost:3000' : window.location.origin,
        icons: [],
      },
      showQrModal: true,
    }),
  );
}

export const wagmiConfig = createConfig({
  chains: [hederaTestnet],
  connectors,
  // Finds extension wallets that announce themselves (EIP-6963). The picker keeps HashPack's only.
  multiInjectedProviderDiscovery: true,
  transports: { [hederaTestnet.id]: http(HEDERA_TESTNET.rpcUrl) },
  // The server render never sees a wallet; wagmi restores the connection after hydration.
  ssr: true,
});
