// Testnet shortcut: makes one API key for each agent from two creators' wallet keys and writes them to
// .env as A_API_KEY and B_API_KEY. In real use each creator makes a key on the dashboard instead: World
// ID gives one person one creator record, so two creators are two people. On testnet the repo's test
// creators (TEST_CREATOR_n in the root .env) stand in for them.
//   pnpm testnet-keys            keeps keys that still work
//   pnpm testnet-keys --new      replaces both
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { creatorRegistryAbi, grantAddress, hbarForGas, GAS, HEDERA_TESTNET, newApiKey, type ConfigResponse } from '@reputed/shared';
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ENV = new URL('./.env', import.meta.url);
const EXAMPLE = new URL('./.env.example', import.meta.url);
const fresh = process.argv.includes('--new');

if (!existsSync(ENV)) {
  copyFileSync(EXAMPLE, ENV);
  console.log('Created .env from .env.example. Fill in A_PRIVATE_KEY, B_PRIVATE_KEY, A_CREATOR_KEY and B_CREATOR_KEY, then run this again.');
  process.exit(1);
}

const need = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set in .env.`);
    process.exit(1);
  }
  return value;
};
const hex = (key: string): Hex => `0x${key.replace(/^0x/, '')}`;

const apiUrl = (process.env['REPUTED_API_URL'] ?? 'http://localhost:4000').replace(/\/+$/, '');
const config = (await (await fetch(`${apiUrl}/api/config`)).json()) as ConfigResponse;
if (!config.creatorRegistry) throw new Error('The Reputed server has no CreatorRegistry configured.');
const registry = getAddress(config.creatorRegistry);

const chain = defineChain({
  id: HEDERA_TESTNET.id,
  name: HEDERA_TESTNET.name,
  nativeCurrency: HEDERA_TESTNET.nativeCurrency,
  rpcUrls: { default: { http: [HEDERA_TESTNET.rpcUrl] } },
});
const transport = http(HEDERA_TESTNET.rpcUrl, { retryCount: 3, retryDelay: 2_000, timeout: 60_000 });
const rpc = createPublicClient({ chain, transport });
const mirror = async <T>(path: string): Promise<T | null> => {
  const res = await fetch(`${HEDERA_TESTNET.mirrorNode}/api/v1${path}`);
  return res.ok ? ((await res.json()) as T) : null;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const creators = { a: privateKeyToAccount(hex(need('A_CREATOR_KEY'))), b: privateKeyToAccount(hex(need('B_CREATOR_KEY'))) };
if (creators.a.address === creators.b.address) {
  console.error('A_CREATOR_KEY and B_CREATOR_KEY are the same creator. Reviews between agents of one human do not count; use two creators.');
  process.exit(1);
}

let envText = readFileSync(ENV, 'utf8');
function setEnv(name: string, value: string): void {
  const line = `${name}=${value}`;
  envText = new RegExp(`^${name}=.*$`, 'm').test(envText) ? envText.replace(new RegExp(`^${name}=.*$`, 'm'), line) : `${envText.trimEnd()}\n${line}\n`;
}

async function keyStillWorks(apiKey: string, creator: Address): Promise<boolean> {
  try {
    const [owner, expiresAt, , , revoked] = await rpc.readContract({ address: registry, abi: creatorRegistryAbi, functionName: 'grants', args: [grantAddress(apiKey)] });
    return getAddress(owner) === creator && !revoked && expiresAt > BigInt(Math.floor(Date.now() / 1000) + 3_600);
  } catch {
    return false;
  }
}

for (const side of ['a', 'b'] as const) {
  const S = side.toUpperCase();
  const creator = creators[side];
  const isCreator = await rpc.readContract({ address: registry, abi: creatorRegistryAbi, functionName: 'isCreator', args: [creator.address] });
  if (!isCreator) {
    console.error(`${S}_CREATOR_KEY (${creator.address}) is not a verified creator in CreatorRegistry ${registry}.`);
    process.exit(1);
  }

  const current = process.env[`${S}_API_KEY`]?.trim();
  if (!fresh && current && (await keyStillWorks(current, creator.address))) {
    console.log(`${S}: the API key in .env still works for creator ${creator.address}; keeping it.`);
  } else {
    const balance = await rpc.getBalance({ address: creator.address });
    if (Number(balance) / 1e18 < hbarForGas(GAS.authorizeGrant) + 0.1) {
      console.error(`${S}: creator ${creator.address} needs about 0.5 HBAR to authorize a key.`);
      process.exit(1);
    }
    const apiKey = newApiKey('test');
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
    const wallet = createWalletClient({ account: creator, chain, transport });
    const gasPrice = await rpc.getGasPrice();
    // Room for one rename: an agent with a new name is a new agent and needs a second link.
    const hash = await wallet.writeContract({
      address: registry, abi: creatorRegistryAbi, functionName: 'authorizeGrant', args: [grantAddress(apiKey), expiresAt, 2],
      gas: GAS.authorizeGrant, gasPrice, type: 'legacy',
    } as never);
    let result: { result: string; error_message: string | null } | null = null;
    for (let i = 0; i < 40 && !result; i++) {
      await sleep(3_000);
      result = await mirror(`/contracts/results/${hash}`);
    }
    if (result?.result !== 'SUCCESS') {
      console.error(`${S}: authorizeGrant failed: ${result?.result ?? 'no result'} ${result?.error_message ?? ''} (${hash})`);
      process.exit(1);
    }
    setEnv(`${S}_API_KEY`, apiKey);
    writeFileSync(ENV, envText, { mode: 0o600 });
    console.log(`${S}: authorized a new API key for creator ${creator.address} (${hash}) and wrote ${S}_API_KEY to .env.`);
  }

  // The agent account: it must exist, have an ECDSA alias (reviews are signed with it) and some HBAR.
  const agentKey = process.env[`${S}_PRIVATE_KEY`]?.trim();
  if (!agentKey) {
    console.log(`${S}: set ${S}_PRIVATE_KEY to the agent's own account key.`);
    continue;
  }
  const evm = privateKeyToAccount(hex(agentKey)).address;
  if (evm === creator.address) console.log(`${S}: warning: the agent uses its creator's own key. Give the agent its own account.`);
  const account = await mirror<{ account: string; evm_address: string; balance: { balance: number } }>(`/accounts/${evm}`);
  if (!account) {
    console.log(`${S}: no testnet account for ${evm} yet. Send it 5 HBAR (that creates it), from the faucet or a funded account.`);
    continue;
  }
  const hbar = account.balance.balance / 1e8;
  console.log(`${S}: agent account ${account.account} (${evm}) has ${hbar.toFixed(2)} HBAR${hbar < 4 ? '. The first run needs about 2.5 HBAR to onboard plus about 0.5 per review: top it up.' : '.'}`);
}
console.log('\nNext: pnpm demo');
