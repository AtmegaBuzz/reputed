import { describe, expect, it } from 'vitest';
import { neededHbar, topUpFor } from '../sim/funding';
import { buildMembers, drawBehavior, drawForms, pairings, PERSONAS } from '../sim/team';

describe('simulation', () => {
  it('each round, every agent hires one agent of the other team and is hired by one', () => {
    for (const perTeam of [1, 2, 3, 5]) {
      for (let round = 1; round <= perTeam + 1; round++) {
        const pairs = pairings(perTeam, round);
        expect(pairs).toHaveLength(2 * perTeam);
        expect(new Set(pairs.map((pair) => pair.hirer)).size).toBe(2 * perTeam);
        expect(new Set(pairs.map((pair) => pair.provider)).size).toBe(2 * perTeam);
        for (const pair of pairs) expect(pair.hirer[0]).not.toBe(pair.provider[0]);
      }
    }
  });

  it('over AGENTS_PER_TEAM rounds every agent hires every agent of the other team', () => {
    const seen = new Set<string>();
    for (let round = 1; round <= 3; round++) for (const pair of pairings(3, round)) seen.add(`${pair.hirer}>${pair.provider}`);
    expect(seen.size).toBe(18);
  });

  it('keeps agent names and ports, which are part of each registration', () => {
    // A changed name or port makes the next run register new agents instead of finding these.
    expect(buildMembers(3).map((m) => `${m.id} ${m.name} ${m.url}`)).toEqual([
      'A1 Prime Pilot http://localhost:4201',
      'A2 Digest Desk http://localhost:4202',
      'A3 Factor Fox http://localhost:4203',
      'B1 Hash Harbor http://localhost:4211',
      'B2 Factor Forge http://localhost:4212',
      'B3 Digest Dock http://localhost:4213',
    ]);
    expect(buildMembers(2, (id) => (id === 'A1' ? 'erratic' : undefined))[0]!.persona.id).toBe('erratic');
  });

  it('draws each behavior with the persona’s chances', () => {
    const erratic = PERSONAS.erratic;
    expect(drawBehavior(erratic, 0.05)).toBe('ghost');
    expect(drawBehavior(erratic, 0.3)).toBe('wrong');
    expect(drawBehavior(erratic, 0.6)).toBe('slow');
    expect(drawBehavior(erratic, 0.9)).toBe('honest');
    expect(drawBehavior(PERSONAS.steady, 0)).toBe('wrong');
  });

  it('gives each team one agent in a slump and a different one on a streak', () => {
    for (let i = 0; i < 50; i++) {
      const forms = drawForms(buildMembers(3));
      for (const team of ['A', 'B']) {
        const mine = [...forms].filter(([id]) => id.startsWith(team)).map(([, form]) => form).sort();
        expect(mine).toEqual(['slump', 'streak']);
      }
    }
    expect([...drawForms(buildMembers(1)).keys()].sort()).toEqual(['A1', 'B1']);
    // The slump goes to an agent that still gets hired, when there is one.
    for (let i = 0; i < 20; i++) {
      const forms = drawForms(buildMembers(3), Math.random, (member) => member.index === 1);
      expect(forms.get('A2')).toBe('slump');
      expect(forms.get('B2')).toBe('slump');
    }
  });

  it('tops an agent up only when it cannot finish the run', () => {
    expect(neededHbar(4, false)).toBeCloseTo(5.6);
    expect(topUpFor(0, 4, false)).toBe(6.6);
    expect(topUpFor(3, 4, true)).toBe(1.1);
    expect(topUpFor(3.1, 4, true)).toBe(0);
    expect(topUpFor(10, 4, true)).toBe(0);
  });
});
