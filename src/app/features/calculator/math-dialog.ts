import { Component } from '@angular/core';
import { MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

/**
 * Static information dialog that explains how the recommender picks a squad
 * + ratio for each scenario. Opened from the `?` button on the
 * "Battle Stats & Simulation" card.
 *
 * Kept as a single-file component so it can be edited as one piece — content
 * is the value here, not Angular plumbing.
 */
@Component({
  selector: 'app-math-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <div class="math-dialog">
      <div class="math-header">
        <h2>How the recommender works</h2>
        <button mat-icon-button mat-dialog-close class="close-btn">
          <mat-icon>close</mat-icon>
        </button>
      </div>

      <div class="math-body">

        <section>
          <h3><mat-icon>flag</mat-icon> The 8 reference targets</h3>
          <p>
            Every recommendation is judged against the same fixed set of 8
            top defensive lineups. Those 8 were extracted offline from a
            4-stage discovery tournament that searched all valid 1-Inf +
            1-Lanc + 1-Mark squads × a wide pool of troop ratios, then kept
            the squad/ratio combos that won the most fights against the
            broader meta. They live in
            <code>src/app/core/sim/data/discovered-targets.json</code>.
          </p>
        </section>

        <section>
          <h3><mat-icon>tune</mat-icon> Stat handling</h3>
          <p>
            <strong>You</strong> always use your <em>exact</em> scanned/edited stats
            (asymmetric across Infantry / Lancer / Marksman). The recommender's
            job is to find the best squad <em>for that specific stat profile</em>.
          </p>
          <p>
            <strong>The 8 enemy targets</strong> use a <em>flat</em> baseline:
            we average all 12 of your stat slots into a single scalar, then
            scale it by the scenario's enemy multiplier and apply it
            uniformly to every enemy troop slot. This keeps comparisons fair
            (no enemy gets a free advantage from your stat shape) but lets
            each scenario be themed (stronger / weaker / city).
          </p>
        </section>

        <section>
          <h3><mat-icon>insights</mat-icon> The 6 scenarios</h3>
          <table class="scenarios-table">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Your troops</th>
                <th>Enemy troops</th>
                <th>Enemy stat scale</th>
                <th>Enemy ratio</th>
                <th>Optimised for</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>general</td>             <td>100k</td><td>100k</td><td>×1.00</td><td>target's own</td><td>your troop survival</td></tr>
              <tr><td>against city (-15%)</td> <td>200k</td><td>3 M</td> <td>×0.85</td><td>5/2/3 fixed</td><td>enemy troops killed</td></tr>
              <tr><td>against city (-25%)</td> <td>200k</td><td>3 M</td> <td>×0.75</td><td>5/2/3 fixed</td><td>enemy troops killed</td></tr>
              <tr><td>against city (-50%)</td> <td>200k</td><td>3 M</td> <td>×0.50</td><td>5/2/3 fixed</td><td>enemy troops killed</td></tr>
              <tr><td>against stronger</td>    <td>160k</td><td>180k</td><td>×1.15</td><td>target's own</td><td>your troop survival</td></tr>
              <tr><td>against weaker</td>      <td>160k</td><td>140k</td><td>×0.85</td><td>target's own</td><td>your troop survival</td></tr>
            </tbody>
          </table>
          <p class="caption">
            The 3 city variants cover the realistic range of enemy stat
            disadvantage when you attack a city — pick the one that matches
            your gap to the defender. The kill-count metric is shown in the
            cards as an absolute number of troops killed (out of 3 M)
            because outright survival vs a 15× larger force is ~0%, so what
            matters is how much damage you trade for your loss.
          </p>
        </section>

        <section>
          <h3><mat-icon>format_list_numbered</mat-icon> Two-stage tournament (per scenario)</h3>

          <h4>Stage A — squad qualifier</h4>
          <ol>
            <li>Build every valid 1+1+1 squad from your owned heroes
                (every Infantry × every Lancer × every Marksman).</li>
            <li>Each squad plays a fixed baseline ratio of <code>5/2/3</code>
                versus each of the 8 targets, <strong>10 simulations</strong>
                per matchup.</li>
            <li>Score = average scenario metric across the
                8&nbsp;×&nbsp;10&nbsp;=&nbsp;80 fights.</li>
            <li>Top <strong>3</strong> squads advance to Stage B.</li>
          </ol>

          <h4>Stage B — ratio gauntlet</h4>
          <ol>
            <li>Build a candidate ratio pool: 17 hand-picked balanced and
                stacked profiles
                (<code>5/2/3, 5/3/2, 5/4/1, 5/1/4, 6/3/1, 6/1/3, 4/3/3,
                4/4/2, 7/2/1, 7/1/2, 70/10/20, 70/20/10, 60/10/30,
                60/30/10, 50/30/20, 50/20/30, 80/10/10</code>) plus the
                8 targets' own ratios (deduplicated).</li>
            <li>Each finalist squad × every candidate ratio plays each of
                the 8 targets, <strong>20 simulations</strong> per matchup.</li>
            <li>Score = average scenario metric across all 8&nbsp;targets.</li>
            <li>The best (squad, ratio) wins that scenario.</li>
          </ol>

          <p class="caption">
            For one scenario with all 16 heroes owned that's
            6 × 5 × 5 = <strong>150 squads</strong> × 80 Stage-A runs each
            +&nbsp;3 finalists × ~22 ratios × 8 targets × 20 runs each
            ≈ <strong>22 600 battle simulations</strong>. Times 6 scenarios for
            a full Calculate.
          </p>
        </section>

        <section>
          <h3><mat-icon>flash_on</mat-icon> Fast vs Thorough mode</h3>
          <p>
            <strong>Fast Calculate</strong> trades sample size for runtime —
            roughly <strong>5× faster</strong> for an estimated
            <strong>~80%</strong> of thorough-mode quality.
          </p>
          <table class="scenarios-table">
            <thead>
              <tr><th>Knob</th><th>Thorough</th><th>Fast</th><th>Why it's safe to cut</th></tr>
            </thead>
            <tbody>
              <tr><td>Reference targets</td><td>8</td><td>4</td><td>Targets are pre-ranked by win rate; top 4 cover the strongest meta lineups.</td></tr>
              <tr><td>Stage-A runs / matchup</td><td>10</td><td>4</td><td>Squad ranking only needs to be roughly right; the gauntlet refines from there.</td></tr>
              <tr><td>Finalists kept</td><td>3</td><td>5</td><td>Wider Stage-A funnel guards against ranking noise from fewer runs.</td></tr>
              <tr><td>Stage-B runs / matchup</td><td>20</td><td>8</td><td>5 squads × 8 ratios × 4 targets × 8 runs ≈ 256 sample points per ratio still ranks reliably.</td></tr>
              <tr><td>Ratio pool size</td><td>~22 (incl. stacked)</td><td>8 + targets'</td><td>Drops the niche 70/X/Y, 60/X/Y, 80/10/10 profiles — they almost never win against the meta.</td></tr>
            </tbody>
          </table>
          <p class="caption">
            Fast mode is ideal for first-pass exploration ("what's roughly
            best for my account?"). When you've narrowed to a candidate
            lineup or want to compare close calls, run a thorough Calculate
            for full statistical weight.
          </p>
        </section>

        <section>
          <h3><mat-icon>functions</mat-icon> Per-fight metric</h3>
          <p>Each individual battle simulation produces one number ∈ [0, 1]:</p>
          <ul>
            <li><strong>attackerSurvival</strong> =
                <code>your troops alive / your total troops</code>
                (general, vs stronger, vs weaker).</li>
            <li><strong>enemyKillRate</strong> =
                <code>(enemy total − enemy alive) / enemy total</code>
                (3 city variants). Cards show this as the absolute number of
                troops killed (e.g. <em>"245,000 troops killed"</em>) since
                that's the actionable number when you're choosing which city
                to march on.</li>
          </ul>
          <p>
            All scoring elsewhere — Stage&nbsp;A ranking, Stage&nbsp;B winner,
            the per-target numbers on each card — is the average of this
            single number across the simulation runs that contributed.
          </p>
          <p>
            The per-card details dialog shows
            <strong>your survivors vs enemy survivors</strong> per target as
            absolute counts — averages across the simulation runs that
            produced this card. The sim's underlying model is binary
            (alive/downed) and doesn't distinguish lightly-injured from
            severely-injured from dead, so survivors is the only number
            that's unambiguous — same definition the upstream WoS sim uses
            in its "Survived" column.
          </p>
        </section>

      </div>

      <div class="math-footer">
        <button mat-flat-button color="primary" mat-dialog-close>
          Got it <mat-icon>check</mat-icon>
        </button>
      </div>
    </div>
  `,
  styles: [`
    .math-dialog {
      display: flex;
      flex-direction: column;
      max-height: 85vh;
      width: min(680px, 92vw);
    }

    .math-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px 8px;
      border-bottom: 1px solid rgba(0,0,0,0.08);

      h2 {
        margin: 0;
        font-size: 20px;
        font-weight: 500;
      }
    }

    .close-btn {
      margin: -8px -8px 0 0;
    }

    .math-body {
      padding: 4px 24px 16px;
      overflow-y: auto;
      flex: 1;
    }

    section {
      margin-top: 18px;

      h3 {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 8px;
        font-size: 16px;
        font-weight: 600;
        color: var(--mat-sys-primary, #00bcd4);

        mat-icon {
          font-size: 20px;
          width: 20px;
          height: 20px;
        }
      }

      h4 {
        margin: 12px 0 4px;
        font-size: 14px;
        font-weight: 600;
      }

      p, li {
        font-size: 13.5px;
        line-height: 1.55;
        color: #333;
        margin: 6px 0;
      }

      ol, ul {
        margin: 4px 0;
        padding-left: 22px;
      }

      code {
        background: rgba(0,0,0,0.05);
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 12.5px;
      }
    }

    .caption {
      font-size: 12.5px !important;
      color: #666 !important;
      font-style: italic;
    }

    .scenarios-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 4px;
      font-size: 12.5px;

      th, td {
        padding: 6px 10px;
        text-align: left;
        border-bottom: 1px solid rgba(0,0,0,0.08);
      }

      thead th {
        background: rgba(0,0,0,0.04);
        font-weight: 600;
      }

      tbody tr:hover {
        background: rgba(0,188,212,0.06);
      }
    }

    .math-footer {
      display: flex;
      justify-content: flex-end;
      padding: 12px 24px 16px;
      border-top: 1px solid rgba(0,0,0,0.08);
    }
  `]
})
export class MathDialog {}
