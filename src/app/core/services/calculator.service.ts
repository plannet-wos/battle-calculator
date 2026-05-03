import { Injectable } from '@angular/core';
import { HeroInput, HeroBase, ScoredHero, LineupResult, HeroStatsByGen } from '../models/hero.model';
import { HeroDataService } from './hero-data.service';

@Injectable({ providedIn: 'root' })
export class CalculatorService {
  constructor(private heroData: HeroDataService) {}

  /**
   * Score a hero based on generation, stars, and widget level.
   * Formula: (HeroStatsByGen[gen] * stars) / 100 + widget * 0.6
   *   - HeroStatsByGen scales the base power contribution by generation (Gen 1 = 200.2 … Gen 5 = 444.35)
   *   - Stars multiplies that base (1–5 yellow stars)
   *   - Widget adds a flat 0.6 per level (0–10)
   */
  private score(base: HeroBase, input: HeroInput): number {
    return (HeroStatsByGen[base.gen] * input.stars) / 100 + input.widget * 0.6;
  }

  calculate(inputs: HeroInput[]): LineupResult | null {
    const ownedInputs = inputs.filter(i => i.owned);
    if (!ownedInputs.length) return null;

    // Match owned heroes against the database and score them
    const scored: ScoredHero[] = [];
    for (const base of this.heroData.heroes) {
      const input = ownedInputs.find(i => i.name === base.name);
      if (input) {
        scored.push({ ...base, stars: input.stars, widget: input.widget, score: this.score(base, input) });
      }
    }

    const byType = (type: string) => scored.filter(h => h.type === type);

    const infantry = byType('Infantry');
    const marksmen = byType('Marksman');
    const lancers  = byType('Lancer');

    const notes: string[] = [];
    if (!infantry.length) notes.push('⚠ No Infantry hero owned — squad is incomplete.');
    if (!marksmen.length) notes.push('⚠ No Marksman hero owned — squad is incomplete.');
    if (!lancers.length)  notes.push('⚠ No Lancer hero owned — squad is incomplete.');

    const bestInf  = infantry.length ? infantry.reduce((a, b) => a.score > b.score ? a : b) : null;
    const bestMark = marksmen.length ? marksmen.reduce((a, b) => a.score > b.score ? a : b) : null;
    const bestLanc = lancers.length  ? lancers.reduce((a, b)  => a.score > b.score ? a : b) : null;

    const squad = [bestInf, bestMark, bestLanc].filter(Boolean) as ScoredHero[];

    // Average score across the chosen squad
    const avgScore = squad.length
      ? squad.reduce((sum, h) => sum + h.score, 0) / squad.length
      : 0;

    // Ratio/strategy are filled in later by the feature component once all
    // required data sources (battle-report stats scan + gear scan) are
    // available, by invoking SimulatorService.recommendRatio().
    return { squad, avgScore, ratio: '', strategy: '', notes };
  }
}
