export type HeroType = 'Infantry' | 'Marksman' | 'Lancer';
export type UnitType = 'inf' | 'mark' | 'lanc';

export interface HeroBase {
  name: string;
  gen: number;
  type: HeroType;
}

export interface HeroInput {
  name: string;
  owned: boolean;
  stars: number;  // 1–5 (yellow stars)
  widget: number; // 0–10 (widget level)
}

export interface ScoredHero extends HeroBase {
  stars: number;
  widget: number;
  score: number;
}

export const HeroStatsByGen: { [key: number]: number } = {
  0: 260.2,
  1: 200.2,
  2: 240.2,
  3: 290.2,
  4: 370.29,
  5: 444.35,
}

export const WidgetStatsByGen: { [key: number]: number } = {
  0: 62.5,
  1: 50,
  2: 60,
  3: 70,
  4: 92.5,
  5: 111,
}

export interface LineupResult {
  squad: ScoredHero[];
  avgScore: number;
  ratio: string;
  strategy: string;
  notes: string[];
}

/** A single detected gear item from the backpack screenshot */
export interface DetectedGearItem {
  type: 'Infantry' | 'Lancer' | 'Marksman';
  color: 'orange' | 'red' | 'unknown';
  piece: 'head' | 'shoes' | 'belt' | 'gloves' | 'unknown';
  bonusLevel: number;    // the +XX value from badge at top of card
  masteryLevel: number;  // the Lv.XX value from bottom of card
}

/** Result of scanning the gear backpack screenshot */
export interface GearScanResult {
  infantry: DetectedGearItem[];  // up to 4 items, sorted best-first
  lancer:   DetectedGearItem[];
  marksman: DetectedGearItem[];
}

/** Per-unit-type account stat bonuses (%) as shown in-game */
export interface UnitStatBonus {
  attack: number;
  defense: number;
  lethality: number;
  health: number;
}

export interface AccountStats {
  inf:  UnitStatBonus;
  lanc: UnitStatBonus;
  mark: UnitStatBonus;
}

/** Tier (1-11) and FC level (0-5, 0 = no FC unlocked) of a single troop type. */
export interface TroopLevel {
  tier: number;
  fc: number;
}

/** Per-unit-type troop levels — each type can sit at a different tier/FC. */
export interface TroopLevels {
  inf:  TroopLevel;
  lanc: TroopLevel;
  mark: TroopLevel;
}

/** What the battle-report scan returns: stat bonuses + per-type troop levels. */
export interface BattleReportScan {
  stats: AccountStats;
  troops: TroopLevels;
}

/** All-T10-FC5 default — the most common WOS endgame state. */
export function defaultTroopLevels(): TroopLevels {
  return {
    inf:  { tier: 10, fc: 5 },
    lanc: { tier: 10, fc: 5 },
    mark: { tier: 10, fc: 5 },
  };
}

export interface StrengthPreset {
  label: 'Yourself' | 'Low' | 'Medium' | 'Strong';
  stats: AccountStats;
  heroes: { name: string; stars: number; widget: number }[];
  troops: TroopLevels;
}
