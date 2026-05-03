import { Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-switcher',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, MatTooltipModule],
  template: `
    <a mat-mini-fab class="switcher-fab"
       href="https://plannet-wos.web.app"
       target="_self"
       matTooltip="Plannet WOS"
       aria-label="Go to Plannet WOS">
      <mat-icon>apps</mat-icon>
    </a>
  `,
  styles: [`
    .switcher-fab {
      position: fixed;
      bottom: 24px;
      left: 24px;
      z-index: 900;
      background: #00838f !important;
      color: white !important;
      text-decoration: none;
    }
    .switcher-fab:hover {
      background: #00acc1 !important;
    }
  `]
})
export class AppSwitcherComponent {}
