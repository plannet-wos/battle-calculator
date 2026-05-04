/**
 * Smoke test: import the simulator from Node and run a single battle.
 * Run with: npx tsx scripts/smoke-sim.mts
 */
// tsx interprets these via CommonJS-interop, so named exports land under `.default`.
const simMod  = (await import('../src/app/core/sim/simulator.service.ts')) as any;
const heroMod = (await import('../src/app/core/models/hero.model.ts')) as any;
const { SimFight, SimFighter } = simMod.default ?? simMod;
const { defaultTroopLevels } = heroMod.default ?? heroMod;
type ScoredHero = any;

const heroes: ScoredHero[] = [
  { name: 'Logan',   gen: 5, type: 'Infantry', stars: 5, widget: 10, score: 0 },
  { name: 'Reina',   gen: 5, type: 'Lancer',   stars: 5, widget: 10, score: 0 },
  { name: 'Lynn',    gen: 5, type: 'Marksman', stars: 5, widget: 10, score: 0 },
];
const heroSquad = heroes.map(h => ({ name: h.name, widget: h.widget }));

const zeroStats = {
  inf:  { attack: 0, defense: 0, lethality: 0, health: 0 },
  lanc: { attack: 0, defense: 0, lethality: 0, health: 0 },
  mark: { attack: 0, defense: 0, lethality: 0, health: 0 },
};
const levels = defaultTroopLevels();
const total = 100_000;
const ratio = '5/2/3';
const [i, l, m] = ratio.split('/').map(Number);
const sum = i + l + m;
const troops = {
  inf:  Math.round(total * i / sum),
  lanc: Math.round(total * l / sum),
  mark: Math.round(total * m / sum),
};

// Run N battles to measure throughput
const N = 200;
const start = performance.now();
let attWins = 0, defWins = 0, ties = 0;
for (let n = 0; n < N; n++) {
  const att = new SimFighter('Att', { ...troops }, heroSquad, zeroStats, levels);
  const def = new SimFighter('Def', { ...troops }, heroSquad, zeroStats, levels);
  const r = new SimFight(att, def).battle();
  if (r.attRemaining > r.defRemaining) attWins++;
  else if (r.defRemaining > r.attRemaining) defWins++;
  else ties++;
}
const elapsed = performance.now() - start;
console.log(`${N} mirror battles in ${elapsed.toFixed(0)} ms (${(elapsed/N).toFixed(2)} ms each)`);
console.log(`attWins=${attWins} defWins=${defWins} ties=${ties}`);
