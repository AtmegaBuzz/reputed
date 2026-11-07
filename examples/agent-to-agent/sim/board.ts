import type { AgentDetail } from '@reputed/shared';
import { short, type Log } from '../log';
import type { Member, TeamId } from './team';

// Terminal output: one colored tag per agent, so six agents can share a terminal, and a scoreboard
// after every round with each score's change since the last one.

const useColor = process.stdout.isTTY && !process.env['NO_COLOR'];
const paint = (code: string) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
export const bold = paint('1');
export const dim = paint('2');
export const green = paint('32');
export const red = paint('31');
export const yellow = paint('33');

const TEAM_COLORS: Record<TeamId, number[]> = { A: [39, 45, 81, 117, 33], B: [205, 213, 177, 209, 170] };

export function teamColor(member: Member): (text: string) => string {
  return paint(`38;5;${TEAM_COLORS[member.team][member.index % 5]}`);
}

export const tagOf = (member: Member): string => `${member.id} ${member.name}`;

export function memberLogger(member: Member, width: number): Log {
  const prefix = teamColor(member)(`[${tagOf(member).padEnd(width)}]`);
  return (message) => {
    for (const line of message.split('\n')) console.log(`${prefix} ${line}`);
  };
}

export const simLog: Log = (message) => {
  for (const line of message.split('\n')) console.log(`${yellow('[sim]')} ${line}`);
};

export function banner(title: string): void {
  console.log(`\n${bold(`━━ ${title} ${'━'.repeat(Math.max(4, 76 - title.length))}`)}`);
}

const num = (value: number | null | undefined): string => (value === null || value === undefined ? '—' : value.toFixed(2));

/** "▲ +12.50", "▼ -4.20", or a dot when nothing moved. Padded before it is colored. */
export function delta(now: number | null | undefined, before: number | null | undefined, width = 9): string {
  if (now === null || now === undefined || before === null || before === undefined) return ' '.repeat(width);
  const change = now - before;
  if (Math.abs(change) < 0.005) return dim('·'.padEnd(width));
  const text = `${change > 0 ? '▲ +' : '▼ '}${change.toFixed(2)}`.padEnd(width);
  return change > 0 ? green(text) : red(text);
}

export interface BoardRow {
  member: Member;
  detail: AgentDetail | null;
  hbar: number | null;
}

export interface Team {
  name: string;
  creator: string;
}

/** Scores by member ID and by creator address, to compare the next scoreboard with. */
export interface Scores {
  agents: Map<string, number>;
  creators: Map<string, number>;
}

export function printScoreboard(title: string, rows: BoardRow[], teams: Record<TeamId, Team>, previous: Scores | null): Scores {
  const now: Scores = { agents: new Map(), creators: new Map() };
  const nameWidth = Math.max(...rows.map((row) => `${tagOf(row.member)} #${row.detail?.agentId ?? '?'}`.length));
  const teamWidth = Math.max(...Object.values(teams).map((team) => team.name.length), 4);
  console.log(bold(`\n  ${title}`));
  console.log(
    dim(`  ${'Agent'.padEnd(nameWidth)}  ${'Team'.padEnd(teamWidth)}  ${'Persona'.padEnd(16)}  ${'Score'.padStart(7)}  ${'Change'.padEnd(9)}  ${'Tier'.padEnd(6)}  Reviews  HBAR`),
  );
  let inherited = false;
  for (const { member, detail, hbar } of rows) {
    const name = `${tagOf(member)} #${detail?.agentId ?? '?'}`.padEnd(nameWidth);
    const value = detail?.score.value ?? null;
    if (value !== null) now.agents.set(member.id, value);
    if (detail?.creator && detail.creatorScore !== null) now.creators.set(detail.creator.toLowerCase(), detail.creatorScore);
    const mark = detail?.score.isNew ? '*' : ' ';
    inherited ||= Boolean(detail?.score.isNew);
    const persona = `${member.persona.id}${member.form === 'slump' ? ' ↓slump' : member.form === 'streak' ? ' ↑streak' : ''}`.padEnd(16);
    console.log(
      `  ${teamColor(member)(name)}  ${teams[member.team].name.padEnd(teamWidth)}  ${member.form === 'slump' ? red(persona) : member.form === 'streak' ? green(persona) : persona}  ${bold(num(value).padStart(6))}${mark}  ${delta(value, previous?.agents.get(member.id))}  ${(detail?.score.tier ?? '—').padEnd(6)}  ${String(detail?.reviewsCounted ?? '—').padStart(7)}  ${hbar === null ? '—' : hbar.toFixed(2)}`,
    );
  }
  for (const team of Object.values(teams)) {
    const key = team.creator.toLowerCase();
    const value = now.creators.get(key);
    console.log(`  ${dim('Creator')} ${bold(team.name)} ${dim(short(team.creator))}: ${bold(num(value))} ${delta(value, previous?.creators.get(key)).trimEnd()}`);
  }
  if (inherited) console.log(dim('  * no counted reviews yet, so the agent shows its creator’s score'));
  return now;
}
