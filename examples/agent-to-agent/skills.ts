import { createHash } from 'node:crypto';

// The work the two agents sell each other. Both are deliberately checkable: the hirer can verify every
// answer itself, so its rating is a measurement, not an opinion. Swap these for real work (an LLM
// call, a booking, a data lookup) and keep the same shape: make a request, do it, judge the result.

export type SkillId = 'factor' | 'sha256';

export interface Verdict {
  correct: boolean;
  /** One line for the review comment. */
  detail: string;
}

export interface Skill {
  id: SkillId;
  description: string;
  /** The job a hirer sends: different every time, so answers cannot be cached. */
  makeInput(job: number, salt: string): unknown;
  /** Throws on input the provider should refuse (wrong shape, too big). */
  parseInput(input: unknown): unknown;
  /** The provider's side. `faulty` returns a plausible wrong answer, to show what a bad agent costs. */
  perform(input: unknown, faulty: boolean): unknown;
  /** The hirer's side: checks the answer independently. */
  check(input: unknown, output: unknown): Verdict;
}

// Factor Finder ------------------------------------------------------------------------------

const PRIMES = [
  10007, 10009, 10037, 10039, 10061, 10067, 10069, 10079, 10091, 10093, 10099, 10103, 10111, 10133, 10139,
  10141, 10151, 10159, 10163, 10169, 10177, 10181, 10193, 10211, 10223, 10243, 10247, 10253, 10259, 10267,
];
/** Below this, trial division answers in well under a millisecond. */
const MAX_N = 10n ** 12n;

function isPrime(n: bigint): boolean {
  if (n < 2n) return false;
  for (let d = 2n; d * d <= n; d += d === 2n ? 1n : 2n) if (n % d === 0n) return false;
  return true;
}

function factorize(n: bigint): bigint[] {
  const factors: bigint[] = [];
  let rest = n;
  for (let d = 2n; d * d <= rest; d += d === 2n ? 1n : 2n) {
    while (rest % d === 0n) {
      factors.push(d);
      rest /= d;
    }
  }
  if (rest > 1n) factors.push(rest);
  return factors;
}

function saltIndex(salt: string): number {
  return [...salt].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
}

const factor: Skill = {
  id: 'factor',
  description: 'Finds the prime factors of a whole number up to 10^12.',
  makeInput(job, salt) {
    const i = saltIndex(salt) + job * 7;
    const p = BigInt(PRIMES[i % PRIMES.length]!);
    const q = BigInt(PRIMES[(i * 3 + 11) % PRIMES.length]!);
    return { n: (p * q * BigInt(2 + (job % 5))).toString() };
  },
  parseInput(input) {
    const n = (input as { n?: unknown } | null)?.n;
    if (typeof n !== 'string' || !/^\d{1,13}$/.test(n) || BigInt(n) < 2n || BigInt(n) > MAX_N) {
      throw new Error('input.n must be a whole number from 2 to 10^12, as a string');
    }
    return { n };
  },
  perform(input, faulty) {
    const n = BigInt((input as { n: string }).n);
    // The faulty answer drops a factor, so the product no longer matches.
    const factors = factorize(n);
    return { factors: (faulty ? factors.slice(1) : factors).map(String) };
  },
  check(input, output) {
    const n = BigInt((input as { n: string }).n);
    const raw = (output as { factors?: unknown } | null)?.factors;
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((f) => typeof f === 'string' && /^\d{1,13}$/.test(f))) {
      return { correct: false, detail: `asked to factor ${n}, got no list of factors` };
    }
    const factors = raw.map((f) => BigInt(f as string));
    const product = factors.reduce((a, b) => a * b, 1n);
    if (product !== n) return { correct: false, detail: `factors of ${n} multiply to ${product}` };
    if (!factors.every(isPrime)) return { correct: false, detail: `factors of ${n} include a non-prime` };
    return { correct: true, detail: `${n} = ${factors.join(' × ')}` };
  },
};

// Hash Notary --------------------------------------------------------------------------------

const MEMOS = ['invoice for 3 GPU hours', 'delivery note for 40 kg of coffee', 'receipt for a flight change', 'contract addendum, clause 4.2', 'timesheet, week 45'];
const MAX_TEXT = 1_000;

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const sha256: Skill = {
  id: 'sha256',
  description: 'Notarizes a text: returns its SHA-256 digest, to be stored next to the original.',
  makeInput(job, salt) {
    return { text: `Job ${job} from ${salt}: ${MEMOS[(job + saltIndex(salt)) % MEMOS.length]}` };
  },
  parseInput(input) {
    const text = (input as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT) throw new Error(`input.text must be 1 to ${MAX_TEXT} characters`);
    return { text };
  },
  perform(input, faulty) {
    const { text } = input as { text: string };
    // The faulty answer hashes the text with a trailing newline: right length, wrong digest.
    return { sha256: sha256Hex(faulty ? `${text}\n` : text) };
  },
  check(input, output) {
    const { text } = input as { text: string };
    const got = (output as { sha256?: unknown } | null)?.sha256;
    const want = sha256Hex(text);
    if (typeof got !== 'string') return { correct: false, detail: 'no digest returned' };
    return got.toLowerCase() === want
      ? { correct: true, detail: `digest ${want.slice(0, 16)}… matches` }
      : { correct: false, detail: `digest ${got.slice(0, 16)}… should be ${want.slice(0, 16)}…` };
  },
};

export const SKILLS: Record<SkillId, Skill> = { factor, sha256 };

/** "2,5" → {2, 5}. */
export function parseJobList(value: string | undefined): Set<number> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}
