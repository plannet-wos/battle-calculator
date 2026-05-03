import { Component, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSliderModule } from '@angular/material/slider';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatBadgeModule } from '@angular/material/badge';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { NgClass, DecimalPipe } from '@angular/common';

import { HeroDataService } from '../../core/services/hero-data.service';
import { CalculatorService } from '../../core/services/calculator.service';
import { SimulatorService, SimComparison, addAccountStats, gearItemsToStatBonus, zeroAccountStats, baseHeroToStatsBonus } from '../../core/sim/simulator.service';
import { HeroScanService } from '../../core/services/hero-scan.service';
import { GearScanService } from '../../core/services/gear-scan.service';
import { StatsScanService } from '../../core/services/stats-scan.service';
import { HeroInput, LineupResult, GearScanResult, AccountStats, DetectedGearItem, UnitStatBonus, BattleReportScan, TroopLevels, defaultTroopLevels, defaultGearScanResult, normalizeGearScanResult } from '../../core/models/hero.model';
import { TutorialDialog } from './tutorial-dialog';

type GearTroopKey = 'infantry' | 'lancer' | 'marksman';
type GearColor = DetectedGearItem['color'];

@Component({
  selector: 'app-calculator',
  standalone: true,
  imports: [
    FormsModule, NgClass, DecimalPipe,
    MatCardModule, MatCheckboxModule, MatSliderModule,
    MatButtonModule, MatIconModule, MatDividerModule,
    MatChipsModule, MatTooltipModule, MatBadgeModule, MatProgressSpinnerModule, MatDialogModule,
  ],
  templateUrl: './calculator.html',
  styleUrl: './calculator.scss',
})
export class Calculator {
  private heroData = inject(HeroDataService);
  private calcService = inject(CalculatorService);
  private simService = inject(SimulatorService);
  private heroScanService = inject(HeroScanService);
  private gearScanService = inject(GearScanService);
  private statsScanService = inject(StatsScanService);
  private dialog = inject(MatDialog);

  readonly heroInputs = signal<HeroInput[]>(
    this.heroData.heroes.map(h => ({ name: h.name, owned: false, stars: 1, widget: 0 })),
  );

  readonly result = signal<LineupResult | null>(null);
  readonly simResult = signal<SimComparison | null>(null);
  readonly simRunning = signal(false);

  // Editable troop ratios for the simulation. `playerRatio` is seeded from the
  // calculator's recommended ratio whenever calculate() succeeds, but the user
  // can override it before running the sim. The two opponent ratios default to
  // the standard 6/4/0 and 5/2/3 metas and persist across calculations.
  readonly playerRatio = signal<string>('');
  readonly opponentRatioA = signal<string>('6/4/0');
  readonly opponentRatioB = signal<string>('5/2/3');

  // Hero scan
  readonly scanFile = signal<File | null>(null);
  readonly scanStatus = signal<'idle' | 'scanning' | 'done' | 'error'>('idle');
  readonly scanMessage = signal('');
  readonly scanExpanded = signal(true);

  // Gear scan. Each troop type always has exactly 4 fixed rows (head, gloves,
  // belt, shoes) so the user can edit every slot manually without needing an
  // "add item" affordance. `gearDataReady` flips to true on first scan/edit
  // and gates the simulator.
  readonly gearScanFile = signal<File | null>(null);
  readonly gearScanStatus = signal<'idle' | 'scanning' | 'done' | 'error'>('idle');
  readonly gearScanMessage = signal('');
  readonly gearScanExpanded = signal(true);
  readonly gearScanResult = signal<GearScanResult>(defaultGearScanResult());
  readonly gearDataReady = signal(false);

  // Inline-edit state for the gear scan results table. When the user clicks
  // the pencil icon on a row we copy the item into `editDraft` and the row
  // renders inputs/selects bound to that draft. Save commits the draft back
  // into `gearScanResult`; cancel just clears the editing pointer. Piece is
  // fixed (one slot per type), so only color/bonus/mastery are editable.
  readonly editingGear = signal<{ troop: GearTroopKey; index: number } | null>(null);
  readonly editDraft = signal<DetectedGearItem | null>(null);
  readonly gearColorOptions: GearColor[] = ['red', 'orange', 'unknown'];

  // Inline-edit state for the stats scan table — covers BOTH the stat-bonus
  // table and the troop tier/FC row, since they're scanned and edited together.
  readonly editingStats = signal(false);
  readonly statsDraft = signal<AccountStats | null>(null);
  readonly troopsDraft = signal<TroopLevels | null>(null);

  // Stats scan (battle report) — holds both the per-type stat bonuses and the
  // per-type troop tier/FC. Either half can be edited via the same toggle.
  // Result starts with zeroed stats + default T10/FC5 troops so the table is
  // visible before any scan. `statsDataReady` flips to true on first scan/edit.
  readonly statsScanFile = signal<File | null>(null);
  readonly statsScanStatus = signal<'idle' | 'scanning' | 'done' | 'error'>('idle');
  readonly statsScanMessage = signal('');
  readonly statsScanExpanded = signal(true);
  readonly statsScanResult = signal<BattleReportScan>({
    stats: zeroAccountStats(),
    troops: defaultTroopLevels(),
  });
  readonly statsDataReady = signal(false);

  /**
   * The total account-stat bonuses (%) that will be fed into the simulator.
   * Combines three sources in order of availability:
   *   1. Battle-report scan  → base ATK/DEF/LETH/HP bonuses per unit type
   *   2. Gear backpack scan  → additional % from each detected gear piece
   *   3. Hero contributions  → ATK/DEF from stars, LETH/HP from widget level
   * Returns all-zeros until all three sources (lineup result, stats scan,
   * gear scan) are present so the template can render a "not yet scanned" state.
   */
  readonly effectiveStats = computed(() => {
    const scanned        = this.statsScanResult();
    const gearResult     = this.gearScanResult();
    const baseHeroResult = this.result()?.squad;
    if (!baseHeroResult || !this.statsDataReady() || !this.gearDataReady()) return zeroAccountStats();
    return addAccountStats(scanned.stats, gearItemsToStatBonus(gearResult), baseHeroToStatsBonus(baseHeroResult));
  });

  readonly generations = computed(() => {
    const gens = new Map<number, HeroInput[]>();
    for (const hero of this.heroData.heroes) {
      const input = this.heroInputs().find(i => i.name === hero.name)!;
      const list = gens.get(hero.gen) ?? [];
      list.push(input);
      gens.set(hero.gen, list);
    }
    return [...gens.entries()].sort((a, b) => a[0] - b[0]);
  });

  getHeroBase(name: string) {
    return this.heroData.heroes.find(h => h.name === name)!;
  }

  typeIcon(type: string): string {
    return { Infantry: '🛡️', Marksman: '🎯', Lancer: '⚔️' }[type] ?? '❓';
  }

  typeColor(type: string): string {
    return { Infantry: 'infantry', Marksman: 'marksman', Lancer: 'lancer' }[type] ?? '';
  }

  starLabel(value: number) { return `${value}★`; }

  updateOwned(name: string, owned: boolean) {
    this.heroInputs.update(list =>
      list.map(h => h.name === name ? { ...h, owned } : h)
    );
    this.result.set(null);
  }

  updateStars(name: string, stars: number) {
    this.heroInputs.update(list =>
      list.map(h => h.name === name ? { ...h, stars } : h)
    );
    this.result.set(null);
  }

  updateWidget(name: string, widget: number) {
    this.heroInputs.update(list =>
      list.map(h => h.name === name ? { ...h, widget } : h)
    );
    this.result.set(null);
  }

  onGearFileSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;
    this.gearScanFile.set(file);
    this.gearScanStatus.set('idle');
    this.gearScanMessage.set('');
  }

  onStatsFileSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;
    this.statsScanFile.set(file);
    this.statsScanStatus.set('idle');
    this.statsScanMessage.set('');
  }

  async scanStats() {
    const file = this.statsScanFile();
    if (!file) return;
    this.statsScanStatus.set('scanning');
    this.statsScanMessage.set('');
    try {
      const scan = await this.statsScanService.scan(file);
      this.statsScanResult.set(scan);
      this.statsDataReady.set(true);
      this.statsScanStatus.set('done');
      const t = scan.troops;
      this.statsScanMessage.set(
        `Detected 12 stat bonuses + troop levels ` +
        `(I: T${t.inf.tier}/FC${t.inf.fc}, ` +
        `L: T${t.lanc.tier}/FC${t.lanc.fc}, ` +
        `M: T${t.mark.tier}/FC${t.mark.fc}). Edit if needed.`
      );
      // Invalidate any existing sim result so it's re-run with the new stats
      this.simResult.set(null);
    } catch (e) {
      this.statsScanStatus.set('error');
      this.statsScanMessage.set((e as Error).message);
    }
  }

  async scanGear() {
    const file = this.gearScanFile();
    if (!file) return;
    this.gearScanStatus.set('scanning');
    this.gearScanMessage.set('');
    try {
      const raw = await this.gearScanService.scan(file);
      // Normalize so each troop has all 4 piece slots — missing pieces become
      // empty rows the user can fill in manually.
      const result = normalizeGearScanResult(raw);
      this.gearScanResult.set(result);
      this.gearDataReady.set(true);
      const detected = (items: DetectedGearItem[]) =>
        items.filter(i => i.color !== 'unknown' || i.bonusLevel > 0 || i.masteryLevel > 0).length;
      const total = detected(raw.infantry) + detected(raw.lancer) + detected(raw.marksman);
      this.gearScanStatus.set('done');
      this.gearScanMessage.set(
        `Found ${total} items — Infantry: ${detected(raw.infantry)}, ` +
        `Lancer: ${detected(raw.lancer)}, Marksman: ${detected(raw.marksman)}. Edit empty rows if needed.`
      );
    } catch (e) {
      this.gearScanStatus.set('error');
      this.gearScanMessage.set((e as Error).message);
    }
  }

  startEditGearItem(troop: GearTroopKey, index: number) {
    const res = this.gearScanResult();
    if (!res) return;
    const item = res[troop][index];
    if (!item) return;
    this.editingGear.set({ troop, index });
    this.editDraft.set({ ...item });
  }

  cancelEditGearItem() {
    this.editingGear.set(null);
    this.editDraft.set(null);
  }

  saveEditGearItem() {
    const target = this.editingGear();
    const draft = this.editDraft();
    if (!target || !draft) return;
    const res = this.gearScanResult();
    const next: GearScanResult = {
      infantry: [...res.infantry],
      lancer:   [...res.lancer],
      marksman: [...res.marksman],
    };
    next[target.troop][target.index] = { ...draft };
    this.gearScanResult.set(next);
    this.gearDataReady.set(true);
    // Edits invalidate any cached simulation that depended on prior values.
    this.simResult.set(null);
    this.cancelEditGearItem();
  }

  updateDraftField<K extends keyof DetectedGearItem>(field: K, value: DetectedGearItem[K]) {
    const draft = this.editDraft();
    if (!draft) return;
    this.editDraft.set({ ...draft, [field]: value });
  }

  isEditingRow(troop: GearTroopKey, index: number): boolean {
    const e = this.editingGear();
    return !!e && e.troop === troop && e.index === index;
  }

  startEditStats() {
    const res = this.statsScanResult();
    this.statsDraft.set({
      inf:  { ...res.stats.inf },
      lanc: { ...res.stats.lanc },
      mark: { ...res.stats.mark },
    });
    this.troopsDraft.set({
      inf:  { ...res.troops.inf },
      lanc: { ...res.troops.lanc },
      mark: { ...res.troops.mark },
    });
    this.editingStats.set(true);
  }

  cancelEditStats() {
    this.editingStats.set(false);
    this.statsDraft.set(null);
    this.troopsDraft.set(null);
  }

  saveEditStats() {
    const draft = this.statsDraft();
    const troops = this.troopsDraft();
    if (!draft || !troops) return;
    this.statsScanResult.set({
      stats: {
        inf:  { ...draft.inf },
        lanc: { ...draft.lanc },
        mark: { ...draft.mark },
      },
      troops: {
        inf:  { ...troops.inf },
        lanc: { ...troops.lanc },
        mark: { ...troops.mark },
      },
    });
    this.statsDataReady.set(true);
    // Edits invalidate any cached simulation that depended on prior values.
    this.simResult.set(null);
    this.cancelEditStats();
  }

  updateStatsDraft(troop: 'inf' | 'lanc' | 'mark', field: keyof UnitStatBonus, value: number) {
    const draft = this.statsDraft();
    if (!draft) return;
    this.statsDraft.set({
      ...draft,
      [troop]: { ...draft[troop], [field]: value },
    });
  }

  updateTroopsDraft(troop: 'inf' | 'lanc' | 'mark', field: 'tier' | 'fc', value: number) {
    const draft = this.troopsDraft();
    if (!draft) return;
    // Clamp to legal ranges so the simulator never sees nonsense.
    const clamped = field === 'tier'
      ? Math.max(1, Math.min(11, value | 0))
      : Math.max(0, Math.min(5,  value | 0));
    this.troopsDraft.set({
      ...draft,
      [troop]: { ...draft[troop], [field]: clamped },
    });
  }

  typeLabel(type: 'Infantry' | 'Lancer' | 'Marksman'): string {
    return { Infantry: '🛡️ Infantry', Lancer: '⚔️ Lancer', Marksman: '🎯 Marksman' }[type];
  }

  calculate() {
    const res = this.calcService.calculate(this.heroInputs());
    if (res) {
      // If all three data sources are ready, compute the recommended
      // ratio via the tournament simulator. Otherwise leave it blank so the
      // UI can prompt the user to scan or enter gear + battle-report stats.
      const scanned    = this.statsScanResult();
      const gearResult = this.gearScanResult();
      if (this.statsDataReady() && this.gearDataReady() && res.squad.length > 0) {
        const attStats = addAccountStats(
          scanned.stats,
          gearItemsToStatBonus(gearResult),
          baseHeroToStatsBonus(res.squad),
        );
        const rec = this.simService.recommendRatio(res.squad, attStats, scanned.troops);
        res.ratio = rec.ratio;
        res.strategy = `Tournament pick (robust survival ${(rec.avgSurvivalRate * 100).toFixed(1)}%)`;
        res.notes.push(
          `Recommended ratio ${rec.ratio} selected by two-round mirror-match tournament ` +
          `over ${rec.qualifier.length} candidates.`,
        );
      } else {
        res.ratio = '—';
        res.strategy = 'Scan or enter gear + battle report stats to get a recommended ratio';
      }
      // Seed the editable player ratio with the recommendation. The user can
      // still override it in the UI before running the sim.
      this.playerRatio.set(res.ratio);
    }
    this.result.set(res);
    this.simResult.set(null);
  }

  runSimulation() {
    const res = this.result();
    if (!res || res.squad.length === 0) return;
    this.simRunning.set(true);
    // Run async so the "running" state renders first
    setTimeout(() => {
      try {
        const scanned = this.statsScanResult();
        const gearResult = this.gearScanResult();
        const baseHeroResult = this.result()?.squad;
        if (this.statsDataReady() && this.gearDataReady() && baseHeroResult) {
          const attStats = addAccountStats(
            scanned.stats,
            gearItemsToStatBonus(gearResult),
            baseHeroToStatsBonus(baseHeroResult),
          );
          const playerRatio = this.playerRatio() || res.ratio;
          const sim = this.simService.runComparison(
            res.squad, playerRatio, undefined, undefined, attStats, scanned.troops,
            this.opponentRatioA(), this.opponentRatioB(),
          );
          this.simResult.set(sim);
        } else {
          // Simulation requires all three data sources to be ready: stats, gear, and a calculated lineup.
          console.warn('Simulation skipped: provide gear and battle-report stats (scan or enter manually) and calculate a lineup first.');
        }
      } finally {
        this.simRunning.set(false);
      }
    }, 0);
  }

  reset() {
    this.heroInputs.set(
      this.heroData.heroes.map(h => ({ name: h.name, owned: false, stars: 1, widget: 0 }))
    );
    this.gearScanResult.set(defaultGearScanResult());
    this.gearDataReady.set(false);
    this.statsScanResult.set({ stats: zeroAccountStats(), troops: defaultTroopLevels() });
    this.statsDataReady.set(false);
    this.result.set(null);
    this.simResult.set(null);
  }

  openTutorial() {
    this.dialog.open(TutorialDialog, {
      width: '600px',
      maxWidth: '95vw',
      maxHeight: '90vh',
      autoFocus: false,
    });
  }

  // --- Hero scan ---

  onScanFileSelected(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;
    this.scanFile.set(file);
    this.scanStatus.set('idle');
    this.scanMessage.set('');
  }

  async scanHeroes() {
    const file = this.scanFile();
    if (!file) return;

    this.scanStatus.set('scanning');
    this.scanMessage.set('');
    try {
      const starMap = await this.heroScanService.scan(file);
      let owned = 0;
      this.heroInputs.update(inputs =>
        inputs.map(h => {
          const stars = starMap.get(h.name);
          if (stars !== undefined && stars > 0) {
            owned++;
            return { ...h, owned: true, stars };
          }
          return h;
        })
      );
      this.scanStatus.set('done');
      this.scanMessage.set(`Stars detected for ${owned} heroes. Set widget levels below.`);
    } catch (e) {
      this.scanStatus.set('error');
      this.scanMessage.set((e as Error).message);
    }
  }
}
