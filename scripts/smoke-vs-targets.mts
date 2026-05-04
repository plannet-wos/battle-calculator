/**
 * smoke-vs-targets.mts — quick smoke test of SimulatorService.recommendVsTargets.
 *
 * Mocks a player with all 16 heroes owned at 5★/widget 10 and a roughly
 * realistic stat profile, then prints what the new recommender picks.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const simMod = (await import('../src/app/core/sim/simulator.service.ts')) as any;
const { SimulatorService, addAccountStats } = simMod.default ?? simMod;

const heroData = [
  { name: 'Jeronimo', gen: 0, type: 'Infantry' as const },
  { name: 'Natalia',  gen: 0, type: 'Infantry' as const },
  { name: 'Flint',    gen: 2, type: 'Infantry' as const },
  { name: 'Logan',    gen: 3, type: 'Infantry' as const },
  { name: 'Ahmose',   gen: 4, type: 'Infantry' as const },
  { name: 'Hector',   gen: 5, type: 'Infantry' as const },
  { name: 'Molly',    gen: 1, type: 'Lancer'   as const },
  { name: 'Philly',   gen: 2, type: 'Lancer'   as const },
  { name: 'Mia',      gen: 3, type: 'Lancer'   as const },
  { name: 'Reina',    gen: 4, type: 'Lancer'   as const },
  { name: 'Norah',    gen: 5, type: 'Lancer'   as const },
  { name: 'Zinman',   gen: 1, type: 'Marksman' as const },
  { name: 'Alonso',   gen: 2, type: 'Marksman' as const },
  { name: 'Greg',     gen: 3, type: 'Marksman' as const },
  { name: 'Lynn',     gen: 4, type: 'Marksman' as const },
  { name: 'Gwen',     gen: 5, type: 'Marksman' as const },
];

const owned = heroData.map(h => ({ ...h, stars: 5, widget: 10, score: 0 }));

// Realistic-ish player stats — asymmetric across troop types.
const playerBaseStats = {
  inf:  { attack: 700, defense: 750, lethality: 450, health: 500 },
  lanc: { attack: 600, defense: 580, lethality: 380, health: 350 },
  mark: { attack: 800, defense: 700, lethality: 500, health: 450 },
};

const sim = new SimulatorService();
const t0 = Date.now();
const rec = sim.recommendVsTargets(owned, playerBaseStats);
const elapsed = Date.now() - t0;

if (!rec) {
  console.log('Recommender returned null.');
  process.exit(1);
}

console.log(`recommendVsTargets — completed in ${elapsed} ms`);
console.log();
console.log(`Best squad: ${rec.squad.map((h: any) => h.name).join(' + ')}`);
console.log(`Best ratio: ${rec.ratio}`);
console.log(`Avg metric vs 8 targets: ${(rec.avgMetric * 100).toFixed(1)}%`);
console.log();
console.log(`Per-target outcomes:`);
for (const t of rec.vsTargets) {
  console.log(`  ${t.target.padEnd(34)}  ${(t.metricValue * 100).toFixed(1)}%`);
}
console.log();
console.log(`Top-5 qualifier (Stage A, 5/2/3 baseline):`);
for (const q of rec.qualifier.slice(0, 5)) {
  console.log(`  ${q.squad.padEnd(30)}  ${(q.metricValue * 100).toFixed(1)}%`);
}
