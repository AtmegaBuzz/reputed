import type { Role } from '../agents';
import type { Behavior } from '../provider';
import type { SkillId } from '../skills';

// Who is in the simulation. Two teams, one per verified human (one API key each). Reviews between
// agents of the same human do not count, so agents only ever hire the other team.
//
// Names and ports are part of each agent's on-chain registration (the agent kit finds an agent again
// by its account and name, and the registered endpoint is http://localhost:<port>). Never change them
// once the agents exist, or the next run registers new agents.

export type TeamId = 'A' | 'B';
export type PersonaId = 'steady' | 'sloppy' | 'erratic';

export interface Persona {
  id: PersonaId;
  /** Chances per job. Whatever is left is a correct, fast answer. */
  ghost: number;
  wrong: number;
  slow: number;
  summary: string;
}

// What each kind of answer is rated (hirer.ts): correct and fast 95, correct but slow 80, wrong 20,
// paid but nothing delivered 0. Long run, a steady agent averages about 90, a sloppy one about 72
// and an erratic one about 51, below the default MIN_SCORE of 60.
export const PERSONAS: Record<PersonaId, Persona> = {
  steady: { id: 'steady', ghost: 0, wrong: 0.05, slow: 0.1, summary: 'almost always right and fast' },
  sloppy: { id: 'sloppy', ghost: 0, wrong: 0.25, slow: 0.35, summary: 'often slow, sometimes wrong' },
  erratic: { id: 'erratic', ghost: 0.1, wrong: 0.45, slow: 0.1, summary: 'wrong about half the time, now and then keeps the money' },
};

/**
 * Swings, so every run moves every human's score both ways: on each team one agent is in a slump
 * (mostly wrong, its score and its creator's fall) and another is on a streak (always right, they
 * rise). Picked at random each run; off with SWINGS=0.
 */
export type Form = 'slump' | 'streak';
export const FORMS: Record<Form, Persona> = {
  slump: { id: 'erratic', ghost: 0.1, wrong: 0.6, slow: 0.1, summary: 'in a slump this run: mostly wrong' },
  streak: { id: 'steady', ghost: 0, wrong: 0, slow: 0.05, summary: 'on a streak this run: always right' },
};

/**
 * A slump only shows if the agent still gets hired, so it goes to an agent `canSlump` accepts (one at
 * or above MIN_SCORE) when the team has one. The streak goes to a different agent.
 */
export function drawForms(members: Member[], random: () => number = Math.random, canSlump: (member: Member) => boolean = () => true): Map<string, Form> {
  const forms = new Map<string, Form>();
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
  for (const team of ['A', 'B'] as const) {
    const mine = members.filter((member) => member.team === team);
    if (mine.length === 0) continue;
    if (mine.length === 1) {
      forms.set(mine[0]!.id, random() < 0.5 ? 'slump' : 'streak');
      continue;
    }
    const hirable = mine.filter(canSlump);
    const slump = pick(hirable.length ? hirable : mine);
    const streak = pick(mine.filter((member) => member !== slump));
    forms.set(slump.id, 'slump');
    forms.set(streak.id, 'streak');
  }
  return forms;
}

/** How a member behaves this run: its form if it has one, otherwise its persona. */
export const behaviorPersona = (member: Member): Persona => (member.form ? FORMS[member.form] : member.persona);

export function isPersona(value: string | undefined): value is PersonaId {
  return value !== undefined && Object.hasOwn(PERSONAS, value);
}

/** One job's behavior, drawn from the persona's chances. */
export function drawBehavior(persona: Persona, roll: number = Math.random()): Behavior {
  if (roll < persona.ghost) return 'ghost';
  if (roll < persona.ghost + persona.wrong) return 'wrong';
  if (roll < persona.ghost + persona.wrong + persona.slow) return 'slow';
  return 'honest';
}

interface Slot {
  name: string;
  skill: SkillId;
  persona: PersonaId;
}

export const MAX_PER_TEAM = 5;

const SLOTS: Record<TeamId, Slot[]> = {
  A: [
    { name: 'Prime Pilot', skill: 'factor', persona: 'steady' },
    { name: 'Digest Desk', skill: 'sha256', persona: 'sloppy' },
    { name: 'Factor Fox', skill: 'factor', persona: 'erratic' },
    { name: 'Hash Hound', skill: 'sha256', persona: 'steady' },
    { name: 'Prime Pantry', skill: 'factor', persona: 'sloppy' },
  ],
  B: [
    { name: 'Hash Harbor', skill: 'sha256', persona: 'steady' },
    { name: 'Factor Forge', skill: 'factor', persona: 'sloppy' },
    { name: 'Digest Dock', skill: 'sha256', persona: 'erratic' },
    { name: 'Prime Parrot', skill: 'factor', persona: 'steady' },
    { name: 'Hash Hatch', skill: 'sha256', persona: 'sloppy' },
  ],
};

const PORT_BASE: Record<TeamId, number> = { A: 4200, B: 4210 };
export const PRICE_HBAR = 0.1;

const DESCRIPTIONS: Record<SkillId, string> = {
  factor: 'Finds the prime factors of a number, for 0.1 HBAR a job. Reputed reputation simulation.',
  sha256: 'Notarizes a text with its SHA-256 digest, for 0.1 HBAR a job. Reputed reputation simulation.',
};

export interface Member {
  /** A1, A2, B1… Also the prefix of its settings in .env.test (A1_KEY, A1_PERSONA). */
  id: string;
  team: TeamId;
  /** 0-based position in its team. */
  index: number;
  name: string;
  skill: SkillId;
  persona: Persona;
  /** This run's swing, if any (drawForms). */
  form?: Form;
  port: number;
  url: string;
  /** What the provider serves and what a hirer buys from it. */
  role: Role;
}

/** The first `perTeam` slots of each team, with personas overridden by `personaOf(id)` where set. */
export function buildMembers(perTeam: number, personaOf: (id: string) => PersonaId | undefined = () => undefined): Member[] {
  const members: Member[] = [];
  for (const team of ['A', 'B'] as const) {
    SLOTS[team].slice(0, perTeam).forEach((slot, index) => {
      const id = `${team}${index + 1}`;
      const port = PORT_BASE[team] + index + 1;
      const url = `http://localhost:${port}`;
      const role: Role = {
        side: team === 'A' ? 'a' : 'b',
        name: slot.name,
        description: DESCRIPTIONS[slot.skill],
        skill: slot.skill,
        priceHbar: PRICE_HBAR,
        defaultPort: port,
      };
      members.push({ id, team, index, name: slot.name, skill: slot.skill, persona: PERSONAS[personaOf(id) ?? slot.persona], port, url, role });
    });
  }
  return members;
}

/**
 * Who hires whom in a round (1-based). Every agent hires exactly one agent of the other team and is
 * hired by exactly one, and over `perTeam` rounds each agent hires every agent of the other team.
 */
export function pairings(perTeam: number, round: number): { hirer: string; provider: string }[] {
  const pairs: { hirer: string; provider: string }[] = [];
  for (let i = 0; i < perTeam; i++) pairs.push({ hirer: `A${i + 1}`, provider: `B${((i + round - 1) % perTeam) + 1}` });
  for (let i = 0; i < perTeam; i++) pairs.push({ hirer: `B${i + 1}`, provider: `A${((i + round) % perTeam) + 1}` });
  return pairs;
}
