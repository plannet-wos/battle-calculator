# Battle Calculator - Claude AI Context

## What This App Is
Battle Calculator is a client-side web app for **Whiteout Survival** that helps players find their optimal solo PvP lineup. Users scan screenshots of their gear, battle stats, and hero roster, then the app calculates the best hero combination and simulates battles.

Live: **https://wos-battle-calculator.web.app**
Part of the **[Plannet WOS](https://plannet-wos.web.app)** suite.

---

## Non-Negotiable Rules

1. **Framework:** Angular 21, Standalone Components only. No NgModule.
2. **UI:** Angular Material + Angular CDK. No other UI libraries.
3. **Change Detection:** Zoneless (`provideZonelessChangeDetection()`). Do NOT re-introduce zone.js.
4. **State management:** Angular signals only. No RxJS for component state.
5. **All scan/calc processing is client-side.** No backend, no server calls for scans. OCR runs via Tesseract.js in the browser. The only server-side dependency is Firestore for the save-code feature (read/write a 4-char code → JSON blob of the user's heroes/gear/stats, see `core/services/save-code.service.ts`).
6. **Deployment:** Firebase Hosting, site name `wos-battle-calculator`. Firestore rules in `firestore.rules`.
7. **No authentication.** The calculator is a public tool, no login required.

---

## Project Structure

```
src/app/
  features/
    calculator/
      calculator.ts/.html/.scss    # Main (and only) page component
      tutorial-dialog.ts           # 6-step tutorial lightbox
  core/
    models/
      hero.model.ts                # All interfaces (HeroInput, LineupResult, GearScanResult, etc.)
    services/
      hero-data.service.ts         # Static hero database (names, gens, stats)
      calculator.service.ts        # Lineup optimiser (brute-force best 3-hero combo)
      gear-scan.service.ts         # OCR pipeline: screenshot → detected gear items
      stats-scan.service.ts        # OCR pipeline: battle report → stat bonuses + troop tiers
      hero-scan.service.ts         # OCR pipeline: hero roster → star levels
      save-code.service.ts         # Firestore-backed 4-char codes for share/reload
    sim/
      simulator.service.ts         # Round-by-round battle simulator
  shared/
    app-switcher/app-switcher.ts   # FAB linking back to Plannet WOS
public/
  badge-templates/                 # NCC templates for troop type detection
  gear-templates/                  # NCC templates for gear piece detection
  test-fullbox*.jpg/png            # Test fixtures for gear scan debug scripts
  test-battlereport*.jpg/png       # Test fixtures for stats scan debug scripts
  test-heroes*.jpg/png             # Test fixtures for hero scan debug scripts
scripts/
  debug-*.mjs                     # Node.js debug scripts for scan pipelines
  regen-*.mjs                     # Template regeneration scripts
```

---

## Scan Pipeline Notes

- **Gear scan:** Card detection via colour blob labelling → canonical warp → NCC template matching for troop/piece → Tesseract OCR for bonus/mastery values. Dedup uses first-match strategy (items are value-sorted).
- **Stats scan:** Row detection via orange-pixel density → multi-PSM Tesseract OCR with voting → per-slot tier detection (strip split into thirds) → FC badge detection via flood-fill with aspect ratio filter.
- **Hero scan:** Grid detection via orange/saturated border density → star counting via yellow pixel columns → partial row support for 5th row.
- Mastery values are hard-capped at 20. Values above 20 are treated as OCR errors and set to 0.

---

## What to Avoid

- Do not add NgModules.
- Do not add a backend or server-side processing.
- Do not re-introduce zone.js.
- Do not commit debug artifact images (*.debug.png, *.crop*.png, etc.) to public/.
- Do not add extra abstractions not required by the task at hand.
