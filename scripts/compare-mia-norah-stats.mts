/**
 * compare-mia-norah-stats.mts — Mia vs Norah with realistic account stats.
 *
 * Same as compare-mia-norah.mts but instead of zero stats, uses left-side
 * stat profiles extracted from public/test-battlereport*.jpg. Smaller sample.
 */

const simMod  = (await import('../src/app/core/sim/simulator.service.ts')) as any;
const heroMod = (await import('../src/app/core/models/hero.model.ts')) as any;
const { SimFight, SimFighter } = simMod.default ?? simMod;
const { defaultTroopLevels } = heroMod.default ?? heroMod;

// Stat profiles read from left-side of test battle reports.
const PROFILES: Record<string, any> = {
  // test-battlereport1.jpg, left column
  report1: {
    inf:  { attack: 573.9, defense: 596.3, lethality: 437.3, health: 446.2 },
    lanc: { attack: 538.5, defense: 545.8, lethality: 348.9, health: 338.0 },
    mark: { attack: 620.3, defense: 584.1, lethality: 446.6, health: 418.7 },
  },
  // test-battlereport3.jpg, left column
  report3: {
    inf:  { attack: 558.7, defense: 541.9, lethality: 371.0, health: 356.2 },
    lanc: { attack: 513.8, defense: 500.8, lethality: 310.4, health: 290.4 },
    mark: { attack: 601.4, defense: 540.6, lethality: 464.0, health: 427.6 },
  },
};

const LEVELS = defaultTroopLevels();
const TOTAL = 100_000;
const RATIOS = ['7/1/2', '5/2/3', '3/4/3', '2/6/2', '1/8/1', '0/10/0'];
const RUNS_PER_PAIR = 10;       // smaller sample

const INF  = ['Jeronimo', 'Natalia', 'Flint', 'Logan', 'Hector'];
const MARK = ['Zinman', 'Alonso', 'Greg', 'Lynn', 'Gwen'];

function troops(ratio: string) {
  const [a, b, c] = ratio.split('/').map(Number);
  const sum = a + b + c;
  return {
    inf:  Math.round(TOTAL * a / sum),
    lanc: Math.round(TOTAL * b / sum),
    mark: Math.round(TOTAL * c / sum),
  };
}
function squad(inf: string, lanc: string, mark: string) {
  return [inf, lanc, mark].map(n => ({ name: n, widget: 10 }));
}

function fight(att: any[], def: any[], ratio: string, stats: any): 0 | 1 | 0.5 {
  const t = troops(ratio);
  const a = new SimFighter('A', { ...t }, att, stats, LEVELS);
  const d = new SimFighter('D', { ...t }, def, stats, LEVELS);
  const r = new SimFight(a, d).battle();
  return r.attRemaining > r.defRemaining ? 1 : r.defRemaining > r.attRemaining ? 0 : 0.5;
}

console.log(`Mia vs Norah w/ realistic stats. ${RUNS_PER_PAIR} runs/pair, ${INF.length*MARK.length} pairs.\n`);

for (const [pname, prof] of Object.entries(PROFILES)) {
  console.log(`=== profile: ${pname} ===`);
  console.log(`ratio       Mia win rate`);
  for (const RATIO of RATIOS) {
    let mia = 0, runs = 0;
    for (const inf of INF) {
      for (const mark of MARK) {
        const m = squad(inf, 'Mia',  mark);
        const n = squad(inf, 'Norah', mark);
        for (let i = 0; i < RUNS_PER_PAIR; i++) {
          mia += fight(m, n, RATIO, prof);
          runs++;
        }
      }
    }
    const wr = mia / runs;
    const bar = '█'.repeat(Math.round(wr * 30));
    console.log(`${RATIO.padEnd(10)}  ${wr.toFixed(3)}    ${bar}`);
  }
  console.log();
}
