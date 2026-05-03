# WOS Battle Calculator

An Angular app for optimising battle lineups in **Whiteout Survival**. Upload screenshots to auto-detect your heroes, gear, and account stats, then get an instant lineup recommendation and a full round-by-round battle simulation.

Live: **https://wos-battle-calculator.web.app**

---

## Features

| Feature | Description |
|---|---|
| **Hero roster** | Track all 16 heroes (Gen 1–5) with star level and widget level |
| **Hero scan** | OCR your in-game roster screenshot to auto-fill star levels |
| **Gear scan** | Detect piece type, color, +enhancement, and Lv.mastery from a backpack screenshot |
| **Stats scan** | OCR a battle report to extract your 12 account stat bonuses (ATK/DEF/LETH/HP per unit type) |
| **Inline edits** | Every scan result row is editable in case the detector misreads a value |
| **Optimal lineup** | Recommends the best Infantry / Lancer / Marksman hero and the ideal troop ratio |
| **Battle stats** | Shows the combined stat bonuses that will be used in the simulation |
| **Simulation** | Runs 20 round-by-round battles against Low / Medium / Strong / Yourself at two customisable troop formations |
| **Tutorial** | Built-in 6-step walkthrough accessible from the subtitle ("How does it work?") with example screenshots |
| **App switcher** | Quick-jump FAB in the bottom-left to return to [Plannet WOS](https://plannet-wos.web.app) |

---

## Gear scan pipeline

Gear cards are detected and classified entirely client-side, no server calls:

1. **Card detection** — warm-colour blob labelling on the rarity-frame mask finds every card bbox.
2. **Canonicalisation** — each detected frame is warped into a fixed 220×240 bitmap with consistent padding so the troop badge (above-left) and mastery pill (bottom) always land at the same offsets.
3. **Field extraction** from fixed sub-regions inside the canonical bitmap:
   - **Troop badge** — NCC against mean-subtracted Infantry / Lancer / Marksman templates with a small (size × x × y) sweep to absorb residual drift.
   - **Piece icon** — masked-gray NCC against per-piece templates (head / gloves / belt / shoes). The mask suppresses the warm backdrop, the white "+NN" overlay, and the green enhance arrow so they don't bias the match.
   - **Bonus & mastery** — Tesseract.js, one worker, two parameter sweeps. Each region is colour-thresholded, tightly cropped, upscaled, and binarised before OCR.
4. **Dedup** — keep the best card per (troop × piece) by colour > mastery > bonus.

Templates live in `public/badge-templates/` and `public/gear-templates/` and can be regenerated from the `fb1` fixture via `scripts/regen-badge-templates.mjs` and `scripts/regen-piece-templates.mjs`. `scripts/debug-scan-canonical.mjs` is a Node mirror of the browser pipeline used for fast iteration on test fixtures. Test fixtures (`test-fullbox*.jpg`, etc.) are kept in `public/` for the debug scripts; intermediate debug artifacts are not committed.

Part of the **[Plannet WOS](https://plannet-wos.web.app)** suite.

---

## Stat & Scoring System

### Hero score
```
score = (HeroStatsByGen[gen] * stars) / 100 + widget * 0.6
```

`HeroStatsByGen` (base power per generation):

| Gen | Value |
|-----|-------|
| 1 | 200.2 |
| 2 | 240.2 |
| 3 | 290.2 |
| 4 | 370.29 |
| 5 | 444.35 |

### Effective battle stats
Three sources are combined before each simulation run:
1. **Battle-report scan** — base ATK / DEF / LETH / HP % bonuses per unit type
2. **Gear scan** — additional % from each detected gear piece:
   - Red items: `(50 + 0.5 × E) × (1 + 0.1 × M)`
   - Orange items: `(3.33 + 0.4667 × E) × (1 + 0.1 × M)`
   - `head + shoes` → Lethality | `belt + gloves` → Health
   - Red gear threshold bonuses (additive): +20 → +20% DEF/ATK, +60 → +30% ATK/DEF, +100 → +50% DEF/ATK
3. **Hero contributions** — from the chosen squad:
   - ATK & DEF: `HeroStatsByGen[gen] × (0.24 + stars × 0.152)`
   - LETH & HP: `(WidgetStatsByGen[gen] / 10) × widget`

### Strategy selection (in priority order)
| Condition | Ratio | Strategy |
|---|---|---|
| Gwen ≥4★ + sufficient Marksman gear | 48 / 4 / 48 | Gwen Sniper Meta |
| Lancer dominant + avg score ≥ 15 | 60 / 40 / 0 | Lancer Rush |
| Lancer dominant + avg score < 15 | 60 / 30 / 10 | Sustain Rush |
| avg score < 15 | 60 / 10 / 30 | The Wall |
| Default | 55 / 5 / 40 | Standard Hybrid |

Ratios are **Infantry / Lancer / Marksman**.

---

## Development

```bash
npm install
ng serve          # dev server at http://localhost:4200
ng build          # production build → dist/battle-calculator/browser
firebase deploy --only hosting   # deploy to Firebase
```

Tests use [Vitest](https://vitest.dev/):
```bash
ng test
```

---

## Tech stack

- **Angular 21** with standalone components and signals
- **Angular Material** for UI components
- **Tesseract.js** for in-browser OCR (hero scan, gear scan, stats scan)
- **Firebase Hosting** for deployment
