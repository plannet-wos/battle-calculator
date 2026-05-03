import { Injectable } from '@angular/core';
import { HeroBase } from '../models/hero.model';

@Injectable({ providedIn: 'root' })
export class HeroDataService {
  readonly heroes: HeroBase[] = [
    // Special Heroes
    { name: 'Jeronimo', gen: 0, type: 'Infantry' },
    // Gen 1
    { name: 'Natalia', gen: 0, type: 'Infantry' },
    { name: 'Molly', gen: 1, type: 'Lancer' },
    { name: 'Zinman', gen: 1, type: 'Marksman' },
    // Gen 2
    { name: 'Flint', gen: 2, type: 'Infantry' },
    { name: 'Alonso', gen: 2, type: 'Marksman' },
    { name: 'Philly', gen: 2, type: 'Lancer' },
    // Gen 3
    { name: 'Logan', gen: 3, type: 'Infantry' },
    { name: 'Mia', gen: 3, type: 'Lancer' },
    { name: 'Greg', gen: 3, type: 'Marksman' },
    // Gen 4
    { name: 'Ahmose', gen: 4, type: 'Infantry' },
    { name: 'Reina', gen: 4, type: 'Lancer' },
    { name: 'Lynn', gen: 4, type: 'Marksman' },
    // Gen 5
    { name: 'Hector', gen: 5, type: 'Infantry' },
    { name: 'Norah', gen: 5, type: 'Lancer' },
    { name: 'Gwen', gen: 5, type: 'Marksman' },
  ];
}
