/**
 * WOS Battle Simulator — TypeScript port of https://github.com/ryo-HIT-1589/wos-simulator
 *
 * Runs round-by-round combat simulations with full troop skills and hero skills.
 * The attacker's stats are derived from the player's scanned gear + battle-report
 * bonuses + hero base contributions (via baseHeroToStatsBonus). The defender's
 * stats come from one of the three STRENGTH_PRESETS (Low / Medium / Strong).
 * Outcomes are determined by troop ratio, troop type advantages, hero skills,
 * and the difference in account stat bonuses between the two sides.
 */

import { Injectable } from '@angular/core';
import { ScoredHero, AccountStats, StrengthPreset, GearScanResult, DetectedGearItem, HeroStatsByGen, WidgetStatsByGen, TroopLevels, defaultTroopLevels } from '../models/hero.model';

// ---------- JSON data imports ----------
import TROOP_STATS_RAW from './data/troop_stats.json';
import TROOP_SKILLS_RAW from './data/troop_skills.json';
import GwenSkills    from './data/Gwen.json';
import LoganSkills   from './data/Logan.json';
import ReinaSkills   from './data/Reina.json';
import HectorSkills  from './data/Hector.json';
import NorahSkills   from './data/Norah.json';
import MiaSkills     from './data/Mia.json';
import AhmoseSkills  from './data/Ahmose.json';
import LynnSkills    from './data/Lynn.json';
import AlonsoSkills  from './data/Alonso.json';
import FlintSkills   from './data/Flint.json';
import MollySkills   from './data/Molly.json';
import JeronimoSkills from './data/Jeronimo.json';
import NataliaSkills from './data/Natalia.json';
import GregSkills    from './data/Greg.json';
import PhillySkills  from './data/Philly.json';
import ZinmanSkills  from './data/Zinman.json';

// =====================================================================
// UNIT TYPES
// =====================================================================

type UT = 'inf' | 'lanc' | 'mark';
const ALL_UT: UT[] = ['inf', 'lanc', 'mark'];

function toUT(s: string): UT | null {
  const u = s.toUpperCase();
  if (u.includes('INF')) return 'inf';
  if (u.includes('LANC') || u.includes('CAV')) return 'lanc';
  if (u.includes('MARK') || u.includes('ARCH')) return 'mark';
  return null;
}

// =====================================================================
// STATIC DATA
// =====================================================================

type TroopStatRow = { tier: number; fc: number; stats: { Attack: number; Defense: number; Lethality: number; Health: number } };
type TroopBaseRow = { attack: number; defense: number; lethality: number; health: number };

/**
 * Look up base stats per unit type. Each unit type uses its own (tier, fc)
 * pair from `levels`, so e.g. Infantry can be T11 FC5 while Lancer/Marksman
 * are still T10 FC5.
 */
function getTroopBase(levels: TroopLevels): Record<UT, TroopBaseRow> {
  const db = TROOP_STATS_RAW as Record<string, TroopStatRow>;
  const get = (type: string, tier: number, fc: number): TroopBaseRow => {
    const key = fc > 0 ? `${type}_t${tier}_fc${fc}` : `${type}_t${tier}`;
    const row = db[key];
    if (!row) return { attack: 597, defense: 10, lethality: 10, health: 1790 };
    return { attack: row.stats.Attack, defense: row.stats.Defense, lethality: row.stats.Lethality, health: row.stats.Health };
  };
  return {
    inf:  get('infantry', levels.inf.tier,  levels.inf.fc),
    lanc: get('lancer',   levels.lanc.tier, levels.lanc.fc),
    mark: get('marksman', levels.mark.tier, levels.mark.fc),
  };
}

// Hero name mapping: app name → simulator JSON file name
const HERO_SKILL_MAP: Record<string, unknown[]> = {
  'Gwen':     GwenSkills     as unknown[],
  'Logan':    LoganSkills    as unknown[],
  'Reina':    ReinaSkills    as unknown[],
  'Hector':   HectorSkills   as unknown[],
  'Nora':     NorahSkills    as unknown[],
  'Mia':      MiaSkills      as unknown[],
  'Ahmose':   AhmoseSkills   as unknown[],
  'Lynn':     LynnSkills     as unknown[],
  'Alonso':   AlonsoSkills   as unknown[],
  'Flint':    FlintSkills    as unknown[],
  'Molly':    MollySkills    as unknown[],
  'Jeronimo': JeronimoSkills as unknown[],
  'Natalia':  NataliaSkills  as unknown[],
  'Greg':     GregSkills     as unknown[],
  'Philly':   PhillySkills   as unknown[],
  'Zinman':   ZinmanSkills   as unknown[],
};

// Widget level → hero skill levels: {skill_1: N, skill_2?: N, skill_3?: N}
function widgetToSkillLevels(widget: number): Record<string, number> {
  const w = Math.max(0, Math.min(10, widget));
  const sk1 = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5][w];
  const sk2 = [0, 0, 0, 0, 1, 2, 3, 4, 5, 5, 5][w];
  const sk3 = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3][w];
  const result: Record<string, number> = { 'skill_1': sk1 };
  if (sk2 > 0) result['skill_2'] = sk2;
  if (sk3 > 0) result['skill_3'] = sk3;
  return result;
}

/** Empty AccountStats (all zeros) */
export function zeroAccountStats(): AccountStats {
  return {
    inf:  { attack: 0, defense: 0, lethality: 0, health: 0 },
    lanc: { attack: 0, defense: 0, lethality: 0, health: 0 },
    mark: { attack: 0, defense: 0, lethality: 0, health: 0 },
  };
}

/**
 * Sums any number of AccountStats together (component-wise).
 * Accepts a variadic list so callers can combine base stats, gear bonuses,
 * and hero bonuses in a single call: addAccountStats(base, gearBonus, heroBonus).
 * Null/undefined entries in the list are silently skipped.
 */
export function addAccountStats(...statsList: AccountStats[]): AccountStats {
  const result = zeroAccountStats();
  for (const stats of statsList) {
    if (!stats) continue;
    result.inf.attack += stats.inf.attack;
    result.inf.defense += stats.inf.defense;
    result.inf.lethality += stats.inf.lethality;
    result.inf.health += stats.inf.health;

    result.lanc.attack += stats.lanc.attack;
    result.lanc.defense += stats.lanc.defense;
    result.lanc.lethality += stats.lanc.lethality;
    result.lanc.health += stats.lanc.health;

    result.mark.attack += stats.mark.attack;
    result.mark.defense += stats.mark.defense;
    result.mark.lethality += stats.mark.lethality;
    result.mark.health += stats.mark.health;
  }
  return result;
}

/**
 * Computes the total stat-bonus contribution of a single gear item, based on
 * its enhancement (+XX) and mastery (Lv.XX) values.
 *
 *   Red    items: (50   + 0.5    * E) * (1 + 0.1 * M)
 *   Orange items: (3.33 + 0.4667 * E) * (1 + 0.1 * M)
 *
 * Returns 0 for unknown colour.
 */
export function gearItemValue(item: DetectedGearItem): number {
  const E = item.bonusLevel;
  const M = item.masteryLevel;
  if (item.color === 'red')    return (50   + 0.5    * E) * (1 + 0.1 * M);
  if (item.color === 'orange') return (3.33 + 0.4667 * E) * (1 + 0.1 * M);
  return 0;
}

/**
 * Turns a GearScanResult into the AccountStats contribution it represents.
 * Routing (same for every troop type):
 *   head + shoes   → lethality
 *   belt + gloves  → health
 * An item of type X always buffs only its own type's stats.
 */
export function gearItemsToStatBonus(result: GearScanResult): AccountStats {
  const out = zeroAccountStats();
  const buckets: Array<['inf' | 'lanc' | 'mark', DetectedGearItem[]]> = [
    ['inf',  result.infantry],
    ['lanc', result.lancer],
    ['mark', result.marksman],
  ];
  for (const [typeKey, items] of buckets) {
    for (const item of items) {
      const value = gearItemValue(item);
      if (value <= 0) continue;
      if (item.piece === 'head' || item.piece === 'shoes') {
        out[typeKey].lethality += value;
      } else if (item.piece === 'belt' || item.piece === 'gloves') {
        out[typeKey].health += value;
      }
      // unknown piece → skip

      // ── Red-gear enhancement threshold bonuses (additive, cumulative) ──
      //   shoes/gloves: +20 → +20% def, +60 → +30% atk, +100 → +50% def
      //   head/belt:    +20 → +20% atk, +60 → +30% def, +100 → +50% atk
      if (item.color === 'red') {
        const E = item.bonusLevel;
        if (item.piece === 'shoes' || item.piece === 'gloves') {
          if (E >= 20)  out[typeKey].defense += 20;
          if (E >= 60)  out[typeKey].attack  += 30;
          if (E >= 100) out[typeKey].defense += 50;
        } else if (item.piece === 'head' || item.piece === 'belt') {
          if (E >= 20)  out[typeKey].attack  += 20;
          if (E >= 60)  out[typeKey].defense += 30;
          if (E >= 100) out[typeKey].attack  += 50;
        }
      }
    }
  }
  return out;
}

/**
 * Converts the selected squad's hero stats into AccountStats percentage bonuses.
 *
 * Each hero contributes to their own troop type only:
 *   ATK & DEF bonus = HeroStatsByGen[gen] * (0.24 + stars * 0.152)   (rounded to 2 dp)
 *   LETH & HP bonus = (WidgetStatsByGen[gen] / 10) * widget           (rounded to 2 dp)
 *
 * These values are added on top of the gear and battle-report bonuses before
 * the simulation runs.
 */
export function baseHeroToStatsBonus(heroes: ScoredHero[]): AccountStats {
  let totalBonus = zeroAccountStats();
  for (const hero of heroes) {
    const type = toUT(hero.type) as UT;
    const starBonus = Math.round( HeroStatsByGen[hero.gen] * (0.24 + (hero.stars * 0.152)) * 100) / 100;
    totalBonus[type].attack += starBonus;
    totalBonus[type].defense += starBonus;
    const widgetBonus = Math.round((WidgetStatsByGen[hero.gen] / 10) * hero.widget * 100) / 100;
    totalBonus[type].lethality += widgetBonus;
    totalBonus[type].health += widgetBonus;
  }
  return totalBonus;
}

// =====================================================================
// STRENGTH PRESETS
// Real in-game stat bonuses (%) collected from players.
// =====================================================================

/** Helper: build a uniform TroopLevels with the same tier/FC across all types. */
function uniformLevels(tier: number, fc: number): TroopLevels {
  return {
    inf:  { tier, fc },
    lanc: { tier, fc },
    mark: { tier, fc },
  };
}

export const STRENGTH_PRESETS: StrengthPreset[] = [
  {
    label: 'Strong',
    troops: uniformLevels(10, 5),
    heroes: [
      { name: 'Gwen',   stars: 5, widget: 5 },
      { name: 'Ahmose', stars: 4, widget: 6 },
      { name: 'Mia',  stars: 5, widget: 8 },
    ],
    stats: {
      inf:  { attack: 979.1,  defense: 993.4,  lethality: 641.3, health: 809.6 },
      lanc: { attack: 821.6,  defense: 809.0,  lethality: 632.9, health: 509.0 },
      mark: { attack: 1086.6, defense: 1005.4, lethality: 807.5, health: 631.6 },
    },
    
  },
  {
    label: 'Medium',
    troops: uniformLevels(10, 4),
    heroes: [
      { name: 'Lynn',  stars: 5, widget: 4 },
      { name: 'Flint', stars: 5, widget: 4 },
      { name: 'Mia',   stars: 5, widget: 4 },
    ],
    stats: {
      inf:  { attack: 624.4, defense: 582.5, lethality: 360.5, health: 480.9 },
      lanc: { attack: 665.9, defense: 620.7, lethality: 454.6, health: 348.9 },
      mark: { attack: 768.9, defense: 716.9, lethality: 455.2, health: 348.0 },
    },
  },
  {
    label: 'Low',
    troops: uniformLevels(10, 3),
    heroes: [
      { name: 'Lynn',   stars: 4, widget: 2 },
      { name: 'Hector', stars: 4, widget: 2 },
      { name: 'Mia',    stars: 4, widget: 2 },
    ],
    stats: {
      inf:  { attack: 544.7, defense: 535.6, lethality: 306.9, health: 380.2 },
      lanc: { attack: 495.4, defense: 490.1, lethality: 382.8, health: 294.7 },
      mark: { attack: 564.7, defense: 550.3, lethality: 358.8, health: 289.3 },
    },
  },
];

// =====================================================================
// SKILL TYPES (matching Python JSON structure)
// =====================================================================

interface EffectDef {
  effect_num: string;
  affects_opponent: boolean;
  effect_type: string;
  effect_op: number | string;
  extra_attack: boolean;
  effect_is_chance: boolean;
  effect_probabilities: Record<string, number>;
  effect_values: Record<string, number | string>;
  effect_duration: { duration_type: string; duration_value: number; effect_lag: number };
  trigger_types: { trigger_for: string; trigger_vs: string };
  benefit_types: { benefit_for: string; benefit_vs: string };
  special: Record<string, unknown>;
}

interface SkillDef {
  skill_hero?: string;
  skill_num?: number;
  skill_name: string;
  skill_type: string;
  skill_troop_type: string;
  skill_permanent: boolean;
  skill_is_chance: boolean;
  skill_probability: number;
  skill_round_stackable: boolean;
  skill_type_relation: boolean | number;
  skill_order: number;
  skill_frequency: {
    frequency_type: string | null;
    frequency_value: number;
    skill_first_round?: number;
    skill_last_round?: number;
  };
  skill_effects: EffectDef[];
  skill_conditions?: { level: string; condition_type: string; condition_value: number }[];
}

// =====================================================================
// SKILL / EFFECT / BENEFIT classes
// =====================================================================

class SimSkill {
  name: string;
  troop_type: string;
  permanent: boolean;
  is_chance: boolean;
  probability: number;
  round_stackable: boolean;
  type_relation: boolean | number;
  frequency: SkillDef['skill_frequency'];
  effects_data: EffectDef[];
  hero: string | undefined;
  level: string;
  procs: Record<number, boolean> = {};

  constructor(def: SkillDef, level: number) {
    this.name = def.skill_name;
    this.troop_type = def.skill_troop_type;
    this.permanent = def.skill_permanent;
    this.is_chance = def.skill_is_chance;
    this.probability = def.skill_probability;
    this.round_stackable = def.skill_round_stackable;
    this.type_relation = def.skill_type_relation;
    this.frequency = def.skill_frequency;
    this.effects_data = def.skill_effects;
    this.hero = def.skill_type === 'hero_skill' ? def.skill_hero : undefined;
    this.level = String(level || (def.skill_type === 'hero_skill' ? 5 : 1));
  }

  /** Returns true if this skill activates in this round */
  r_skill_condition(fighter: SimFighter, round: number): boolean {
    // Non-stackable: skip if a benefit from this skill already active
    if (round > 0 && !this.round_stackable) {
      const prevBenefits = fighter.rounds[round - 1]?.round_benefits ?? [];
      if (prevBenefits.some(b => b.id.startsWith(this.name) && b.isValid('any', 'any', round))) {
        return false;
      }
    }

    // Type-relation check: skill only works if its troop type is still in battle
    if (this.type_relation) {
      const ut = toUT(this.troop_type);
      if (ut && fighter.rounds[round]?.round_troops[ut] <= 0) return false;
    }

    if (this.permanent) return true;

    const freq = this.frequency;
    // Start round
    if (freq.skill_first_round !== undefined && (round + 1) < freq.skill_first_round) return false;
    // Last round
    if (freq.skill_last_round !== undefined && (round + 1) > freq.skill_last_round) return false;

    // Frequency
    if (freq.frequency_type === 'turn' || freq.frequency_type === 'round') {
      const start = Math.max(0, (freq.skill_first_round ?? 1) - 1);
      if ((round - start) % (freq.frequency_value || 1) !== 0) return false;
    }

    // Chance proc
    if (this.is_chance) {
      if (!(round in this.procs)) this.procs[round] = Math.random() < this.probability / 100;
      return this.procs[round];
    }

    return true;
  }
}

class SimEffect {
  skill: SimSkill;
  num: string;
  affects_opponent: boolean;
  extra_attack: boolean;
  trig_for: string;
  trig_vs: string;
  ben_for: string;
  ben_vs: string;
  type: string;
  op: string;
  duration: EffectDef['effect_duration'];
  is_chance: boolean;
  special: Record<string, unknown>;
  level: string;
  troop_type: string;
  is_permanent: boolean;
  frequency: SkillDef['skill_frequency'];
  probability: number;
  value: number;
  trigger_count = 0;
  activations_count = 0;
  uses_count = 0;

  constructor(skill: SimSkill, def: EffectDef) {
    this.skill = skill;
    this.num = def.effect_num;
    this.affects_opponent = def.affects_opponent;
    this.extra_attack = def.extra_attack;
    this.trig_for = def.trigger_types.trigger_for;
    this.trig_vs = def.trigger_types.trigger_vs;
    this.ben_for = def.benefit_types.benefit_for;
    this.ben_vs = def.benefit_types.benefit_vs;
    this.type = def.effect_type;
    this.op = String(def.effect_op);
    this.duration = def.effect_duration;
    this.is_chance = def.effect_is_chance;
    this.special = def.special ?? {};
    this.level = skill.level;
    this.troop_type = skill.troop_type;
    this.is_permanent = skill.permanent;
    this.frequency = skill.frequency;
    this.probability = def.effect_is_chance
      ? (def.effect_probabilities[this.level] ?? def.effect_probabilities['1'] ?? 0)
      : 0;
    if (['stun', 'dodge'].includes(def.effect_type.toLowerCase())) {
      this.value = 0;
    } else {
      const raw = def.effect_values[this.level] ?? def.effect_values['1'] ?? 0;
      this.value = typeof raw === 'number' ? raw : 0;
    }
  }

  /** Returns true if this effect should activate given fighter/opponent state */
  r_effect_condition(fighter: SimFighter, opponent: SimFighter, round: number): boolean {
    const rTroops = fighter.rounds[round]?.round_troops;
    if (!rTroops) return false;

    if (!['all', 'once', 'first'].includes(this.trig_for)) {
      if (this.trig_for === 'friendly') {
        const myType = toUT(this.troop_type);
        if (!ALL_UT.some(t => t !== myType && rTroops[t] > 0)) return false;
      } else {
        const ut = toUT(this.trig_for);
        if (ut && rTroops[ut] <= 0) return false;
      }
    }

    if (this.trig_vs !== 'all') {
      const oppRound = opponent.rounds[round];
      const vs = toUT(this.trig_vs);
      if (vs && (!oppRound || oppRound.round_troops[vs] <= 0)) return false;
    }

    return true;
  }

  getValueAtLevel(level: string): number {
    const def = this.skill.effects_data.find(e => e.effect_num === this.num);
    if (!def) return this.value;
    const raw = def.effect_values[level] ?? def.effect_values['1'] ?? 0;
    return typeof raw === 'number' ? raw : 0;
  }
}

class SimRoundEffect {
  effect: SimEffect;
  round_idx: number;
  id: string;
  activated_in_round = false;
  attempted_in_round = false;

  constructor(effect: SimEffect, round: number) {
    this.effect = effect;
    this.round_idx = round;
    this.id = `${round}_${effect.num}`;
  }

  trigger_condition(fighter: SimFighter, opponent: SimFighter, ut: UT, vs: UT | null, round: number): boolean {
    // Once-per-round constraints
    if (this.attempted_in_round && this.effect.trig_for === 'first') return false;
    this.attempted_in_round = true;
    if (this.activated_in_round && this.effect.trig_for === 'once') return false;

    // Attack-frequency constraint (e.g., every 5 attacks)
    if (!this.effect.is_permanent && this.effect.frequency.frequency_type === 'attack') {
      if (fighter.cumul_attacks[ut] % this.effect.frequency.frequency_value !== 0) return false;
    }

    // Trigger unit type match
    if (this.effect.trig_for === 'friendly') {
      if (toUT(this.effect.troop_type) === ut) return false;
    } else if (!['all', 'once', 'first'].includes(this.effect.trig_for)) {
      if (toUT(this.effect.trig_for) !== ut) return false;
    }

    // Trigger vs unit type match
    if (this.effect.trig_vs !== 'all') {
      if (vs === null || toUT(this.effect.trig_vs) !== vs) return false;
    }

    // Chance
    if (this.effect.is_chance) {
      if (Math.random() >= this.effect.probability / 100) return false;
    }

    return true;
  }

  activate(fighter: SimFighter, ut: UT, vs: UT): SimBenefit {
    this.activated_in_round = true;
    if (this.effect.is_permanent) this.effect.trigger_count = 1;
    else this.effect.trigger_count++;
    return new SimBenefit(this, fighter, ut, vs);
  }
}

class SimBenefit {
  id: string;
  fighter: SimFighter;
  duration: number;
  duration_type: string;
  lag: number;
  benefit_type: string;
  op: string;
  value: number;
  extra_attack: boolean;
  only_normal: boolean;
  for_units: UT[];
  vs_units: UT[];
  effect: SimEffect;
  start_round: number;
  attack_counter = 0;

  constructor(re: SimRoundEffect, fighter: SimFighter, ut: UT, vs: UT) {
    this.id = `${re.effect.skill.name}_${re.id}_${ut}`;
    this.fighter = fighter;
    this.duration = re.effect.duration.duration_value;
    this.duration_type = re.effect.duration.duration_type;
    this.lag = re.effect.duration.effect_lag;
    this.benefit_type = re.effect.type;
    this.op = re.effect.op;
    this.value = re.effect.value;
    this.extra_attack = re.effect.extra_attack;
    this.only_normal = !!re.effect.special['only_normal'];
    this.effect = re.effect;
    this.start_round = re.round_idx;

    // Compute for_units
    const benFor = re.effect.ben_for;
    if (benFor === 'trigger') {
      this.for_units = [ut];
    } else if (benFor === 'all') {
      this.for_units = [...ALL_UT];
    } else if (benFor === 'friendly') {
      const myUT = toUT(re.effect.troop_type);
      this.for_units = ALL_UT.filter(t => t !== myUT);
    } else {
      const u = toUT(benFor);
      this.for_units = u ? [u] : [...ALL_UT];
    }

    // Compute vs_units
    const benVs = re.effect.ben_vs;
    if (benVs === 'target') {
      this.vs_units = [vs];
    } else if (benVs === 'all') {
      this.vs_units = [...ALL_UT];
    } else {
      const u = toUT(benVs);
      this.vs_units = u ? [u] : [...ALL_UT];
    }
  }

  isValid(ut: UT | 'any', vs: UT | 'any', round: number): boolean {
    if (ut !== 'any' && !this.for_units.includes(ut as UT)) return false;
    if (vs !== 'any' && !this.vs_units.includes(vs as UT)) return false;

    const dt = this.duration_type;
    if ((dt === 'turn' || dt === 'round' || dt === 'turns') && this.duration !== -1) {
      if ((round - this.start_round) < this.lag) return false;
      if ((round - this.start_round - this.lag) >= this.duration) return false;
    }
    if (dt === 'attack') {
      if (this.attack_counter < this.lag) return false;
      if (this.duration !== -1 && (this.attack_counter - this.lag) >= this.duration) return false;
    }
    return true;
  }

  use(): void {
    this.effect.uses_count++;
    this.attack_counter++;
  }

  /** Apply evolution modifiers to base value */
  correctValue(round: number): number {
    const evo = this.effect.special['effect_evolution'] as Record<string, unknown> | undefined;
    if (!evo) return this.value;

    let v = this.value;
    const cat = evo['category'] as string;

    if (cat === 'effect_is_total_damage') {
      v -= 100;
    } else if (cat === 'effect_decrease') {
      const data = evo['data'] as Record<string, unknown>;
      const type = data['type'] as string;
      const decVal = data['decrease_value'] as number;
      const step = data['step'] as string;
      if (type === 'pct_value_fixed_decrease') {
        const counter = step === 'attack' ? this.attack_counter : (round - this.start_round);
        v = Math.max(0, v - counter * decVal);
      } else if (type === 'pct_value_pct_decrease') {
        const counter = step === 'attack' ? this.attack_counter : (round - this.start_round);
        v = Math.max(0, v * (1 - counter * decVal / 100));
      }
    }
    return v;
  }
}

// =====================================================================
// BATTLE ROUND
// =====================================================================

class SimBattleRound {
  fighter: SimFighter;
  opponent: SimFighter;
  round_idx: number;
  army_min: number;

  round_troops: Record<UT, number>;
  stunned: Record<UT, boolean>;
  targets: Partial<Record<UT, UT>>;
  round_effects: SimRoundEffect[];
  order_effects: SimRoundEffect[];
  dodge_effects: SimRoundEffect[];
  round_benefits: SimBenefit[];
  round_kills: Partial<Record<UT, Partial<Record<UT, number>>>>;
  round_dmg_coef: Record<UT, number>;

  constructor(fighter: SimFighter, opponent: SimFighter, round_idx: number, army_min: number) {
    this.fighter = fighter;
    this.opponent = opponent;
    this.round_idx = round_idx;
    this.army_min = army_min;

    this.stunned = { inf: false, lanc: false, mark: false };
    this.targets = {};
    this.round_effects = [];
    this.order_effects = [];
    this.dodge_effects = [];
    this.round_benefits = [];
    this.round_kills = {};
    this.round_dmg_coef = { inf: 0, lanc: 0, mark: 0 };

    // Calc troops from previous round
    this.round_troops = this.calcRoundTroops();
  }

  private calcRoundTroops(): Record<UT, number> {
    if (this.round_idx === 0) {
      return { ...this.fighter.troops_by_type };
    }
    const prev = this.fighter.rounds[this.round_idx - 1];
    const oppPrev = this.opponent.rounds[this.round_idx - 1];
    const result: Record<UT, number> = { inf: 0, lanc: 0, mark: 0 };
    for (const ut of ALL_UT) {
      let kills = 0;
      for (const kills_by_type of Object.values(oppPrev.round_kills)) {
        kills += (kills_by_type as Record<UT, number>)[ut] ?? 0;
      }
      result[ut] = Math.max(0, prev.round_troops[ut] - kills);
    }
    return result;
  }

  total_troops(): number {
    return ALL_UT.reduce((s, ut) => s + this.round_troops[ut], 0);
  }

  // ---- Skill phase ----

  calcStunned(): void {
    if (this.round_idx < 1) return;
    for (const ut of ALL_UT) {
      if (this.stunned[ut]) continue;
      const oppPrevBenefits = this.opponent.rounds[this.round_idx - 1]?.round_benefits ?? [];
      for (const benefit of oppPrevBenefits) {
        if (!benefit.benefit_type.toLowerCase().includes('stun')) continue;
        if (benefit.isValid('any', ut, this.round_idx)) {
          this.stunned[ut] = true;
          benefit.use();
          break;
        }
      }
    }
  }

  calcSkills(): void {
    this.calcStunned();
    this.calcRoundEffects();
    this.calcTargets();
  }

  private calcRoundEffects(): void {
    for (const eff of this.fighter.effects) {
      if (eff.skill.r_skill_condition(this.fighter, this.round_idx)) {
        if (eff.r_effect_condition(this.fighter, this.opponent, this.round_idx)) {
          this.addRoundEffect(eff);
        }
      }
    }
  }

  private addRoundEffect(eff: SimEffect): void {
    eff.activations_count++;
    const re = new SimRoundEffect(eff, this.round_idx);
    const t = eff.type.toLowerCase();
    if (t.includes('attack_order')) this.order_effects.push(re);
    else if (t.includes('dodge'))   this.dodge_effects.push(re);
    else                             this.round_effects.push(re);
  }

  private calcTargets(): void {
    for (const ut of ALL_UT) {
      if (!this.round_troops[ut]) continue;
      this.targets[ut] = this.getUnitTarget(ut);
    }
  }

  private getUnitTarget(ut: UT): UT {
    let order: UT[] = [...ALL_UT]; // default: [inf, lanc, mark]
    if (ut === 'lanc' && this.order_effects.length > 0) {
      const re = this.order_effects[this.order_effects.length - 1];
      if (re.trigger_condition(this.fighter, this.opponent, ut, 'inf', this.round_idx)) {
        const raw = re.effect.value as unknown;
        if (typeof raw === 'string') {
          order = raw.split('/').map(s => toUT(s)).filter(Boolean) as UT[];
        }
        re.effect.trigger_count++;
        re.effect.uses_count++;
      }
    }
    for (const vs of order) {
      if ((this.opponent.rounds[this.round_idx]?.round_troops[vs] ?? 0) > 0) return vs;
    }
    return 'inf'; // fallback
  }

  // ---- Benefits phase ----

  calcBenefits(): void {
    const defenseEffects: SimRoundEffect[] = [];

    for (const re of this.round_effects) {
      if (re.effect.special['onDefense']) {
        defenseEffects.push(re);
        continue;
      }
      for (const ut of ALL_UT) {
        if (!this.round_troops[ut]) continue;
        const target = this.targets[ut];
        if (!target) continue;
        if (re.trigger_condition(this.fighter, this.opponent, ut, target, this.round_idx)) {
          this.round_benefits.push(re.activate(this.fighter, ut, target));
        }
      }
    }

    // Defense-side effects
    for (const re of defenseEffects) {
      for (const vs of ALL_UT) {
        const oppRound = this.opponent.rounds[this.round_idx];
        if (!oppRound?.round_troops[vs]) continue;
        const victim = oppRound.targets[vs];
        if (!victim) continue;
        if (re.trigger_condition(this.fighter, this.opponent, victim, vs, this.round_idx)) {
          this.round_benefits.push(re.activate(this.fighter, victim, vs));
        }
      }
    }

    // Carry over still-valid benefits from previous round
    if (this.round_idx > 0) {
      for (const b of this.fighter.rounds[this.round_idx - 1].round_benefits) {
        if (b.isValid('any', 'any', this.round_idx)) {
          this.round_benefits.push(b);
        }
      }
    }
  }

  // ---- Kills calculation ----

  getResults(): void {
    this.calcRoundKills();
  }

  private calcDodgingBenefits(ut: UT, target: UT): void {
    const oppDodges = this.opponent.rounds[this.round_idx]?.dodge_effects ?? [];
    for (const re of oppDodges) {
      if (re.trigger_condition(this.fighter, this.opponent, target, ut, this.round_idx)) {
        this.opponent.rounds[this.round_idx].round_benefits.push(re.activate(this.fighter, target, ut));
      }
    }
  }

  private calcRoundKills(): void {
    for (const ut of ALL_UT) {
      const army = this.calcRoundArmy(ut);
      if (army === 0) continue;
      if (this.stunned[ut]) continue;

      const target = this.targets[ut];
      if (!target) continue;

      this.calcDodgingBenefits(ut, target);

      const unitBaseDmg = army * this.fighter.attack_by_type[ut] / this.opponent.defense_by_type[target] / 100;
      let utKills = this.calcBonusDmg(unitBaseDmg, ut, target);

      // Fatigue
      utKills *= (1 - 0.01 / 100 * this.round_idx);

      if (utKills > 0) {
        this.round_kills[ut] = { [target]: utKills };
      }
    }
  }

  private calcBonusDmg(unitBaseDmg: number, ut: UT, vs: UT): number {
    const attackKeys = ['DamageUp', 'OppDefenseDown'];
    const defenseKeys = ['DefenseUp', 'OppDamageDown'];
    const allKeys = [...attackKeys, ...defenseKeys];

    const bonus: Record<string, Record<string, number>> = {};
    const onlyNormal: Record<string, Record<string, number>> = {};
    const extra: Record<string, Record<string, number>> = {};
    for (const k of allKeys) { bonus[k] = {}; onlyNormal[k] = {}; extra[k] = {}; }

    // Fighter's own benefits
    for (const b of this.round_benefits) {
      if (!attackKeys.includes(b.benefit_type)) continue;
      if (!b.isValid(ut, vs, this.round_idx)) continue;

      const bv = b.correctValue(this.round_idx);
      const target = b.extra_attack ? extra : b.only_normal ? onlyNormal : bonus;
      target[b.benefit_type][b.op] = (target[b.benefit_type][b.op] ?? 0) + bv;

      if (b.extra_attack) {
        this.fighter.cumul_attacks[ut]++;
        this.opponent.cumul_received_attacks[vs]++;
      }
      b.use();
    }

    // Opponent's defense benefits
    let dodging = 0;
    const oppBenefits = this.opponent.rounds[this.round_idx]?.round_benefits ?? [];
    for (const ob of oppBenefits) {
      if (!ob.isValid(vs, ut, this.round_idx)) continue;
      const t = ob.benefit_type.toLowerCase();

      if (t.includes('dodge')) {
        dodging = Math.max(ob.only_normal ? 1 : 2, dodging);
        ob.use();
        continue;
      }
      if (!defenseKeys.includes(ob.benefit_type)) continue;
      bonus[ob.benefit_type][ob.op] = (bonus[ob.benefit_type][ob.op] ?? 0) + ob.correctValue(this.round_idx);
      ob.use();
    }

    const baseCoef   = this.calcCoef(bonus);
    const normalCoef = this.calcCoef(onlyNormal);
    const extraCoef  = this.calcCoef(extra);

    let coef: number;
    if (dodging === 2)      coef = 0;
    else if (dodging === 1) coef = baseCoef * (extraCoef - 1);
    else                    coef = baseCoef * (extraCoef + normalCoef - 1);

    this.round_dmg_coef[ut] = coef;
    if (dodging < 2) {
      this.fighter.cumul_attacks[ut]++;
      this.opponent.cumul_received_attacks[vs]++;
    }

    return unitBaseDmg * coef;
  }

  private calcCoef(stats: Record<string, Record<string, number>>): number {
    const damageUp      = Object.values(stats['DamageUp']      ?? {}).reduce((p, v) => p * (1 + v / 100), 1);
    const oppDamageDown = Object.values(stats['OppDamageDown'] ?? {}).reduce((p, v) => p * (1 - v / 100), 1);
    const defenseUp     = Object.values(stats['DefenseUp']     ?? {}).reduce((p, v) => p * (1 + v / 100), 1);
    const oppDefDown    = Object.values(stats['OppDefenseDown'] ?? {}).reduce((p, v) => p * (1 - v / 100), 1);
    return damageUp * oppDamageDown / (defenseUp * oppDefDown);
  }

  private calcRoundArmy(ut: UT): number {
    const t = this.round_troops[ut];
    if (!t) return 0;
    return Math.ceil(Math.sqrt(t) * Math.sqrt(this.army_min));
  }
}

// =====================================================================
// FIGHTER
// =====================================================================

class SimFighter {
  name: string;
  troops_by_type: Record<UT, number>;
  attack_by_type: Record<UT, number> = { inf: 0, lanc: 0, mark: 0 };
  defense_by_type: Record<UT, number> = { inf: 0, lanc: 0, mark: 0 };
  skills: SimSkill[] = [];
  effects: SimEffect[] = [];
  rounds: Record<number, SimBattleRound> = {};
  cumul_attacks: Record<UT, number> = { inf: 0, lanc: 0, mark: 0 };
  cumul_received_attacks: Record<UT, number> = { inf: 0, lanc: 0, mark: 0 };
  private troopLevels: TroopLevels;

  /**
   * @param name Fighter label
   * @param troops Troop counts per unit type
   * @param heroSquad Heroes with their widget levels
   * @param accountStats Per-unit-type stat bonuses (%)
   * @param troopLevels Per-type tier/FC (each unit type can be at a different level)
   */
  constructor(
    name: string,
    troops: Record<UT, number>,
    heroSquad: { name: string; widget: number }[],
    accountStats: AccountStats,
    troopLevels: TroopLevels = defaultTroopLevels(),
  ) {
    this.name = name;
    this.troops_by_type = { ...troops };
    this.troopLevels = troopLevels;
    this.calcStatsByType(accountStats);
    this.calcSkills(heroSquad);
    this.calcEffects();
  }

  /** Compute per-type attack/defense from troop base stats + real account bonuses */
  private calcStatsByType(s: AccountStats): void {
    const troopBase = getTroopBase(this.troopLevels);
    for (const ut of ALL_UT) {
      const base = troopBase[ut];
      const b = s[ut];
      const atk = base.attack * (1 + b.attack / 100) * base.lethality * (1 + b.lethality / 100) / 100;
      const def = base.health * (1 + b.health  / 100) * base.defense   * (1 + b.defense   / 100) / 100;
      this.attack_by_type[ut]  = atk;
      this.defense_by_type[ut] = def;
    }
  }

  /** Build skills list from troop skills + hero skills */
  private calcSkills(heroSquad: { name: string; widget: number }[]): void {
    // Troop skills — activate based on per-type tier/FC conditions
    const TROOP_SKILLS = TROOP_SKILLS_RAW as SkillDef[];
    for (const skillDef of TROOP_SKILLS) {
      const level = this.troopSkillLevel(skillDef);
      if (level > 0) this.skills.push(new SimSkill(skillDef, level));
    }

    // Hero skills
    for (const hero of heroSquad) {
      const skillsData = HERO_SKILL_MAP[hero.name] as SkillDef[] | undefined;
      if (!skillsData) continue;
      const levels = widgetToSkillLevels(hero.widget);
      for (const skillDef of skillsData) {
        const key = `skill_${skillDef.skill_num}`;
        if (levels[key] && levels[key] > 0) {
          this.skills.push(new SimSkill(skillDef, levels[key]));
        }
      }
    }
  }

  /**
   * Returns the highest matching level of a troop skill, evaluating each
   * unit type against its own tier/FC. Returns 0 if no condition matches.
   */
  private troopSkillLevel(def: SkillDef): number {
    const TROOP_STATS = TROOP_STATS_RAW as Record<string, { tier: number; fc: number }>;
    let level = 0;
    for (const ut of ALL_UT) {
      if (toUT(def.skill_troop_type) !== ut) continue;
      const lvl = this.troopLevels[ut];
      const typeName = ut === 'mark' ? 'marksman' : ut === 'lanc' ? 'lancer' : 'infantry';
      const troopKey = lvl.fc > 0 ? `${typeName}_t${lvl.tier}_fc${lvl.fc}` : `${typeName}_t${lvl.tier}`;
      const troop = TROOP_STATS[troopKey];
      if (!troop) continue;
      for (const cond of def.skill_conditions ?? []) {
        const cval = cond.condition_value;
        const actual = cond.condition_type === 'tier' ? troop.tier : troop.fc;
        if (actual >= cval) level = Math.max(level, parseInt(cond.level, 10));
      }
    }
    return level;
  }

  private calcEffects(): void {
    for (const skill of this.skills) {
      for (const effDef of skill.effects_data) {
        this.effects.push(new SimEffect(skill, effDef));
      }
    }
  }

  get_sum_army(roundIdx = 0): number {
    if (roundIdx && this.rounds[roundIdx]) {
      return ALL_UT.reduce((s, ut) => s + Math.ceil(this.rounds[roundIdx].round_troops[ut]), 0);
    }
    return ALL_UT.reduce((s, ut) => s + this.troops_by_type[ut], 0);
  }
}

// =====================================================================
// FIGHT (battle orchestrator)
// =====================================================================

class SimFight {
  attacker: SimFighter;
  defender: SimFighter;
  max_round: number;
  num_rounds = -1;

  constructor(attacker: SimFighter, defender: SimFighter, max_round = 1500) {
    this.attacker = attacker;
    this.defender = defender;
    this.max_round = max_round;
  }

  battle(): { attRemaining: number; defRemaining: number } {
    const army_min = Math.min(this.attacker.get_sum_army(), this.defender.get_sum_army());
    let round = 0;
    let end = false;

    while (!end && round <= this.max_round) {
      // Create rounds
      this.attacker.rounds[round] = new SimBattleRound(this.attacker, this.defender, round, army_min);
      this.defender.rounds[round] = new SimBattleRound(this.defender, this.attacker, round, army_min);

      const attTroops = this.attacker.rounds[round].total_troops();
      const defTroops = this.defender.rounds[round].total_troops();
      end = attTroops === 0 || defTroops === 0;
      if (end) break;

      // Skills
      this.attacker.rounds[round].calcSkills();
      this.defender.rounds[round].calcSkills();
      // Benefits
      this.attacker.rounds[round].calcBenefits();
      this.defender.rounds[round].calcBenefits();
      // Kills
      this.attacker.rounds[round].getResults();
      this.defender.rounds[round].getResults();

      round++;
    }

    this.num_rounds = round;
    const attRemaining = ALL_UT.reduce((s, ut) => s + Math.ceil(this.attacker.rounds[round]?.round_troops[ut] ?? 0), 0);
    const defRemaining = ALL_UT.reduce((s, ut) => s + Math.ceil(this.defender.rounds[round]?.round_troops[ut] ?? 0), 0);
    return { attRemaining, defRemaining };
  }
}

// =====================================================================
// ANGULAR SERVICE
// =====================================================================

export interface SimMatchup {
  ratioLabel: string;
  wins: number;
  total: number;
  avgAttSurvivors: number;
  avgDefSurvivors: number;
  attWins: boolean;
}

export interface SimPresetResult {
  preset: StrengthPreset;
  vsA: SimMatchup;
  vsB: SimMatchup;
}

export interface SimComparison {
  recommendedRatio: string;
  opponentRatioA: string;
  opponentRatioB: string;
  totalTroops: number;
  results: SimPresetResult[]; // one entry per strength preset (Low→Strong)
}

// ─────────────────────────────────────────────────────────────────────────────
// RATIO RECOMMENDER
//
// Two-round tournament over a fixed candidate pool to pick the best ratio for
// a given (squad, attStats) pair. Both sides of every simulated battle share
// the same heroes and the same account stats — only the troop ratios differ.
//
// Round 1 (qualifier): each candidate plays 40 battles vs the 5/2/3 baseline
//   (20 at 100k troops + 20 at 180k troops). Score = average attacker
//   survival rate across all 40 battles. Top 3 candidates advance.
//
// Round 2 (gauntlet): each surviving candidate plays every other candidate
//   (10 matchups total), 40 battles per matchup. The 5 matchups where the
//   candidate dominated hardest are dropped (outliers inflate the mean), and
//   the average survival rate across the remaining 5 matchups is computed.
//   The candidate with the highest robust-average survival rate is returned.
// ─────────────────────────────────────────────────────────────────────────────

const RECOMMENDER_BASELINE = '5/2/3';
const RECOMMENDER_CANDIDATES = [
  '6/4/0', '6/1/3', '5/1/4', '48/4/48', '4/6/0',
  '4/1/5', '7/3/0', '65/5/30', '6/3/1', '5/4/1',
];
const RECOMMENDER_TOTALS = [100_000, 180_000];
const RECOMMENDER_RUNS_PER_TOTAL = 20;

function parseRatioToTroops(ratio: string, total: number): Record<UT, number> {
  const [i, l, m] = ratio.split('/').map(s => parseFloat(s.trim()));
  const sum = i + l + m;
  return {
    inf: Math.round(total * i / sum),
    lanc: Math.round(total * l / sum),
    mark: Math.round(total * m / sum),
  };
}

export interface RatioRecommendation {
  /** The recommended ratio (e.g. "48/4/48"). */
  ratio: string;
  /** Robust-average survival rate of the winner on [0..1]. */
  avgSurvivalRate: number;
  /** All 10 candidates ranked by round-1 survival rate vs the baseline. */
  qualifier: Array<{ ratio: string; survivalRate: number }>;
  /** The top-3 finalists with their round-2 robust average. */
  finalists: Array<{ ratio: string; avgSurvivalRate: number; matchups: Array<{ vs: string; survivalRate: number }> }>;
}

@Injectable({ providedIn: 'root' })
export class SimulatorService {

  /**
   * Picks the best troop ratio for the given (squad, attStats) via a
   * two-round mirror-match tournament over a fixed candidate pool.
   * See RATIO RECOMMENDER comment block above for the detailed protocol.
   */
  recommendRatio(
    squad: ScoredHero[],
    attStats: AccountStats,
    attLevels: TroopLevels = defaultTroopLevels(),
  ): RatioRecommendation {
    const heroSquad = squad.map(h => ({ name: h.name, widget: h.widget }));

    // Simulate one (playerRatio) vs (opponentRatio) matchup across both
    // totalTroops values and return the average attacker survival rate.
    // Both sides use the player's troop levels for a fair mirror match.
    const simulateMatchup = (playerRatio: string, opponentRatio: string): number => {
      let totalAttRemaining = 0;
      let totalDeployed = 0;
      for (const total of RECOMMENDER_TOTALS) {
        const attTroops = parseRatioToTroops(playerRatio, total);
        const defTroops = parseRatioToTroops(opponentRatio, total);
        for (let i = 0; i < RECOMMENDER_RUNS_PER_TOTAL; i++) {
          const att = new SimFighter('Attacker', { ...attTroops }, heroSquad, attStats, attLevels);
          const def = new SimFighter('Defender', { ...defTroops }, heroSquad, attStats, attLevels);
          const { attRemaining } = new SimFight(att, def).battle();
          totalAttRemaining += attRemaining;
          totalDeployed += total;
        }
      }
      return totalDeployed > 0 ? totalAttRemaining / totalDeployed : 0;
    };

    // ── Round 1: qualifier — each candidate vs the 5/2/3 baseline ─────────
    const qualifier = RECOMMENDER_CANDIDATES.map(ratio => ({
      ratio,
      survivalRate: simulateMatchup(ratio, RECOMMENDER_BASELINE),
    }));
    qualifier.sort((a, b) => b.survivalRate - a.survivalRate);
    const top3 = qualifier.slice(0, 3);

    // ── Round 2: gauntlet — top 3 vs every candidate, drop 5 dominants ───
    const finalists = top3.map(({ ratio }) => {
      const matchups = RECOMMENDER_CANDIDATES.map(opponent => ({
        vs: opponent,
        survivalRate: simulateMatchup(ratio, opponent),
      }));
      const sortedDesc = [...matchups].sort((a, b) => b.survivalRate - a.survivalRate);
      // Drop the 5 strongest results (dominant victories) and average the rest.
      const remaining = sortedDesc.slice(5);
      const avgSurvivalRate = remaining.length > 0
        ? remaining.reduce((s, m) => s + m.survivalRate, 0) / remaining.length
        : 0;
      return { ratio, avgSurvivalRate, matchups };
    });
    finalists.sort((a, b) => b.avgSurvivalRate - a.avgSurvivalRate);

    const winner = finalists[0];
    return {
      ratio: winner.ratio,
      avgSurvivalRate: winner.avgSurvivalRate,
      qualifier,
      finalists,
    };
  }

  /**
   * Runs the recommended ratio vs 6/4/0 and 5/2/3 for all 3 strength presets.
   *
   * Attacker: player's own gear-estimated stats + their hero squad + recommended ratio
   * Defender: preset stats + same hero squad + opponent ratio
   *
   * @param squad        3 heroes chosen by the calculator
   * @param gear         player's gear tier (0-4) per type
   * @param ratio        recommended ratio string e.g. "48 / 4 / 48"
   * @param totalTroops  troops per side (default 100 000)
   * @param runs         simulation runs per matchup (default 20)
   */
  runComparison(
    squad: ScoredHero[],
    ratio: string,
    totalTroops = 100_000,
    runs = 20,
    attStats: AccountStats = { ...zeroAccountStats() },
    attLevels: TroopLevels = defaultTroopLevels(),
    opponentRatioA = '6/4/0',
    opponentRatioB = '5/2/3',
  ): SimComparison {
    const parseParts = (r: string): [number, number, number] => {
      const [a, b, c] = r.split('/').map(s => parseFloat(s.trim()));
      return [a || 0, b || 0, c || 0];
    };

    const [ri, rl, rm] = parseParts(ratio);
    const sumR = ri + rl + rm;

    const attTroops: Record<UT, number> = {
      inf:  Math.round(totalTroops * ri / sumR),
      lanc: Math.round(totalTroops * rl / sumR),
      mark: Math.round(totalTroops * rm / sumR),
    };

    const partsA = parseParts(opponentRatioA);
    const partsB = parseParts(opponentRatioB);

    const heroSquad = squad.map(h => ({ name: h.name, widget: h.widget }));

    // Mirror-match preset: defender uses the same lineup, stats, and troop
    // levels as the attacker. Useful for benchmarking the player's own ratio
    // against itself with the chosen opponent ratios.
    const selfPreset: StrengthPreset = {
      label: 'Yourself',
      troops: attLevels,
      heroes: squad.map(h => ({ name: h.name, stars: h.stars, widget: h.widget })),
      stats: attStats,
    };

    const allPresets: StrengthPreset[] = [selfPreset, ...STRENGTH_PRESETS];

    const results: SimPresetResult[] = allPresets.map(preset => {
      const defSquad = preset.heroes.map(h => ({ name: h.name, widget: h.widget }));
      return {
        preset,
        vsA: this.runMatchup(attTroops, attStats, heroSquad, attLevels, partsA, preset.stats, defSquad, preset.troops, totalTroops, runs),
        vsB: this.runMatchup(attTroops, attStats, heroSquad, attLevels, partsB, preset.stats, defSquad, preset.troops, totalTroops, runs),
      };
    });

    return { recommendedRatio: ratio, opponentRatioA, opponentRatioB, totalTroops, results };
  }

  private runMatchup(
    attTroops: Record<UT, number>,
    attStats: AccountStats,
    attSquad: { name: string; widget: number }[],
    attLevels: TroopLevels,
    defRatioParts: [number, number, number],
    defStats: AccountStats,
    defSquad: { name: string; widget: number }[],
    defLevels: TroopLevels,
    totalTroops: number,
    runs: number,
  ): SimMatchup {
    const [di, dl, dm] = defRatioParts;
    const defSum = di + dl + dm;

    const defTroops: Record<UT, number> = {
      inf:  Math.round(totalTroops * di / defSum),
      lanc: Math.round(totalTroops * dl / defSum),
      mark: Math.round(totalTroops * dm / defSum),
    };

    let wins = 0, totalAtt = 0, totalDef = 0;

    for (let i = 0; i < runs; i++) {
      const att = new SimFighter('Attacker', { ...attTroops }, attSquad, attStats, attLevels);
      const def = new SimFighter('Defender', { ...defTroops }, defSquad, defStats, defLevels);
      const { attRemaining, defRemaining } = new SimFight(att, def).battle();
      if (attRemaining > defRemaining) wins++;
      totalAtt += attRemaining;
      totalDef += defRemaining;
    }

    return {
      ratioLabel: defRatioParts.join('/'),
      wins,
      total: runs,
      avgAttSurvivors: Math.round(totalAtt / runs),
      avgDefSurvivors: Math.round(totalDef / runs),
      attWins: wins > runs / 2,
    };
  }
}
