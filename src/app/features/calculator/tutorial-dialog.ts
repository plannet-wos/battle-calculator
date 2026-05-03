import { Component, signal } from '@angular/core';
import { MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

interface TutorialStep {
  title: string;
  icon: string;
  description: string;
  tips: string[];
  image?: string;
}

const STEPS: TutorialStep[] = [
  {
    title: 'Scan Your Gear',
    icon: 'backpack',
    description: 'Open your in-game Backpack, go to the Gear tab. take a full-screen screenshot and upload it here.',
    tips: [
      'Make sure all 12 pieces of gear are loaded correctly',
      'You can manually edit any piece after scanning if the OCR misreads',
    ],
    image: 'test-fullbox1.jpg',
  },
  {
    title: 'Scan Your Battle Stats',
    icon: 'bar_chart',
    description: 'Attack any target with NO HEROES. Open the report and screenshot the bottom where your stat bonuses are.',
    tips: [
      'The report must be with NO HEROES and include all 3 troop types',
      'Attack, Defense, Lethality, and Health bonuses are detected automatically',
      'You can manually adjust any value after scanning',
    ],
    image: 'test-battlereport1.jpg',
  },
  {
    title: 'Scan Your Heroes',
    icon: 'groups',
    description: 'Go to "Heroes" in-game. Make sure heroes are sorted by "quality". Screenshot and upload it.',
    tips: [
      'Make sure you sort by "quality" so all SSR heroes are shown in the screenshot',
      'Only star levels are scanned — you will set widget levels manually',
      'You can also skip scanning and set hero stars manually with the sliders',
    ],
    image: 'test-heroes2.png',
  },
  {
    title: 'Configure Heroes Manually',
    icon: 'tune',
    description: 'Check the box next to each hero you own. Use the sliders to correct their Star level (1–5) and set their Widget level (0–10).',
    tips: [
      'Widget level has a significant impact on hero strength',
      'Heroes are grouped by generation for easier navigation',
    ],
  },
  {
    title: 'Calculate Best Lineup',
    icon: 'emoji_events',
    description: 'Press "Calculate Best Lineup" to find your optimal 3-hero squad. The calculator evaluates all possible combinations of your owned heroes and selects the lineup with the highest total power.',
    tips: [
      'The recommended troop ratio (e.g. 6/2/2) is shown with your results',
      'You can edit the ratio to test different troop distributions',
      'Battle stats show your effective ATK, DEF, Lethality, and HP per troop type',
    ],
  },
  {
    title: 'Run Simulation',
    icon: 'science',
    description: 'After calculating your lineup, press "Run Simulation" to battle-test it against preset opponents (Low, Medium, Strong) and a mirror match (Yourself). Each matchup runs 20 fights.',
    tips: [
      'You can customize opponent ratios (default: 6/4/0 and 5/2/3)',
      'Green = you win the majority, Red = you lose the majority',
      'Average survivors show how decisive each victory or defeat is',
    ],
  },
];

@Component({
  selector: 'app-tutorial-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <div class="tutorial-dialog">
      <div class="tutorial-header">
        <h2>How to Use the Battle Calculator</h2>
        <button mat-icon-button mat-dialog-close class="close-btn">
          <mat-icon>close</mat-icon>
        </button>
      </div>

      <div class="tutorial-body">
        <div class="step-nav">
          @for (step of steps; track step.title; let i = $index) {
            <button class="step-dot"
                    [class.active]="currentStep() === i"
                    [class.visited]="i < currentStep()"
                    (click)="currentStep.set(i)">
              <span class="dot-number">{{ i + 1 }}</span>
            </button>
            @if (i < steps.length - 1) {
              <div class="dot-line" [class.filled]="i < currentStep()"></div>
            }
          }
        </div>

        <div class="step-content">
          <div class="step-icon-wrap">
            <mat-icon class="step-icon">{{ steps[currentStep()].icon }}</mat-icon>
          </div>
          <h3>Step {{ currentStep() + 1 }}: {{ steps[currentStep()].title }}</h3>
          <p class="step-desc">{{ steps[currentStep()].description }}</p>

          @if (steps[currentStep()].image) {
            <div class="step-image-wrap">
              <img [src]="steps[currentStep()].image"
                   [alt]="steps[currentStep()].title"
                   class="step-image" />
              <span class="image-caption">Example screenshot</span>
            </div>
          }

          <div class="step-tips">
            <div class="tip-label">
              <mat-icon>lightbulb</mat-icon> Tips
            </div>
            @for (tip of steps[currentStep()].tips; track tip) {
              <div class="tip-item">
                <mat-icon>check_circle</mat-icon>
                <span>{{ tip }}</span>
              </div>
            }
          </div>
        </div>
      </div>

      <div class="tutorial-footer">
        <button mat-button
                [disabled]="currentStep() === 0"
                (click)="currentStep.set(currentStep() - 1)">
          <mat-icon>chevron_left</mat-icon> Previous
        </button>
        <span class="step-counter">{{ currentStep() + 1 }} / {{ steps.length }}</span>
        @if (currentStep() < steps.length - 1) {
          <button mat-flat-button color="primary"
                  (click)="currentStep.set(currentStep() + 1)">
            Next <mat-icon>chevron_right</mat-icon>
          </button>
        } @else {
          <button mat-flat-button color="primary" mat-dialog-close>
            Got it! <mat-icon>check</mat-icon>
          </button>
        }
      </div>
    </div>
  `,
  styles: [`
    .tutorial-dialog {
      display: flex;
      flex-direction: column;
      max-height: 80vh;
    }

    .tutorial-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px 8px;

      h2 {
        margin: 0;
        font-size: 20px;
        font-weight: 500;
      }
    }

    .close-btn {
      margin: -8px -8px 0 0;
    }

    .tutorial-body {
      padding: 8px 24px 16px;
      overflow-y: auto;
      flex: 1;
    }

    .step-nav {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0;
      margin-bottom: 24px;
    }

    .step-dot {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 2px solid #ccc;
      background: transparent;
      color: #888;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 600;
      transition: all 0.2s;

      &.active {
        border-color: #00bcd4;
        background: #00bcd4;
        color: #fff;
      }

      &.visited {
        border-color: #00bcd4;
        color: #00bcd4;
      }
    }

    .dot-number {
      line-height: 1;
    }

    .dot-line {
      width: 24px;
      height: 2px;
      background: #ccc;
      transition: background 0.2s;

      &.filled {
        background: #00bcd4;
      }
    }

    .step-content {
      text-align: center;
    }

    .step-icon-wrap {
      display: flex;
      justify-content: center;
      margin-bottom: 12px;
    }

    .step-icon {
      font-size: 48px;
      width: 48px;
      height: 48px;
      color: #00bcd4;
    }

    h3 {
      margin: 0 0 8px;
      font-size: 18px;
      font-weight: 500;
    }

    .step-desc {
      margin: 0 0 20px;
      font-size: 14px;
      line-height: 1.6;
      color: #333;
      max-width: 480px;
      margin-left: auto;
      margin-right: auto;
    }

    .step-image-wrap {
      margin: 0 auto 16px;
      max-width: 280px;
      text-align: center;
    }

    .step-image {
      width: 100%;
      max-height: 300px;
      object-fit: contain;
      border-radius: 8px;
      border: 1px solid rgba(0,0,0,0.12);
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }

    .image-caption {
      display: block;
      font-size: 11px;
      color: #999;
      margin-top: 4px;
    }

    .step-tips {
      background: rgba(0,0,0,0.04);
      border-radius: 8px;
      padding: 12px 16px;
      text-align: left;
      max-width: 480px;
      margin: 0 auto;
    }

    .tip-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 500;
      color: #ffc107;
      margin-bottom: 8px;

      mat-icon {
        font-size: 18px;
        width: 18px;
        height: 18px;
      }
    }

    .tip-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-size: 13px;
      color: #444;
      line-height: 1.5;
      margin-bottom: 6px;

      mat-icon {
        font-size: 16px;
        width: 16px;
        height: 16px;
        color: #4caf50;
        flex-shrink: 0;
        margin-top: 2px;
      }

      &:last-child {
        margin-bottom: 0;
      }
    }

    .tutorial-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 24px 16px;
      border-top: 1px solid rgba(0,0,0,0.08);
    }

    .step-counter {
      font-size: 13px;
      color: #888;
    }
  `]
})
export class TutorialDialog {
  readonly steps = STEPS;
  readonly currentStep = signal(0);
}
