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
import { NgClass, NgTemplateOutlet, DecimalPipe } from '@angular/common';

import { HeroDataService } from '../../core/services/hero-data.service';
import { CalculatorService } from '../../core/services/calculator.service';
import { SimulatorService, SimComparison, MergedRecommendation, Scenario, ScenarioId, VsTargetsRecommendation, SCENARIOS, addAccountStats, gearItemsToStatBonus, zeroAccountStats, baseHeroToStatsBonus } from '../../core/sim/simulator.service';
import { HeroScanService } from '../../core/services/hero-scan.service';
import { GearScanService } from '../../core/services/gear-scan.service';
import { StatsScanService } from '../../core/services/stats-scan.service';
import { SaveCodeService } from '../../core/services/save-code.service';
import { HeroInput, LineupResult, GearScanResult, AccountStats, DetectedGearItem, UnitStatBonus, BattleReportScan, TroopLevels, HeroStatsByGen, defaultTroopLevels, defaultGearScanResult, normalizeGearScanResult } from '../../core/models/hero.model';
import { TutorialDialog } from './tutorial-dialog';
import { MathDialog } from './math-dialog';
import { RecDetailsDialog } from './rec-details-dialog';

type GearTroopKey = 'infantry' | 'lancer' | 'marksman';
type GearColor = DetectedGearItem['color'];

@Component({
  selector: 'app-calculator',
  standalone: true,
  imports: [
    FormsModule, NgClass, NgTemplateOutlet, DecimalPipe,
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
  private saveCodeService = inject(SaveCodeService);
  private dialog = inject(MatDialog);

  readonly heroInputs = signal<HeroInput[]>(
    this.heroData.heroes.map(h => ({ name: h.name, owned: false, stars: 1, widget: 0 })),
  );

  readonly result = signal<LineupResult | null>(null);
  readonly recommendations = signal<MergedRecommendation[] | null>(null);
  /** Scenario id of the card whose squad+ratio drives the Battle Stats /
   *  Run Simulation panel. Defaults to 'general' on every fresh calc/load;
   *  user clicks any card to switch. Stored as id (rather than index) so the
   *  two-column layout can render in any order without breaking selection. */
  readonly selectedScenarioId = signal<ScenarioId>('general');
  readonly simResult = signal<SimComparison | null>(null);
  readonly simRunning = signal(false);
  readonly calculating = signal(false);
  /** True while a fast-mode calculation is the one currently spinning. Used
   *  by the spinner copy and by the post-calc result banner. */
  readonly calculatingFast = signal(false);

  // Save-code feature: after calculate() succeeds we persist the user's full
  // input set (heroes + gear + stats) to Firestore under a 4-char code so they
  // can re-load on any device by typing the code.
  readonly saveCode = signal<string | null>(null);
  readonly saveCodeError = signal<string | null>(null);
  readonly loadCodeInput = signal<string>('');
  readonly loadingCode = signal(false);
  readonly loadCodeMessage = signal<string | null>(null);

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
    this.onInputsChanged();
  }

  updateStars(name: string, stars: number) {
    this.heroInputs.update(list =>
      list.map(h => h.name === name ? { ...h, stars } : h)
    );
    this.onInputsChanged();
  }

  updateWidget(name: string, widget: number) {
    this.heroInputs.update(list =>
      list.map(h => h.name === name ? { ...h, widget } : h)
    );
    this.onInputsChanged();
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
      this.onInputsChanged();
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
      this.onInputsChanged();
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
    this.onInputsChanged();
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
    this.onInputsChanged();
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

  calculate(options: { fast?: boolean } = {}) {
    const fast = !!options.fast;
    const fallback = this.calcService.calculate(this.heroInputs());
    if (!fallback) {
      this.result.set(null);
      this.recommendations.set(null);
      this.simResult.set(null);
      return;
    }

    const scanned    = this.statsScanResult();
    const gearResult = this.gearScanResult();
    const statsReady = this.statsDataReady() && this.gearDataReady();

    if (!statsReady) {
      fallback.ratio = '—';
      fallback.strategy = 'Scan or enter gear + battle report stats to get a recommended ratio';
      this.playerRatio.set(fallback.ratio);
      this.result.set(fallback);
      this.recommendations.set(null);
      this.simResult.set(null);
      return;
    }

    const attBaseStats = addAccountStats(scanned.stats, gearItemsToStatBonus(gearResult));
    const owned = this.heroData.heroes
      .map(base => {
        const inp = this.heroInputs().find(i => i.name === base.name);
        if (!inp || !inp.owned) return null;
        return { ...base, stars: inp.stars, widget: inp.widget, score: 0 };
      })
      .filter((h): h is NonNullable<typeof h> => h !== null);

    // Bail upfront if any troop type is missing — saves spawning workers for
    // an unsolvable problem.
    const hasAllTypes =
      owned.some(h => h.type === 'Infantry') &&
      owned.some(h => h.type === 'Lancer') &&
      owned.some(h => h.type === 'Marksman');
    if (!hasAllTypes) {
      fallback.notes.push('⚠ Need at least one Infantry, Lancer, and Marksman to run vs-meta recommender.');
      fallback.ratio = '—';
      fallback.strategy = 'Scan or enter gear + battle report stats to get a recommended ratio';
      this.playerRatio.set(fallback.ratio);
      this.result.set(fallback);
      this.recommendations.set(null);
      this.simResult.set(null);
      return;
    }

    // Build placeholder cards, one per scenario. If we already have results
    // from a previous calc (e.g. user did Fast and is now redoing Thorough),
    // keep the old data visible under a loading overlay so the UI doesn't
    // blank out. Otherwise empty placeholders get rendered.
    const ALL_IDS: ScenarioId[] = ['general', 'vsCity15', 'vsCity25', 'vsCity50', 'vsStrong', 'vsWeak'];
    const existing = this.recommendations();
    const placeholders: MergedRecommendation[] = ALL_IDS.map((id, i) => {
      const carry = existing?.[i];
      if (carry && carry.scenarios[0]?.id === id) {
        return { ...carry, loading: true };
      }
      return {
        scenarios: [SCENARIOS[id]],
        squad: [],
        ratio: '',
        perScenario: [],
        loading: true,
      };
    });

    this.calculating.set(true);
    this.calculatingFast.set(fast);
    this.saveCode.set(null);
    this.saveCodeError.set(null);
    this.recommendations.set(placeholders);
    this.simResult.set(null);
    // Make sure the selection still resolves to one of the placeholder cards.
    const selId = this.selectedScenarioId();
    const selectedCard = placeholders.find(r => r.scenarios[0]?.id === selId);
    if (!selectedCard) this.selectedScenarioId.set(ALL_IDS[0]);
    // If the currently selected card had stale data, keep result populated;
    // otherwise blank it until the selected scenario lands.
    if (selectedCard && selectedCard.squad.length) {
      this.result.set(this.buildPrimaryResult(selectedCard));
      this.playerRatio.set(selectedCard.ratio);
    } else {
      this.result.set(null);
    }

    // Spawn the worker pool — UI thread stays free while sims run.
    this.runScenariosViaWorkers(owned, attBaseStats, scanned.troops, fast, ALL_IDS,
      (card, id) => {
        // Replace placeholder for this scenario with the fresh card.
        this.recommendations.update(arr => arr?.map(r =>
          r.scenarios[0]?.id === id ? card : r,
        ) ?? null);
        // If the user is currently viewing this card, refresh the sim panel.
        if (this.selectedScenarioId() === id) {
          this.result.set(this.buildPrimaryResult(card));
          this.playerRatio.set(card.ratio);
          this.simResult.set(null);
        }
      })
      .then(() => {
        // Persist final, fully-loaded snapshot.
        const finalRecs = (this.recommendations() ?? []).filter(r => !r.loading);
        if (finalRecs.length) this.persistCurrentInputs(finalRecs);
      })
      .finally(() => {
        this.calculating.set(false);
        this.calculatingFast.set(false);
      });
  }

  /**
   * Spawns a small worker pool (one per CPU core, capped at the scenario
   * count) and feeds them scenario IDs off a shared queue. As each scenario
   * finishes the worker posts back a `VsTargetsRecommendation` which we
   * promote to a `MergedRecommendation` card and pass to `onCard`.
   *
   * Why a pool: each scenario is embarrassingly parallel — they don't share
   * state — so we get near-linear speedup with core count. UI thread stays
   * free regardless of pool size because all heavy sim work happens off-main.
   */
  private async runScenariosViaWorkers(
    ownedHeroes: ReadonlyArray<{ name: string; gen: number; type: 'Infantry' | 'Lancer' | 'Marksman'; stars: number; widget: number; score: number }>,
    attBaseStats: AccountStats,
    attLevels: TroopLevels,
    fast: boolean,
    scenarioIds: ScenarioId[],
    onCard: (card: MergedRecommendation, id: ScenarioId) => void,
  ): Promise<void> {
    const concurrency = Math.min(
      scenarioIds.length,
      Math.max(1, navigator.hardwareConcurrency || 4),
    );
    const queue = [...scenarioIds];
    let nextJobId = 1;

    const runOne = (worker: Worker, id: ScenarioId) =>
      new Promise<void>((resolve) => {
        const jobId = nextJobId++;
        const handler = (event: MessageEvent<{ jobId: number; rec: VsTargetsRecommendation | null; error?: string }>) => {
          if (event.data.jobId !== jobId) return;   // ignore other in-flight jobs
          worker.removeEventListener('message', handler);
          if (event.data.error) {
            console.warn(`Sim worker failed for ${id}:`, event.data.error);
          }
          if (event.data.rec) {
            onCard(this.buildMergedCard(id, event.data.rec), id);
          }
          resolve();
        };
        worker.addEventListener('message', handler);
        worker.postMessage({
          jobId, scenarioId: id, ownedHeroes, attBaseStats, attLevels, fast,
        });
      });

    const workerLoop = async (worker: Worker) => {
      while (queue.length) {
        const id = queue.shift()!;
        await runOne(worker, id);
      }
    };

    const workers: Worker[] = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(new Worker(new URL('../../core/sim/sim.worker', import.meta.url), { type: 'module' }));
    }
    try {
      await Promise.all(workers.map(w => workerLoop(w)));
    } finally {
      for (const w of workers) w.terminate();
    }
  }

  /** Promote a raw `VsTargetsRecommendation` from a worker to a single-card
   *  `MergedRecommendation` ready for the UI: re-scores the squad and trims
   *  the qualifier ranking. */
  private buildMergedCard(id: ScenarioId, rec: VsTargetsRecommendation): MergedRecommendation {
    const scenario = SCENARIOS[id];
    const scoredSquad = rec.squad.map(h => ({
      ...h,
      score: (HeroStatsByGen[h.gen] * h.stars) / 100 + h.widget * 0.6,
    }));
    return {
      scenarios: [scenario],
      squad: scoredSquad,
      ratio: rec.ratio,
      perScenario: [{
        scenarioId: id,
        metricValue: rec.avgMetric,
        vsTargets: rec.vsTargets,
        qualifier: rec.qualifier.slice(0, 10),
      }],
    };
  }

  /** Builds the primary `LineupResult` shown in the simulation panel from a
   *  merged recommendation. Single source of truth so calculate() and
   *  loadByCode() stay in sync. */
  private buildPrimaryResult(rec: MergedRecommendation): LineupResult {
    return {
      squad: rec.squad,
      avgScore: this.recAvgScore(rec),
      ratio: rec.ratio,
      strategy: this.cardTitle(rec),
      notes: [],
    };
  }

  /**
   * Format a scenario's metric for display. The `scenario` argument carries
   * its own `metric` and `enemyTotal`, so old saved codes — which embed the
   * full Scenario object next to each metric value — render correctly even
   * after we change the SCENARIOS table.
   */
  formatScenarioMetric(scenario: Scenario | undefined, metricValue: number): string {
    if (!scenario) return `${(metricValue * 100).toFixed(1)}%`;
    if (scenario.metric === 'enemyKillRate') {
      // Display as absolute troops killed (more meaningful than a small
      // percentage when fighting a 15× larger city).
      const killed = Math.round(metricValue * scenario.enemyTotal);
      return `${killed.toLocaleString()} troops killed`;
    }
    return `${(metricValue * 100).toFixed(1)}% troops survive`;
  }

  /** Combined card title across merged scenarios, e.g. "Best general & best against city". */
  cardTitle(rec: MergedRecommendation): string {
    return rec.scenarios.map(s => `Best ${s.label}`).join(' & ');
  }

  /** Sub-line per scenario for a card, e.g. "general · 47.5% troops survive". */
  scenarioLine(rec: MergedRecommendation, idx: number): string {
    const sc = rec.scenarios[idx];
    const m = rec.perScenario[idx];
    return `${sc.label} · ${this.formatScenarioMetric(sc, m.metricValue)}`;
  }

  /** Average squad score for a recommendation card. */
  recAvgScore(rec: MergedRecommendation): number {
    if (!rec.squad.length) return 0;
    return rec.squad.reduce((s, h) => s + h.score, 0) / rec.squad.length;
  }

  /**
   * Writes a snapshot — heroes + gear + stats + the just-calculated
   * recommendations — to Firestore and stashes the returned code in
   * `saveCode`. Best-effort: failures (e.g. Firestore not configured) only
   * log to `saveCodeError` so the rest of the calculator keeps working.
   */
  private async persistCurrentInputs(recommendations: MergedRecommendation[]): Promise<void> {
    try {
      const { code } = await this.saveCodeService.save({
        heroes: this.heroInputs(),
        gear:   this.gearScanResult(),
        stats:  this.statsScanResult(),
        recommendations,
      });
      this.saveCode.set(code);
    } catch (e) {
      this.saveCodeError.set((e as Error).message ?? 'Failed to save code');
      // Don't surface to console as an unhandled error — Firestore-not-configured
      // is the most common cause and we just want to soft-fail.
      console.warn('Save-code persistence failed:', e);
    }
  }

  /**
   * Loads a saved snapshot from a code: applies inputs (heroes / gear / stats)
   * AND, if the snapshot contains them, the cached recommendations so the
   * cards render immediately without a 2-min recalculation. Any subsequent
   * input edit invalidates the cards via `onInputsChanged()`.
   */
  async loadByCode(): Promise<void> {
    const raw = this.loadCodeInput().trim();
    if (!raw) return;
    this.loadingCode.set(true);
    this.loadCodeMessage.set(null);
    try {
      const payload = await this.saveCodeService.load(raw);
      if (!payload) {
        this.loadCodeMessage.set(`Code "${raw}" not found.`);
        return;
      }
      this.heroInputs.set(payload.heroes);
      this.gearScanResult.set(payload.gear);
      this.gearDataReady.set(true);
      this.statsScanResult.set(payload.stats);
      this.statsDataReady.set(true);

      if (payload.recommendations && payload.recommendations.length) {
        this.recommendations.set(payload.recommendations);
        this.selectRec('general');
        this.simResult.set(null);
        // Surface the same code at the top so the user knows the snapshot
        // they're looking at — clears automatically on the first input edit.
        this.saveCode.set(raw.toUpperCase());
        this.saveCodeError.set(null);
        this.loadCodeMessage.set('Loaded with cached recommendations.');
      } else {
        // Older save with inputs only — wipe stale state and let the user hit
        // Calculate to regenerate.
        this.result.set(null);
        this.recommendations.set(null);
        this.simResult.set(null);
        this.saveCode.set(null);
        this.loadCodeMessage.set('Loaded — hit Calculate Best Lineup to run.');
      }
    } catch (e) {
      this.loadCodeMessage.set((e as Error).message ?? 'Failed to load code');
      console.warn('Load-by-code failed:', e);
    } finally {
      this.loadingCode.set(false);
    }
  }

  /**
   * Centralized "the inputs at the top changed, the cached calc is stale"
   * handler. Called by every input-mutation path (hero checkbox, slider,
   * gear-table edit, stats-table edit, gear/stats scan).
   */
  private onInputsChanged(): void {
    this.result.set(null);
    this.recommendations.set(null);
    this.simResult.set(null);
    this.saveCode.set(null);
    this.saveCodeError.set(null);
  }

  /** Copy the active save code to clipboard. */
  async copySaveCode(): Promise<void> {
    const code = this.saveCode();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch { /* clipboard blocked — user can still read & type the code */ }
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
    this.recommendations.set(null);
    this.simResult.set(null);
    this.saveCode.set(null);
    this.saveCodeError.set(null);
    this.loadCodeInput.set('');
    this.loadCodeMessage.set(null);
  }

  openTutorial() {
    this.dialog.open(TutorialDialog, {
      width: '600px',
      maxWidth: '95vw',
      maxHeight: '90vh',
      autoFocus: false,
    });
  }

  /** Opens the maths explainer dialog from the `?` icon on the sim card. */
  openMathExplanation() {
    this.dialog.open(MathDialog, {
      maxWidth: '95vw',
      maxHeight: '90vh',
      autoFocus: false,
    });
  }

  /**
   * Opens the per-card "how was this deduced" dialog, showing the scenario
   * parameters, the Stage-A qualifier ranking, and the per-target outcomes
   * for that specific recommendation card.
   */
  openRecDetails(rec: MergedRecommendation, event?: Event): void {
    // Stop the click from also firing the parent card's selectRec handler.
    event?.stopPropagation();
    this.dialog.open(RecDetailsDialog, {
      data: { rec },
      maxWidth: '95vw',
      maxHeight: '90vh',
      autoFocus: false,
    });
  }

  /**
   * Pick which of the up-to-6 recommendation cards drives the Battle Stats /
   * Run Simulation panel. Updates `selectedScenarioId`, refreshes the primary
   * `result` (squad/ratio/strategy) so `effectiveStats` and `runSimulation`
   * follow, and seeds the editable `playerRatio` with the picked ratio.
   * Clears any stale simulation results.
   */
  selectRec(scenarioId: ScenarioId): void {
    const recs = this.recommendations();
    if (!recs || !recs.length) return;
    const picked = recs.find(r => r.scenarios[0]?.id === scenarioId);
    if (!picked) return;
    this.selectedScenarioId.set(scenarioId);
    // Empty placeholder (no prior data + still loading): clear the sim panel.
    if (!picked.squad.length || !picked.ratio) {
      this.result.set(null);
      this.playerRatio.set('');
    } else {
      this.result.set(this.buildPrimaryResult(picked));
      this.playerRatio.set(picked.ratio);
    }
    this.simResult.set(null);
  }

  /** Recommendations split by scenario family for the two-column layout.
   *  Left column: balanced fights (general + stronger + weaker).
   *  Right column: city raids (the 3 stat-handicap variants). */
  readonly fairFightRecs = computed(() => {
    const recs = this.recommendations();
    if (!recs) return null;
    return recs.filter(r => {
      const id = r.scenarios[0]?.id;
      return id === 'general' || id === 'vsStrong' || id === 'vsWeak';
    });
  });
  readonly cityAttackRecs = computed(() => {
    const recs = this.recommendations();
    if (!recs) return null;
    return recs.filter(r => {
      const id = r.scenarios[0]?.id;
      return id === 'vsCity15' || id === 'vsCity25' || id === 'vsCity50';
    });
  });

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
      this.onInputsChanged();
    } catch (e) {
      this.scanStatus.set('error');
      this.scanMessage.set((e as Error).message);
    }
  }
}
