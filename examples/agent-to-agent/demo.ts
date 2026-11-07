// Runs both agents in one terminal and prints the final scores. Each agent is its own process with
// its own Hedera account, exactly as `pnpm agent:a` and `pnpm agent:b` in two terminals.
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ReputedClient } from '@reputed/sdk';
import { logger, scoreLine } from './log';

const log = logger('demo', 'demo');
const script = fileURLToPath(new URL('./agent.ts', import.meta.url));
const api = new ReputedClient({ apiUrl: process.env['REPUTED_API_URL'] ?? 'http://localhost:4000' });

const children: ChildProcess[] = [];
const done = new Map<string, string>();

function stopAll(code: number): never {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGINT', () => stopAll(130));

log(`Starting agent A (Factor Finder) and agent B (Hash Notary), ${process.env['ROUNDS'] || 3} jobs each`);
const finished = new Promise<void>((resolve) => {
  for (const side of ['a', 'b'] as const) {
    const child = fork(script, [side], { execArgv: ['--import', 'tsx'], stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    children.push(child);
    child.on('message', (message: { type?: string; agentId?: string }) => {
      if (message.type === 'done' && message.agentId) {
        done.set(side, message.agentId);
        if (done.size === 2) resolve();
      }
    });
    child.on('exit', (code) => {
      if (done.size < 2) {
        log(`Agent ${side.toUpperCase()} stopped (exit ${code}) before the demo finished.`);
        stopAll(1);
      }
    });
  }
});

const timeout = setTimeout(() => {
  log('Gave up after 20 minutes.');
  stopAll(1);
}, 20 * 60_000);

await finished;
clearTimeout(timeout);
log('Both agents are done. Final scores on Reputed:');
for (const side of ['a', 'b'] as const) {
  const agent = await api.getAgent(done.get(side)!);
  log(`  ${side.toUpperCase()} ${scoreLine(agent)}`);
}
stopAll(0);
