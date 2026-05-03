/**
 * debug-target1.mts — show exactly how target #1 (Ahmose+Philly+Mia 75/5/20)
 * achieves 0.943 win rate. Prints the simulator config, then runs N battles
 * vs each of the other 7 targets and dumps raw outcomes.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const simMod  = (await import('../src/app/core/sim/simulator.service.ts')) as any;
const heroMod = (await import('../src/app/core/models/hero.model.ts')) as any;
const { SimFight, SimFighter } = simMod.default ?? simMod;
const { defaultTroopLevels } = heroMod.default ?? heroMod;

const TOTAL = 100_000;
const RUNS = 20;
const FLAT = 800;
const STATS = {
  inf:  { attack: FLAT, defense: FLAT, lethality: FLAT, health: FLAT },
  lanc: { attack: FLAT, defense: FLAT, lethality: FLAT, health: FLAT },
  mark: { attack: FLAT, defense: FLAT, lethality: FLAT, health: FLAT },
};
const LEVELS = defaultTroopLevels();

console.log(`Simulator config:`);
console.log(`  TOTAL_TROOPS = ${TOTAL}`);
console.log(`  account stats = flat +${FLAT}% atk/def/leth/hp on all troop types`);
console.log(`  troop levels  = ${JSON.stringify(LEVELS)}   (T10 + FC5)`);
console.log(`  hero widget   = 10 each (max five-star, max widget)`);
console.log();

function troops(ratio: string) {
  const [a, b, c] = ratio.split('/').map(Number);
  const sum = a + b + c;
  return {
    inf:  Math.round(TOTAL * a / sum),
    lanc: Math.round(TOTAL * b / sum),
    mark: Math.round(TOTAL * c / sum),
  };
}
function squad(key: string) {
  return key.split('+').map(n => ({ name: n.trim(), widget: 10 }));
}

const data = JSON.parse(await readFile(
  pathResolve(__dirname, '..', 'src', 'app', 'core', 'sim', 'data', 'discovered-targets.json'),
  'utf-8',
));
const targets = data.targets;
const T1 = targets[0];
console.log(`Target #1: ${T1.squad}  ratio ${T1.ratio}  reported wr=${T1.winRate.toFixed(3)}\n`);

const meHeroes = squad(T1.squad);
const meTroops = troops(T1.ratio);
console.log(`  attacker troops: inf=${meTroops.inf} lanc=${meTroops.lanc} mark=${meTroops.mark}`);
console.log();

console.log(`Match-by-match outcome vs each other target:\n`);
console.log(`opponent (squad / ratio)            attRem    defRem    A>D   tied  D>A   wr`);
console.log(`─────────────────────────────────────────────────────────────────────────────`);

let grandWin = 0, grandPlayed = 0;
const samples: Array<{ opp: string; logs: string[] }> = [];

for (let i = 1; i < targets.length; i++) {
  const opp = targets[i];
  const oppHeroes = squad(opp.squad);
  const oppTroops = troops(opp.ratio);
  let aWin = 0, dWin = 0, ties = 0;
  let sumA = 0, sumD = 0;
  const sampleLogs: string[] = [];
  for (let r = 0; r < RUNS; r++) {
    const a = new SimFighter('A', { ...meTroops },  meHeroes,  STATS, LEVELS);
    const d = new SimFighter('D', { ...oppTroops }, oppHeroes, STATS, LEVELS);
    const res = new SimFight(a, d).battle();
    sumA += res.attRemaining;
    sumD += res.defRemaining;
    if (res.attRemaining > res.defRemaining) aWin++;
    else if (res.defRemaining > res.attRemaining) dWin++;
    else ties++;
    if (r < 3) sampleLogs.push(`    run${r}: attRem=${res.attRemaining} defRem=${res.defRemaining} ${res.attRemaining>res.defRemaining?'A wins':res.defRemaining>res.attRemaining?'D wins':'tie'}`);
  }
  const wr = (aWin + 0.5 * ties) / RUNS;
  grandWin += aWin + 0.5 * ties;
  grandPlayed += RUNS;
  const oppLabel = `${opp.squad} / ${opp.ratio}`.padEnd(34);
  console.log(`${oppLabel}  ${(sumA/RUNS).toFixed(0).padStart(7)}  ${(sumD/RUNS).toFixed(0).padStart(7)}   ${aWin.toString().padStart(2)}    ${ties.toString().padStart(2)}   ${dWin.toString().padStart(2)}   ${wr.toFixed(3)}`);
  samples.push({ opp: oppLabel.trim(), logs: sampleLogs });
}

const overall = grandWin / grandPlayed;
console.log(`─────────────────────────────────────────────────────────────────────────────`);
console.log(`overall win rate vs the other 7 targets: ${overall.toFixed(3)} (${RUNS} runs each)\n`);

console.log(`First 3 raw battle outcomes per opponent:`);
for (const s of samples) {
  console.log(`  ${s.opp}`);
  for (const l of s.logs) console.log(l);
}
