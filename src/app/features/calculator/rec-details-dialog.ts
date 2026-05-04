import { Component, Inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

import { MergedRecommendation } from '../../core/sim/simulator.service';

/**
 * Per-card "how was this deduced" dialog. Reads the `MergedRecommendation`
 * passed via `MAT_DIALOG_DATA` and shows the scenario parameters, the
 * Stage-A qualifier ranking (top 10 squads), and the Stage-B winning combo's
 * per-target outcomes.
 */
@Component({
  selector: 'app-rec-details-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatIconModule, DecimalPipe],
  template: `
    <div class="rec-details">
      <div class="header">
        <h2>How "{{ title() }}" was picked</h2>
        <button mat-icon-button mat-dialog-close class="close-btn">
          <mat-icon>close</mat-icon>
        </button>
      </div>

      <div class="body">

        <section>
          <h3><mat-icon>tune</mat-icon> Scenario parameters</h3>
          <table class="kv">
            <tr>
              <td>Player troops</td>
              <td>{{ scenario.playerTotal | number }}</td>
            </tr>
            <tr>
              <td>Enemy troops</td>
              <td>{{ scenario.enemyTotal | number }}</td>
            </tr>
            <tr>
              <td>Enemy stat scale</td>
              <td>×{{ scenario.enemyStatScale | number:'1.2-2' }}
                  <span class="muted">(applied to your averaged baseline)</span></td>
            </tr>
            <tr>
              <td>Enemy ratio</td>
              <td>
                @if (scenario.enemyRatio) {
                  {{ scenario.enemyRatio }} <span class="muted">(fixed)</span>
                } @else {
                  each target's own ratio
                }
              </td>
            </tr>
            <tr>
              <td>Optimised metric</td>
              <td>
                @if (scenario.metric === 'attackerSurvival') {
                  Your troop survival rate
                } @else {
                  Enemy troops killed
                }
              </td>
            </tr>
          </table>
        </section>

        <section>
          <h3><mat-icon>emoji_events</mat-icon> Winning lineup</h3>
          <p class="winner">
            <strong>{{ squadStr }}</strong> at ratio <strong>{{ rec.ratio }}</strong>
            <span class="muted"> — overall {{ formatMetric(perScenario.metricValue) }}</span>
          </p>
          <p class="caption">
            Picked from the Stage-A top {{ qualifierKept }} after a Stage-B
            ratio gauntlet over the 8 reference targets, 20 fights per
            (ratio, target).
          </p>
        </section>

        <section>
          @if (scenario.metric === 'enemyKillRate') {
            <h3><mat-icon>flag</mat-icon> Per-target enemy injuries (winning combo)</h3>
            <p class="caption">
              Average enemy troops downed per battle. We don't show your own
              survivors here because in a city raid (200k vs 3M) you almost
              always get fully wiped — the actionable number is how many of
              theirs you took with you.
            </p>
            <table class="results">
              <thead>
                <tr>
                  <th>Target</th>
                  <th class="r enemy">Enemy injuries</th>
                </tr>
              </thead>
              <tbody>
                @for (t of perScenario.vsTargets; track t.target) {
                  <tr>
                    <td>{{ t.target }}</td>
                    <td class="r enemy">
                      @if (enemyInjuries(t) != null) {
                        {{ enemyInjuries(t) | number:'1.0-0' }}
                      } @else { — }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <h3><mat-icon>flag</mat-icon> Per-target survivor rates (winning combo)</h3>
            <p class="caption">
              Percentage of each side's army still on the field at the end
              of the battle, averaged across runs. The sim doesn't
              distinguish lightly-injured from severely-injured from dead —
              every removed troop is bundled into "downed".
            </p>
            <table class="results">
              <thead>
                <tr>
                  <th>Target</th>
                  <th class="r your">Your survivors</th>
                  <th class="r enemy">Enemy survivors</th>
                </tr>
              </thead>
              <tbody>
                @for (t of perScenario.vsTargets; track t.target) {
                  <tr>
                    <td>{{ t.target }}</td>
                    <td class="r your">
                      @if (t.playerSurvivors != null) {
                        {{ pct(t.playerSurvivors, scenario.playerTotal) }}%
                      } @else { — }
                    </td>
                    <td class="r enemy">
                      @if (t.enemySurvivors != null) {
                        {{ pct(t.enemySurvivors, scenario.enemyTotal) }}%
                      } @else { — }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>

        <section>
          <h3><mat-icon>format_list_numbered</mat-icon> Stage-A squad qualifier (top {{ perScenario.qualifier.length }})</h3>
          <p class="caption">
            Each squad played a 5/2/3 baseline ratio vs every target, 10 runs
            per matchup. Score = average scenario metric. Top 3 advanced to
            Stage&nbsp;B.
          </p>
          <table class="results">
            <thead>
              <tr><th>#</th><th>Squad</th><th class="r">Score</th></tr>
            </thead>
            <tbody>
              @for (q of perScenario.qualifier; track q.squad; let i = $index) {
                <tr [class.winner-row]="q.squad === squadJoined">
                  <td>{{ i + 1 }}</td>
                  <td>
                    {{ q.squad }}
                    @if (q.squad === squadJoined) { <mat-icon class="winner-tick">check</mat-icon> }
                  </td>
                  <td class="r">{{ formatMetric(q.metricValue) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>

      </div>

      <div class="footer">
        <button mat-flat-button color="primary" mat-dialog-close>
          Got it <mat-icon>check</mat-icon>
        </button>
      </div>
    </div>
  `,
  styles: [`
    .rec-details {
      display: flex;
      flex-direction: column;
      max-height: 85vh;
      width: min(640px, 92vw);
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px 8px;
      border-bottom: 1px solid rgba(0,0,0,0.08);

      h2 { margin: 0; font-size: 18px; font-weight: 500; }
    }

    .close-btn { margin: -8px -8px 0 0; }

    .body { padding: 8px 24px 16px; overflow-y: auto; flex: 1; }

    section {
      margin-top: 16px;

      h3 {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 6px;
        font-size: 14.5px;
        font-weight: 600;
        color: var(--mat-sys-primary, #00bcd4);

        mat-icon { font-size: 18px; width: 18px; height: 18px; }
      }
    }

    .kv {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;

      td { padding: 4px 8px; border-bottom: 1px solid rgba(0,0,0,0.05); }
      td:first-child { color: #666; width: 38%; }
    }

    .winner {
      margin: 4px 0 6px;
      font-size: 13.5px;
    }

    .caption {
      font-size: 12px;
      color: #666;
      font-style: italic;
      margin: 4px 0 8px;
    }

    .muted { color: #777; font-weight: normal; }

    .results {
      width: 100%;
      border-collapse: collapse;
      font-size: 12.5px;

      th, td { padding: 5px 8px; border-bottom: 1px solid rgba(0,0,0,0.05); }
      th { background: rgba(0,0,0,0.04); font-weight: 600; text-align: left; }
      td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; }

      th.your, td.your   { color: #2e7d32; }   // your survivors — green-tinted (more = better)
      th.enemy, td.enemy { color: #c62828; }   // enemy survivors — red-tinted (more = worse)

      tr.winner-row td {
        background: rgba(0,188,212,0.08);
        font-weight: 600;
      }
    }

    .winner-tick {
      color: var(--mat-sys-primary, #00bcd4);
      font-size: 14px;
      width: 14px;
      height: 14px;
      vertical-align: middle;
      margin-left: 4px;
    }

    .footer {
      display: flex;
      justify-content: flex-end;
      padding: 12px 24px 16px;
      border-top: 1px solid rgba(0,0,0,0.08);
    }
  `]
})
export class RecDetailsDialog {
  readonly rec: MergedRecommendation;

  // Cards always have one scenario each (recommendAll no longer merges), so
  // we read [0] directly. Kept tolerant in case merging is ever re-enabled.
  get scenario() { return this.rec.scenarios[0]; }
  get perScenario() { return this.rec.perScenario[0]; }

  /** Human-readable hero squad as the rendering shows it on the card. */
  get squadStr() { return this.rec.squad.map(h => h.name).join(' + '); }

  /** Same squad but joined with `+` (no spaces) so we can match against the
   *  qualifier rows, which are stored as `"A+B+C"`. */
  get squadJoined() { return this.rec.squad.map(h => h.name).join('+'); }

  /** How many qualifier rows we kept (informational text in the section header). */
  readonly qualifierKept: number;

  constructor(@Inject(MAT_DIALOG_DATA) data: { rec: MergedRecommendation }) {
    this.rec = data.rec;
    this.qualifierKept = this.perScenario?.qualifier?.length ?? 0;
  }

  title(): string {
    return `Best ${this.scenario.label}`;
  }

  formatMetric(metricValue: number): string {
    const sc = this.scenario;
    if (sc.metric === 'enemyKillRate') {
      const killed = Math.round(metricValue * sc.enemyTotal);
      return `${killed.toLocaleString()} troops killed`;
    }
    return `${(metricValue * 100).toFixed(1)}% troops survive`;
  }

  /** Survivors → "%" string with 1 decimal, used in fair-fight scenarios. */
  pct(survivors: number | undefined, total: number): string {
    if (survivors == null || total <= 0) return '—';
    return ((survivors / total) * 100).toFixed(1);
  }

  /** Enemy injuries (= total - survivors) for a target, or null if unknown.
   *  Used in city-attack scenarios. */
  enemyInjuries(t: { enemySurvivors?: number }): number | null {
    if (t.enemySurvivors == null) return null;
    return Math.max(0, this.scenario.enemyTotal - t.enemySurvivors);
  }
}
