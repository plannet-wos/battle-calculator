/**
 * discover-targets.mts — offline target-formation discovery
 *
 * Pipeline:
 *   Stage 1: round-robin all valid 1+1+1 squads (6×5×5=150) at 5/2/3 baseline.
 *            Mirror match every pair, RUNS_S1 runs each. Keep top SHORTLIST_N
 *            squads by total wins.
 *   Stage 2: for each shortlisted squad, sweep RATIOS as the player ratio
 *            against every other shortlisted squad at 5/2/3, RUNS_S2 runs
 *            each. Keep the top RATIOS_PER_SQUAD ratios per squad (with a
 *            diversity guard so the two kept ratios are distinct enough);
 *            each (squad, ratio) becomes an "entry".
 *   Stage 3: round-robin entries (squad+ratio pairs) RUNS_S3 runs each,
 *            producing a per-entry win-rate vector.
 *   Stage 4: k-means cluster entry vectors into K archetypes; pick one
 *            representative per cluster, capping each squad to at most
 *            RATIOS_PER_SQUAD reps in the final list.
 *   Stage 5: 5% ratio refinement — for each chosen target, sweep 6
 *            ±5%-shifted neighbours of its current ratio vs the rest of
 *            the chosen field, RUNS_REFINE runs each. Pick the best.
 *
 * Output: src/app/core/sim/data/discovered-targets.json
 *
 * Usage:
 *   npx tsx scripts/discover-targets.mts --smoke   # ~30 sec, scaled-down
 *   npx tsx scripts/discover-targets.mts           # ~10–15 min, full run
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isSmoke = process.argv.includes('--smoke');

// tsx CJS-interop — named exports land on `default`
const simMod  = (await import('../src/app/core/sim/simulator.service.ts')) as any;
const heroMod = (await import('../src/app/core/models/hero.model.ts')) as any;
const { SimFight, SimFighter, baseHeroToStatsBonus } = simMod.default ?? simMod;
const { defaultTroopLevels } = heroMod.default ?? heroMod;

// ─────────────────────────────────────────────────────────────────────────────
// Config

type HeroType = 'Infantry' | 'Lancer' | 'Marksman';
const HEROES: Array<{ name: string; gen: number; type: HeroType }> = [
  { name: 'Jeronimo', gen: 0, type: 'Infantry' }, { name: 'Natalia', gen: 0, type: 'Infantry' },
  { name: 'Flint',    gen: 2, type: 'Infantry' }, { name: 'Logan',   gen: 3, type: 'Infantry' },
  { name: 'Ahmose',   gen: 4, type: 'Infantry' }, { name: 'Hector',  gen: 5, type: 'Infantry' },
  { name: 'Molly',    gen: 1, type: 'Lancer'   }, { name: 'Philly',  gen: 2, type: 'Lancer'   },
  { name: 'Mia',      gen: 3, type: 'Lancer'   }, { name: 'Reina',   gen: 4, type: 'Lancer'   },
  { name: 'Norah',    gen: 5, type: 'Lancer'   },
  { name: 'Zinman',   gen: 1, type: 'Marksman' }, { name: 'Alonso',  gen: 2, type: 'Marksman' },
  { name: 'Greg',     gen: 3, type: 'Marksman' }, { name: 'Lynn',    gen: 4, type: 'Marksman' },
  { name: 'Gwen',     gen: 5, type: 'Marksman' },
];

// Curated ratio list — covers single-type stacks, balanced, and bimodal splits.
const RATIOS_FULL = [
  '10/0/0', '0/10/0', '0/0/10',
  '7/2/1', '7/1/2', '2/7/1', '1/7/2', '2/1/7', '1/2/7',
  '6/3/1', '6/1/3', '3/6/1', '1/6/3', '3/1/6', '1/3/6',
  '5/4/1', '5/1/4', '4/5/1', '1/5/4', '4/1/5', '1/4/5',
  '5/3/2', '5/2/3', '3/5/2', '2/5/3', '3/2/5', '2/3/5',
  '4/4/2', '4/2/4', '2/4/4',
  '4/3/3', '3/4/3', '3/3/4',
  // ranger meta:
  '48/4/48',
];
const RATIOS_SMOKE = ['5/2/3', '6/1/3', '4/5/1', '48/4/48', '10/0/0', '0/0/10'];

const RATIO_BASELINE = '5/2/3';

const TOTAL_TROOPS = 100_000;

const RUNS_S1     = isSmoke ? 1 : 2;     // mirror battles per pair (Stage 1)
const RUNS_S2     = isSmoke ? 2 : 4;     // battles per (myRatio × opp) pair (Stage 2)
const RUNS_S3     = isSmoke ? 2 : 5;     // battles per pair (Stage 3 final RR)
const RUNS_REFINE = isSmoke ? 3 : 8;     // battles per candidate × opp (Stage 5)
const RUNS_BROAD  = isSmoke ? 2 : 5;     // battles per chosen target × valid squad (broad WR)

const SHORTLIST_N = isSmoke ? 12 : 30;
const K_CLUSTERS  = isSmoke ? 3  : 8;
const MAX_SQUADS  = isSmoke ? 60 : Infinity;
const RATIOS_PER_SQUAD = 2;        // max ratios kept per squad after Stage 2
const MIN_RATIO_L1     = 4;        // L1 distance (out of 20) between kept ratios

const RATIOS = isSmoke ? RATIOS_SMOKE : RATIOS_FULL;

// ─────────────────────────────────────────────────────────────────────────────
// Setup

// Flat baseline account stats — represents a "Strong" account's gear/battle-report
// bonuses before the hero contribution is added on top.
const BASE_FLAT = 800;
function baseStatsFlat() {
  return {
    inf:  { attack: BASE_FLAT, defense: BASE_FLAT, lethality: BASE_FLAT, health: BASE_FLAT },
    lanc: { attack: BASE_FLAT, defense: BASE_FLAT, lethality: BASE_FLAT, health: BASE_FLAT },
    mark: { attack: BASE_FLAT, defense: BASE_FLAT, lethality: BASE_FLAT, health: BASE_FLAT },
  };
}
const LEVELS = defaultTroopLevels();
const HERO_STARS = 5;
const HERO_WIDGET = 10;

// Build per-squad AccountStats = base + hero contribution (gen+stars+widget).
function buildSquadStats(ids: number[]) {
  const heroes = ids.map(i => ({
    name: HEROES[i].name,
    gen: HEROES[i].gen,
    type: HEROES[i].type,
    stars: HERO_STARS,
    widget: HERO_WIDGET,
    score: 0,
  }));
  const heroBonus = baseHeroToStatsBonus(heroes);
  const base = baseStatsFlat();
  for (const ut of ['inf', 'lanc', 'mark'] as const) {
    base[ut].attack    += heroBonus[ut].attack;
    base[ut].defense   += heroBonus[ut].defense;
    base[ut].lethality += heroBonus[ut].lethality;
    base[ut].health    += heroBonus[ut].health;
  }
  return base;
}

function parseRatio(ratio: string): { inf: number; lanc: number; mark: number } {
  const [i, l, m] = ratio.split('/').map(s => parseFloat(s.trim()));
  const sum = i + l + m;
  return {
    inf:  Math.round(TOTAL_TROOPS * i / sum),
    lanc: Math.round(TOTAL_TROOPS * l / sum),
    mark: Math.round(TOTAL_TROOPS * m / sum),
  };
}

const ratioTroops: Record<string, { inf: number; lanc: number; mark: number }> = {};
for (const r of [...RATIOS_FULL, ...RATIOS_SMOKE, RATIO_BASELINE]) {
  ratioTroops[r] = parseRatio(r);
}

// Squads: exactly 1 Infantry + 1 Lancer + 1 Marksman = 6×5×5 = 150 squads.
type Squad = {
  ids: number[];
  heroSquad: Array<{ name: string; widget: number }>;
  key: string;
  stats: any;            // pre-built AccountStats incl. hero contribution
};
function generateSquads(): Squad[] {
  const out: Squad[] = [];
  const inf  = HEROES.map((h, i) => ({ h, i })).filter(x => x.h.type === 'Infantry');
  const lanc = HEROES.map((h, i) => ({ h, i })).filter(x => x.h.type === 'Lancer');
  const mark = HEROES.map((h, i) => ({ h, i })).filter(x => x.h.type === 'Marksman');
  for (const I of inf) for (const L of lanc) for (const M of mark) {
    const ids = [I.i, L.i, M.i];
    const heroSquad = ids.map(i => ({ name: HEROES[i].name, widget: HERO_WIDGET }));
    const key = `${I.h.name}+${L.h.name}+${M.h.name}`;
    out.push({ ids, heroSquad, key, stats: buildSquadStats(ids) });
  }
  return out;
}

// One simulated battle returning { attRem, defRem, attWin }
function simBattle(
  attHeroes: Array<{ name: string; widget: number }>,
  attRatio: string,
  attStats: any,
  defHeroes: Array<{ name: string; widget: number }>,
  defRatio: string,
  defStats: any,
): { attRem: number; defRem: number; attWin: 0 | 1 | 0.5 } {
  const att = new SimFighter('Att', { ...ratioTroops[attRatio] }, attHeroes, attStats, LEVELS);
  const def = new SimFighter('Def', { ...ratioTroops[defRatio] }, defHeroes, defStats, LEVELS);
  const r = new SimFight(att, def).battle();
  const attWin: 0 | 1 | 0.5 =
    r.attRemaining > r.defRemaining ? 1 :
    r.defRemaining > r.attRemaining ? 0 : 0.5;
  return { attRem: r.attRemaining, defRem: r.defRemaining, attWin };
}

// Run K mirror-style battles A-vs-B and return A's win rate.
function winRate(
  a: Array<{ name: string; widget: number }>, aRatio: string,
  b: Array<{ name: string; widget: number }>, bRatio: string,
  runs: number,
): number {
  let aWins = 0;
  for (let i = 0; i < runs; i++) {
    aWins += simBattle(a, aRatio, b, bRatio).attWin;
  }
  return aWins / runs;
}

// ─────────────────────────────────────────────────────────────────────────────
// K-means on Euclidean win-rate vectors. Returns cluster index per point.

function kmeans(points: number[][], k: number, maxIter = 100): number[] {
  const n = points.length;
  const dim = points[0].length;
  // Init: pick k well-separated points (k-means++)
  const centers: number[][] = [];
  centers.push(points[Math.floor(Math.random() * n)].slice());
  while (centers.length < k) {
    const dists = points.map(p => Math.min(...centers.map(c => dist2(p, c))));
    const total = dists.reduce((s, d) => s + d, 0);
    let r = Math.random() * total;
    let pick = 0;
    for (let i = 0; i < n; i++) { r -= dists[i]; if (r <= 0) { pick = i; break; } }
    centers.push(points[pick].slice());
  }
  let assign = new Array(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(points[i], centers[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    // Recompute centers
    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      counts[assign[i]]++;
      for (let d = 0; d < dim; d++) sums[assign[i]][d] += points[i][d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      for (let d = 0; d < dim; d++) centers[c][d] = sums[c][d] / counts[c];
    }
    if (!changed) break;
  }
  return assign;
}
function dist2(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline

function fmtTime(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms/1000).toFixed(1)}s`;
  return `${Math.floor(ms/60_000)}m${Math.round((ms%60_000)/1000).toString().padStart(2,'0')}s`;
}

const t0 = performance.now();

// ─── Stage 1: round-robin at default ratio ───────────────────────────────────
console.log(`\n${isSmoke ? '[SMOKE]' : '[FULL]'} starting target discovery`);
console.log(`Heroes: ${HEROES.length}, ratios: ${RATIOS.length}, runs S1=${RUNS_S1} S2=${RUNS_S2} S3=${RUNS_S3}`);

let squads = generateSquads();
if (squads.length > MAX_SQUADS) {
  const stride = Math.ceil(squads.length / MAX_SQUADS);
  squads = squads.filter((_, i) => i % stride === 0).slice(0, MAX_SQUADS);
}
console.log(`Squads to evaluate: ${squads.length}  (1 inf + 1 lanc + 1 mark, ${HERO_STARS}-star widget ${HERO_WIDGET})`);
console.log(`Account stats: flat ${BASE_FLAT}% baseline + per-hero gen/stars/widget contribution`);

const totalS1 = squads.length * (squads.length - 1) / 2 * RUNS_S1;
console.log(`Stage 1: ${totalS1} sims at ${RATIO_BASELINE}…`);
const s1Wins = new Array(squads.length).fill(0);
const s1Played = new Array(squads.length).fill(0);
const tS1 = performance.now();
for (let i = 0; i < squads.length; i++) {
  for (let j = i + 1; j < squads.length; j++) {
    for (let r = 0; r < RUNS_S1; r++) {
      const w = simBattle(squads[i].heroSquad, RATIO_BASELINE, squads[i].stats, squads[j].heroSquad, RATIO_BASELINE, squads[j].stats).attWin;
      s1Wins[i] += w;
      s1Wins[j] += 1 - w;
      s1Played[i]++;
      s1Played[j]++;
    }
  }
  if ((i + 1) % 50 === 0 || i === squads.length - 1) {
    const wr = squads.length > 0 ? (s1Wins[i] / Math.max(1, s1Played[i])).toFixed(2) : '-';
    process.stdout.write(`  ${i+1}/${squads.length} (${fmtTime(performance.now()-tS1)})\r`);
  }
}
console.log(`\n  Stage 1 done in ${fmtTime(performance.now()-tS1)}`);

// Shortlist
const ranked = squads.map((s, i) => ({ idx: i, squad: s, wr: s1Wins[i] / Math.max(1, s1Played[i]) }))
                     .sort((a, b) => b.wr - a.wr);
const shortlist = ranked.slice(0, SHORTLIST_N);
console.log(`Top ${SHORTLIST_N} by S1 win rate:`);
for (let i = 0; i < Math.min(10, shortlist.length); i++) {
  console.log(`  ${i+1}. ${shortlist[i].squad.key.padEnd(28)} wr=${shortlist[i].wr.toFixed(3)}`);
}
if (shortlist.length > 10) console.log(`  … (${shortlist.length - 10} more)`);

// ─── Stage 2: per-squad ratio sweep against shortlisted opponents ────────────
const tS2 = performance.now();
const totalS2 = shortlist.length * RATIOS.length * (shortlist.length - 1) * RUNS_S2;
console.log(`\nStage 2: per-squad ratio sweep, ${totalS2} sims…`);

// Helper: parse a "i/l/m" ratio into a normalised triplet that sums to 10.
function parseRatio01(r: string): [number, number, number] {
  const [a, b, c] = r.split('/').map(Number);
  const s = a + b + c;
  return [10 * a / s, 10 * b / s, 10 * c / s];
}
function l1(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2]);
}

// For each squad, get every ratio's WR; then keep top-RATIOS_PER_SQUAD ratios
// with a diversity guard (kept ratios must be at least MIN_RATIO_L1 apart).
const ratioWRsPerSquad: Array<Array<{ ratio: string; wr: number }>> = [];
for (let i = 0; i < shortlist.length; i++) {
  const me = shortlist[i].squad;
  const wrs: Array<{ ratio: string; wr: number }> = [];
  for (const r of RATIOS) {
    let wins = 0, played = 0;
    for (let j = 0; j < shortlist.length; j++) {
      if (j === i) continue;
      const opp = shortlist[j].squad;
      for (let k = 0; k < RUNS_S2; k++) {
        wins += simBattle(me.heroSquad, r, me.stats, opp.heroSquad, RATIO_BASELINE, opp.stats).attWin;
        played++;
      }
    }
    wrs.push({ ratio: r, wr: wins / played });
  }
  wrs.sort((a, b) => b.wr - a.wr);
  const kept: Array<{ ratio: string; wr: number }> = [wrs[0]];
  for (let q = 1; q < wrs.length && kept.length < RATIOS_PER_SQUAD; q++) {
    const cand = parseRatio01(wrs[q].ratio);
    if (kept.every(k => l1(parseRatio01(k.ratio), cand) >= MIN_RATIO_L1)) {
      kept.push(wrs[q]);
    }
  }
  ratioWRsPerSquad.push(kept);
  process.stdout.write(`  ${i+1}/${shortlist.length} (${fmtTime(performance.now()-tS2)})\r`);
}
console.log(`\n  Stage 2 done in ${fmtTime(performance.now()-tS2)}`);

// Build entries: each (squad, ratio) becomes a candidate target.
type Entry = { squadIdx: number; ratio: string; s2wr: number };
const entries: Entry[] = [];
for (let i = 0; i < shortlist.length; i++) {
  for (const r of ratioWRsPerSquad[i]) {
    entries.push({ squadIdx: i, ratio: r.ratio, s2wr: r.wr });
  }
}
const dualCount = ratioWRsPerSquad.filter(rs => rs.length === 2).length;
console.log(`  ${entries.length} entries (${dualCount}/${shortlist.length} squads kept 2 ratios)`);

// ─── Stage 3: entry round-robin ──────────────────────────────────────────────
const tS3 = performance.now();
const totalS3 = entries.length * (entries.length - 1) / 2 * RUNS_S3;
console.log(`\nStage 3: entry RR (${entries.length} entries), ${totalS3} sims…`);
const wrMatrix: number[][] = Array.from({ length: entries.length }, () => new Array(entries.length).fill(0));
for (let i = 0; i < entries.length; i++) {
  for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i], b = entries[j];
    let aWins = 0;
    for (let r = 0; r < RUNS_S3; r++) {
      aWins += simBattle(
        shortlist[a.squadIdx].squad.heroSquad, a.ratio, shortlist[a.squadIdx].squad.stats,
        shortlist[b.squadIdx].squad.heroSquad, b.ratio, shortlist[b.squadIdx].squad.stats,
      ).attWin;
    }
    const wr = aWins / RUNS_S3;
    wrMatrix[i][j] = wr;
    wrMatrix[j][i] = 1 - wr;
  }
}
console.log(`  Stage 3 done in ${fmtTime(performance.now()-tS3)}`);

// Per-entry average WR vs whole entry pool
const finalWR = wrMatrix.map(row => row.reduce((s, v) => s + v, 0) / (row.length - 1));

// ─── Stage 4: cluster entries; cap each squad to RATIOS_PER_SQUAD reps ───────
console.log(`\nStage 4: k-means clustering (k=${K_CLUSTERS}) on ${entries.length} entries…`);
const labels = kmeans(wrMatrix, K_CLUSTERS);

// Group entries by cluster
const clusterMembers: Map<number, number[]> = new Map();
for (let i = 0; i < entries.length; i++) {
  if (!clusterMembers.has(labels[i])) clusterMembers.set(labels[i], []);
  clusterMembers.get(labels[i])!.push(i);
}
// Process clusters in descending order of best member's finalWR
const clusterOrder = [...clusterMembers.keys()].sort((a, b) => {
  const ba = Math.max(...clusterMembers.get(a)!.map(i => finalWR[i]));
  const bb = Math.max(...clusterMembers.get(b)!.map(i => finalWR[i]));
  return bb - ba;
});

const targets: Array<{ rank: number; cluster: number; squad: string; ratio: string; winRate: number; clusterSize: number }> = [];
const squadCount: Record<number, number> = {};
for (const c of clusterOrder) {
  const members = clusterMembers.get(c)!.slice().sort((a, b) => finalWR[b] - finalWR[a]);
  // Pick first member that doesn't exceed per-squad cap
  let pick = -1;
  for (const m of members) {
    if ((squadCount[entries[m].squadIdx] ?? 0) < RATIOS_PER_SQUAD) { pick = m; break; }
  }
  if (pick < 0) continue;
  squadCount[entries[pick].squadIdx] = (squadCount[entries[pick].squadIdx] ?? 0) + 1;
  targets.push({
    rank: 0,
    cluster: c,
    squad: shortlist[entries[pick].squadIdx].squad.key,
    ratio: entries[pick].ratio,
    winRate: finalWR[pick],          // Stage 5 will overwrite with narrow (vs other chosen)
    winRateShortlist: finalWR[pick], // preserved Stage 3 broad (vs 59 other entries)
    winRateBroad: 0,                 // filled in by post-Stage-5 broad pass
    clusterSize: members.length,
  });
}
targets.sort((a, b) => b.winRate - a.winRate);
targets.forEach((t, i) => { t.rank = i + 1; });

// ─── Stage 5: 5% ratio refinement of chosen targets ─────────────────────────
const tS5 = performance.now();
console.log(`\nStage 5: 5% ratio refinement of ${targets.length} targets…`);

function pctTriplet(r: string): [number, number, number] {
  const [a, b, c] = r.split('/').map(s => parseFloat(s.trim()));
  const sum = a + b + c;
  return [Math.round(a * 100 / sum), Math.round(b * 100 / sum), Math.round(c * 100 / sum)];
}
function pctToRatio(p: [number, number, number]): string { return `${p[0]}/${p[1]}/${p[2]}`; }
function neighbours5(best: [number, number, number]): string[] {
  const shifts: Array<[number, number, number]> = [
    [+5, -5,  0], [+5,  0, -5], [-5, +5,  0],
    [ 0, +5, -5], [-5,  0, +5], [ 0, -5, +5],
  ];
  const out = new Set<string>([pctToRatio(best)]);
  for (const [da, db, dc] of shifts) {
    const a = best[0] + da, b = best[1] + db, c = best[2] + dc;
    if (a >= 0 && b >= 0 && c >= 0 && a + b + c === 100) out.add(`${a}/${b}/${c}`);
  }
  return [...out];
}

// Pre-cache squad lookup from key
const squadByKey = new Map<string, Squad>();
for (const s of squads) squadByKey.set(s.key, s);

for (let ti = 0; ti < targets.length; ti++) {
  const t = targets[ti];
  const me = squadByKey.get(t.squad)!;
  const candidates = neighbours5(pctTriplet(t.ratio));
  // Pre-cache "exotic" ratio troop counts for refined ratios that aren't in RATIOS_FULL
  for (const c of candidates) if (!ratioTroops[c]) ratioTroops[c] = parseRatio(c);
  // Field = every OTHER target at its current ratio
  const field = targets.filter((_, j) => j !== ti).map(o => ({
    squad: squadByKey.get(o.squad)!,
    ratio: o.ratio,
  }));
  for (const f of field) if (!ratioTroops[f.ratio]) ratioTroops[f.ratio] = parseRatio(f.ratio);

  const oldRatio = t.ratio;
  const oldWR   = t.winRate;
  let bestR = candidates[0], bestWR = -Infinity;
  for (const r of candidates) {
    let wins = 0, played = 0;
    for (const opp of field) {
      for (let k = 0; k < RUNS_REFINE; k++) {
        wins += simBattle(me.heroSquad, r, me.stats, opp.squad.heroSquad, opp.ratio, opp.squad.stats).attWin;
        played++;
      }
    }
    const wr = wins / played;
    if (wr > bestWR) { bestWR = wr; bestR = r; }
  }
  t.ratio = bestR;
  t.winRate = bestWR;
  const mark = bestR !== oldRatio ? '*' : ' ';
  console.log(`  ${mark} #${t.rank}  ${t.squad.padEnd(28)} ${oldRatio.padEnd(8)} (wr ${oldWR.toFixed(3)}) -> ${bestR.padEnd(10)} (wr ${bestWR.toFixed(3)})`);
}
targets.sort((a, b) => b.winRate - a.winRate);
targets.forEach((t, i) => { t.rank = i + 1; });
console.log(`  Stage 5 done in ${fmtTime(performance.now()-tS5)}`);

// ─── Broad WR pass — each chosen target vs all 149 other valid squads ────────
const tBroad = performance.now();
console.log(`\nBroad WR pass: each target vs all ${squads.length - 1} other valid squads at baseline ${RATIO_BASELINE}…`);
for (const t of targets) {
  const me = squadByKey.get(t.squad)!;
  let wins = 0, played = 0;
  for (const opp of squads) {
    if (opp.key === t.squad) continue;
    for (let k = 0; k < RUNS_BROAD; k++) {
      wins += simBattle(me.heroSquad, t.ratio, me.stats, opp.heroSquad, RATIO_BASELINE, opp.stats).attWin;
      played++;
    }
  }
  t.winRateBroad = wins / played;
}
console.log(`  Broad pass done in ${fmtTime(performance.now()-tBroad)}`);

// ─── Output ─────────────────────────────────────────────────────────────────
const elapsed = performance.now() - t0;
console.log(`\nTotal time: ${fmtTime(elapsed)}`);
console.log(`\n=== ${targets.length} Discovered Targets ===`);
console.log(`           wr columns: vs7=other refined targets │ vs59=Stage-3 shortlist │ vs149=all valid squads @ baseline`);
for (const t of targets) {
  console.log(`#${t.rank}  ${t.squad.padEnd(28)} ratio=${t.ratio.padEnd(10)} vs7=${t.winRate.toFixed(3)}  vs59=${t.winRateShortlist.toFixed(3)}  vs149=${t.winRateBroad.toFixed(3)}  (cluster ${t.cluster}, size ${t.clusterSize})`);
}

const outPath = pathResolve(__dirname, '..', 'src', 'app', 'core', 'sim', 'data', isSmoke ? 'discovered-targets.smoke.json' : 'discovered-targets.json');
const payload = {
  generatedAt: new Date().toISOString(),
  mode: isSmoke ? 'smoke' : 'full',
  config: { TOTAL_TROOPS, BASE_FLAT, HERO_STARS, HERO_WIDGET, RUNS_S1, RUNS_S2, RUNS_S3, RUNS_REFINE, SHORTLIST_N, K_CLUSTERS, RATIOS_PER_SQUAD, MIN_RATIO_L1, ratios: RATIOS, baseline: RATIO_BASELINE },
  totalSims: totalS1 + totalS2 + totalS3,
  totalElapsedMs: Math.round(elapsed),
  targets,
};
await writeFile(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
console.log(`\nWrote ${outPath}`);
