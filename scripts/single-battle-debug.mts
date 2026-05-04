/**
 * single-battle-debug.mts — runs one SimFight battle and dumps the round-by-
 * round troop counts so we can inspect how the simulator ends a fight.
 *
 * Usage: npx tsx scripts/single-battle-debug.mts
 */

const sim = (await import('../src/app/core/sim/simulator.service.ts')) as any;
const heroMod = (await import('../src/app/core/models/hero.model.ts')) as any;
const { SimFight, SimFighter } = sim.default ?? sim;
const { defaultTroopLevels } = heroMod.default ?? heroMod;

// Match the `vs city -25%` scenario the user is questioning:
//   200k attacker @ 5/1/4 vs 3M defender @ 5/2/3
//   defender stats = avg(player stats) × 0.75, applied flat
const playerStats = {
  inf:  { attack: 700, defense: 750, lethality: 450, health: 500 },
  lanc: { attack: 600, defense: 580, lethality: 380, health: 350 },
  mark: { attack: 800, defense: 700, lethality: 500, health: 450 },
};
const flatAvg =
  (700 + 750 + 450 + 500 +
   600 + 580 + 380 + 350 +
   800 + 700 + 500 + 450) / 12;
const ENEMY_SCALE = 0.75;
const flatEnemy = flatAvg * ENEMY_SCALE;
const enemyStats = {
  inf:  { attack: flatEnemy, defense: flatEnemy, lethality: flatEnemy, health: flatEnemy },
  lanc: { attack: flatEnemy, defense: flatEnemy, lethality: flatEnemy, health: flatEnemy },
  mark: { attack: flatEnemy, defense: flatEnemy, lethality: flatEnemy, health: flatEnemy },
};

const ATT = 200_000;
const DEF = 3_000_000;
const attTroops = { inf: 100_000, lanc:  20_000, mark:   80_000 };  // 200k @ 5/1/4
const defTroops = { inf: 1_500_000, lanc: 600_000, mark: 900_000 };   // 3M  @ 5/2/3

const attHeroes = [{ name: 'Hector', widget: 10 }, { name: 'Mia', widget: 10 }, { name: 'Gwen', widget: 10 }];
const defHeroes = [{ name: 'Ahmose', widget: 10 }, { name: 'Mia', widget: 10 }, { name: 'Gwen', widget: 10 }];

const a = new SimFighter('Att', { ...attTroops }, attHeroes, playerStats, defaultTroopLevels());
const d = new SimFighter('Def', { ...defTroops }, defHeroes, enemyStats, defaultTroopLevels());
const startAtt = a.get_sum_army();
const startDef = d.get_sum_army();

const fight = new SimFight(a, d);
const t0 = performance.now();
const { attRemaining, defRemaining } = fight.battle();
const elapsed = performance.now() - t0;

console.log(`\n=== Single battle: ${ATT.toLocaleString()} vs ${DEF.toLocaleString()} ===`);
console.log(`Player troops:  ${startAtt.toLocaleString()} (Inf ${attTroops.inf.toLocaleString()} / Lanc ${attTroops.lanc.toLocaleString()} / Mark ${attTroops.mark.toLocaleString()})`);
console.log(`Enemy  troops:  ${startDef.toLocaleString()} (Inf ${defTroops.inf.toLocaleString()} / Lanc ${defTroops.lanc.toLocaleString()} / Mark ${defTroops.mark.toLocaleString()})`);
console.log(`Player stats:   exact (asymmetric)`);
console.log(`Enemy  stats:   flat ${flatEnemy.toFixed(1)}% across all 12 slots (avg of player × ${ENEMY_SCALE})`);
console.log(`Elapsed:        ${elapsed.toFixed(0)} ms`);
console.log();
console.log(`Final result:`);
console.log(`  Player remaining: ${attRemaining.toLocaleString()} (lost ${(startAtt - attRemaining).toLocaleString()} = ${((startAtt - attRemaining) / startAtt * 100).toFixed(1)}%)`);
console.log(`  Enemy  remaining: ${defRemaining.toLocaleString()} (lost ${(startDef - defRemaining).toLocaleString()} = ${((startDef - defRemaining) / startDef * 100).toFixed(1)}%)`);
console.log(`  Rounds run:       ${fight.num_rounds}`);
console.log();

// Round-by-round attacker troop count to see how the fight unfolded.
// `rounds` is a Record<number, SimBattleRound>, not an array.
const roundIndices = Object.keys(a.rounds).map(Number).sort((x, y) => x - y);
const attRounds = roundIndices.map(i => {
  const r = a.rounds[i];
  const total = ['inf', 'lanc', 'mark']
    .reduce((s, ut) => s + Math.ceil(r.round_troops?.[ut] ?? 0), 0);
  return { round: i, total };
});

// ── Per-unit-type "kills" (matches what the original sim's UI shows) ──────
// Each round, `round_kills[attackerUT][victimUT] = N` means: this side's UT
// units removed N of the opponent's victim-type troops this round. Sum
// across rounds to get the same totals the original sim displays.
type KillMatrix = { inf: { inf: number; lanc: number; mark: number },
                    lanc: { inf: number; lanc: number; mark: number },
                    mark: { inf: number; lanc: number; mark: number } };
const empty = (): KillMatrix => ({
  inf:  { inf: 0, lanc: 0, mark: 0 },
  lanc: { inf: 0, lanc: 0, mark: 0 },
  mark: { inf: 0, lanc: 0, mark: 0 },
});
const sumKills = (fighter: any): KillMatrix => {
  const out = empty();
  for (const idx of Object.keys(fighter.rounds).map(Number)) {
    const r = fighter.rounds[idx];
    if (!r?.round_kills) continue;
    for (const [attUT, victims] of Object.entries(r.round_kills)) {
      for (const [vicUT, n] of Object.entries(victims as Record<string, number>)) {
        (out as any)[attUT][vicUT] += n;
      }
    }
  }
  return out;
};
const attKills = sumKills(a);
const defKills = sumKills(d);

const initialAtt = { ...attTroops };
const initialDef = { ...defTroops };
const finalAtt = a.rounds[fight.num_rounds]?.round_troops ?? { inf: 0, lanc: 0, mark: 0 };
const finalDef = d.rounds[fight.num_rounds]?.round_troops ?? { inf: 0, lanc: 0, mark: 0 };

const sumKillRow = (k: { inf: number; lanc: number; mark: number }) => k.inf + k.lanc + k.mark;
const fmt = (n: number) => Math.round(n).toLocaleString().padStart(8);

console.log(`=== Per-unit-type breakdown (matches original sim's "Units Details") ===\n`);
for (const [side, init, final, kills] of [
  ['ATTACKER', initialAtt, finalAtt, attKills] as const,
  ['DEFENDER', initialDef, finalDef, defKills] as const,
]) {
  console.log(`${side}`);
  for (const ut of ['inf', 'lanc', 'mark'] as const) {
    const utKills = kills[ut];
    console.log(
      `  ${ut.toUpperCase().padEnd(5)} ` +
      `init: ${fmt(init[ut])}  ` +
      `survived: ${fmt(Math.ceil(final[ut]))}  ` +
      `kills→inf:${fmt(utKills.inf)} lanc:${fmt(utKills.lanc)} mark:${fmt(utKills.mark)}` +
      `  total kills: ${fmt(sumKillRow(utKills))}`
    );
  }
  console.log();
}
console.log(`Attacker troops at each round (sampled):`);
const samples = [
  ...attRounds.slice(0, 5),
  ...attRounds.filter((r: any) => r.round % 100 === 0 && r.round >= 100).slice(0, 5),
  ...attRounds.slice(-5),
];
const seen = new Set<number>();
for (const r of samples) {
  if (seen.has(r.round)) continue;
  seen.add(r.round);
  const bar = '█'.repeat(Math.round(r.total / startAtt * 40));
  console.log(`  round ${String(r.round).padStart(4)}:  ${String(r.total).padStart(7)} (${(r.total/startAtt*100).toFixed(1)}%)  ${bar}`);
}
console.log();
console.log(`KEY OBSERVATION:`);
console.log(`  The sim ends only when one side is at zero. There's no notion`);
console.log(`  of "lightly injured" troops that survive a routed fight.`);
