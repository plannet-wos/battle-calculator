/**
 * compare-mia-norah.mts — Mia vs Norah head-to-head.
 *
 * For a basket of "other" hero pairs (one inf + one mark), compare a squad
 * with Mia in the lancer slot against the same squad with Norah in the lancer
 * slot. Reports per-pair and overall win rates so we can quantify the gap.
 */

const simMod  = (await import('../src/app/core/sim/simulator.service.ts')) as any;
const heroMod = (await import('../src/app/core/models/hero.model.ts')) as any;
const { SimFight, SimFighter } = simMod.default ?? simMod;
const { defaultTroopLevels } = heroMod.default ?? heroMod;

const ZERO = {
  inf:  { attack: 0, defense: 0, lethality: 0, health: 0 },
  lanc: { attack: 0, defense: 0, lethality: 0, health: 0 },
  mark: { attack: 0, defense: 0, lethality: 0, health: 0 },
};
const LEVELS = defaultTroopLevels();
const TOTAL = 100_000;
const RATIOS = ['7/1/2', '5/2/3', '3/4/3', '2/6/2', '1/8/1', '0/10/0'];
const RUNS_PER_PAIR = 20;

const INF  = ['Jeronimo', 'Natalia', 'Flint', 'Logan', 'Ahmose', 'Hector'];
const MARK = ['Zinman', 'Alonso', 'Greg', 'Lynn', 'Gwen'];

function troops(ratio: string): { inf: number; lanc: number; mark: number } {
  const [a, b, c] = ratio.split('/').map(Number);
  const sum = a + b + c;
  return {
    inf: Math.round(TOTAL * a / sum),
    lanc: Math.round(TOTAL * b / sum),
    mark: Math.round(TOTAL * c / sum),
  };
}
function squad(inf: string, lanc: string, mark: string) {
  return [inf, lanc, mark].map(n => ({ name: n, widget: 10 }));
}

function fight(att: any[], def: any[], ratio: string): 0 | 1 | 0.5 {
  const t = troops(ratio);
  const a = new SimFighter('A', { ...t }, att, ZERO, LEVELS);
  const d = new SimFighter('D', { ...t }, def, ZERO, LEVELS);
  const r = new SimFight(a, d).battle();
  return r.attRemaining > r.defRemaining ? 1 : r.defRemaining > r.attRemaining ? 0 : 0.5;
}

console.log(`Comparing Mia vs Norah across ratios, ${RUNS_PER_PAIR} runs/pair, ${INF.length*MARK.length} pairs each.\n`);
console.log(`ratio       Mia win rate  (Norah wins where Mia<0.5)`);

for (const RATIO of RATIOS) {
  let totalMiaWin = 0, totalRuns = 0;
  for (const inf of INF) {
    for (const mark of MARK) {
      const miaSquad   = squad(inf, 'Mia',  mark);
      const norahSquad = squad(inf, 'Norah', mark);
      for (let i = 0; i < RUNS_PER_PAIR; i++) {
        totalMiaWin += fight(miaSquad, norahSquad, RATIO);
        totalRuns++;
      }
    }
  }
  const wr = totalMiaWin / totalRuns;
  const bar = '█'.repeat(Math.round(wr * 30));
  console.log(`${RATIO.padEnd(10)}  ${wr.toFixed(3)}        ${bar}`);
}
