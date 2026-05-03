import { Component } from '@angular/core';
import { Calculator } from './features/calculator/calculator';
import { AppSwitcherComponent } from './shared/app-switcher/app-switcher';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [Calculator, AppSwitcherComponent],
  template: `<app-calculator /><app-switcher />`,
  styles: [],
})
export class App {}
