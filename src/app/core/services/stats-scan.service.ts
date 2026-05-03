import { Injectable } from '@angular/core';
import { createWorker } from 'tesseract.js';
import { AccountStats, BattleReportScan, TroopLevel, TroopLevels, defaultTroopLevels } from '../models/hero.model';

/**
 * Scans the player's battle-report screenshot and extracts:
 *   1. The 12 "Stat Bonuses" values from the LEFT column (the player's own stats).
 *      The left column can be RED (loss) or GREEN (win) — both are handled.
 *   2. The 3 troop tiers ("Lv.NN") and FC levels of the player's army from the
 *      troop strip that sits above the stats table.
 *
 * The screenshot is expected to be the Mail → battle report with the troop
 * strip and "Stat Bonuses" table both visible. Stat rows (top → bottom):
 *   Infantry Attack, Defense, Lethality, Health
 *   Lancer   Attack, Defense, Lethality, Health
 *   Marksman Attack, Defense, Lethality, Health
 */
@Injectable({ providedIn: 'root' })
export class StatsScanService {

  private readonly STAT_ORDER: Array<[keyof AccountStats, 'attack' | 'defense' | 'lethality' | 'health']> = [
    ['inf',  'attack'], ['inf',  'defense'], ['inf',  'lethality'], ['inf',  'health'],
    ['lanc', 'attack'], ['lanc', 'defense'], ['lanc', 'lethality'], ['lanc', 'health'],
    ['mark', 'attack'], ['mark', 'defense'], ['mark', 'lethality'], ['mark', 'health'],
  ];

  async scan(imageFile: File): Promise<BattleReportScan> {
    const bitmap = await createImageBitmap(imageFile);
    const canvas = document.createElement('canvas');
    canvas.width  = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const imgW = bitmap.width;
    const imgH = bitmap.height;
    bitmap.close();

    const imgData = ctx.getImageData(0, 0, imgW, imgH);

    // The stat table fills the LEFT ~33% of the screen width
    const leftXStart = Math.round(imgW * 0.04);
    const leftXEnd   = Math.round(imgW * 0.33);

    // ── Step 1: find the 12 stat rows via a vertical profile ─────────────
    // The player's values can be red (loss) or green (win) — detect both.
    const rowRed = new Int32Array(imgH);
    for (let y = 0; y < imgH; y++) {
      let redCnt = 0;
      for (let x = leftXStart; x < leftXEnd; x += 2) {
        const i = (y * imgW + x) * 4;
        if (this.isStatText(imgData.data[i], imgData.data[i + 1], imgData.data[i + 2])) redCnt++;
      }
      rowRed[y] = redCnt;
    }
    // Smooth with a small window
    const halfWin = 3;
    const smooth = new Float32Array(imgH);
    for (let y = 0; y < imgH; y++) {
      let s = 0, n = 0;
      for (let yy = Math.max(0, y - halfWin); yy <= Math.min(imgH - 1, y + halfWin); yy++) {
        s += rowRed[yy]; n++;
      }
      smooth[y] = s / n;
    }

    const THRESH = 5;
    const bands: Array<{ start: number; end: number }> = [];
    let inBand = false, bandStart = 0;
    for (let y = 0; y < imgH; y++) {
      if (smooth[y] >= THRESH) {
        if (!inBand) { inBand = true; bandStart = y; }
      } else if (inBand) {
        bands.push({ start: bandStart, end: y });
        inBand = false;
      }
    }
    if (inBand) bands.push({ start: bandStart, end: imgH });
    if (bands.length === 0) {
      throw new Error('No stat rows found — is this a battle report screenshot? Make sure the Stat Bonuses table is fully visible.');
    }
    // Keep the last 12 bands (the stat table sits near the bottom)
    const statBands = bands.slice(-12);
    if (statBands.length < 12) {
      throw new Error(`Only ${statBands.length} stat rows detected (need 12). Crop might be missing — include all 12 rows in the screenshot.`);
    }

    // ── Step 2: OCR each row with multi-PSM voting ───────────────────────
    const worker = await createWorker('eng', 1 /* LSTM_ONLY */);
    const result: AccountStats = {
      inf:  { attack: 0, defense: 0, lethality: 0, health: 0 },
      lanc: { attack: 0, defense: 0, lethality: 0, health: 0 },
      mark: { attack: 0, defense: 0, lethality: 0, health: 0 },
    };

    try {
      for (let i = 0; i < 12; i++) {
        const band = statBands[i];
        const bandH = band.end - band.start;

        // Per-row bbox of stat text (red on loss, green on win)
        let minX = imgW, maxX = 0;
        for (let y = band.start; y < band.end; y++) {
          for (let x = leftXStart; x < leftXEnd; x++) {
            const idx = (y * imgW + x) * 4;
            if (this.isStatText(imgData.data[idx], imgData.data[idx + 1], imgData.data[idx + 2])) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
            }
          }
        }
        if (minX >= maxX) continue;

        const bboxW = maxX - minX;
        // Strip more from the right to fully remove the trailing "%" —
        // Tesseract often misreads a half-cut "%" as "7", which also swallows
        // the decimal point and inflates values 10x.
        const stripRight = Math.round(bboxW * 0.22);

        // Skip past the leading "+" glyph. Tesseract regularly misreads it as
        // "1", inflating values 10x. Find the first horizontal gap in the
        // text-pixel column histogram and start the crop AFTER that gap.
        const colHist = new Int32Array(bboxW + 1);
        for (let x = minX; x <= maxX; x++) {
          let cnt = 0;
          for (let y = band.start; y < band.end; y++) {
            const idx = (y * imgW + x) * 4;
            if (this.isStatText(imgData.data[idx], imgData.data[idx + 1], imgData.data[idx + 2])) cnt++;
          }
          colHist[x - minX] = cnt;
        }
        let plusEnd = minX;
        let sawGlyph = false;
        for (let k = 0; k < colHist.length; k++) {
          if (colHist[k] > 0) {
            sawGlyph = true;
          } else if (sawGlyph) {
            // First empty column after the first glyph — this is the gap
            // between "+" and the first digit.
            plusEnd = minX + k;
            break;
          }
        }
        // Sanity: the "+" should be narrow (< ~15% of bboxW). If the first
        // glyph is wider than that we probably found a digit instead — fall
        // back to the original minX.
        const digitsStart = (plusEnd - minX < bboxW * 0.15) ? plusEnd : minX;

        const padX = 4, padY = 8;
        const x0 = Math.max(0, digitsStart - padX);
        const y0 = Math.max(0, band.start - padY);
        const w  = (maxX - digitsStart) - stripRight + 2 * padX;
        const h  = bandH + 2 * padY;

        // Build three crops at different scales (Tesseract behaves differently
        // depending on stroke width).
        const crop4 = this.cropAndThreshold(ctx, x0, y0, w, h, 4);
        const crop6 = this.cropAndThreshold(ctx, x0, y0, w, h, 6);
        const crop8 = this.cropAndThreshold(ctx, x0, y0, w, h, 8);

        const COMBOS: Array<[HTMLCanvasElement, string]> = [
          [crop4, '7'], [crop4, '8'], [crop4, '6'],
          [crop6, '7'], [crop6, '8'], [crop6, '6'],
          [crop8, '7'], [crop8, '8'],
        ];
        const cands: Array<{ value: number; conf: number }> = [];
        for (const [c, psm] of COMBOS) {
          await worker.setParameters({
            tessedit_char_whitelist: '+.0123456789',
            tessedit_pageseg_mode: psm,
          } as any);
          const { data: { text, confidence } } = await worker.recognize(c);
          const v = this.parseStatText(text);
          cands.push({ value: v, conf: confidence });
        }

        // Vote for the most common plausible value
        const valid = cands.filter(c => c.value > 0 && c.value < 10000);
        if (valid.length === 0) continue;
        const counts = new Map<number, { count: number; conf: number }>();
        for (const c of valid) {
          const cur = counts.get(c.value) ?? { count: 0, conf: 0 };
          cur.count++;
          cur.conf += c.conf;
          counts.set(c.value, cur);
        }
        let bestVal = 0, bestCount = 0, bestConf = 0;
        for (const [v, { count, conf }] of counts) {
          if (count > bestCount || (count === bestCount && conf > bestConf)) {
            bestVal = v; bestCount = count; bestConf = conf;
          }
        }
        const [type, stat] = this.STAT_ORDER[i];
        result[type][stat] = bestVal;
      }

      // ── Step 3: detect troop tier (Lv.NN) and FC from the strip above ──
      // Use the top of the dark "Stat Bonuses" header band as the troop
      // strip's bottom edge. The header is detected by luminance (not by
      // reading the text — it could be in any language).
      const headerTop = this.findHeaderTop(imgData, imgW, statBands[0].start);
      const troops = await this.detectTroopLevels(worker, ctx, imgW, headerTop);
      return { stats: result, troops };
    } finally {
      await worker.terminate();
    }
  }

  /**
   * Reads the troop strip above the stats table to find each unit's tier
   * (1-11) and FC level (0-5). Falls back to T10/FC5 defaults on any failure
   * — the user can always edit the result in the UI.
   */
  private async detectTroopLevels(
    worker: Awaited<ReturnType<typeof createWorker>>,
    ctx: CanvasRenderingContext2D,
    imgW: number,
    headerTop: number,
  ): Promise<TroopLevels> {
    const fallback = defaultTroopLevels();
    if (headerTop < 40) return fallback;

    // The "Lv. N.0" labels sit just below the troop icons, in roughly the
    // BOTTOM 35% of the strip above the header. Cropping tighter — and only
    // the LEFT half — keeps the title bar and army strength bars out of OCR
    // and gives the small label text a fighting chance.
    const halfW  = Math.round(imgW / 2);
    const fullH  = headerTop - 4;
    if (fullH < 20) return fallback;
    const labelTop = Math.max(0, fullH - Math.round(fullH * 0.35));
    const labelH   = fullH - labelTop;
    // Upscale 3× and threshold light-text → black so Tesseract reliably picks
    // up the tiny labels. Mirrors the per-row preprocessing used for stats.
    const SCALE = 3;
    const stripCanvas = document.createElement('canvas');
    stripCanvas.width  = halfW * SCALE;
    stripCanvas.height = labelH * SCALE;
    const sctx = stripCanvas.getContext('2d', { willReadFrequently: true })!;
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(ctx.canvas, 0, labelTop, halfW, labelH, 0, 0, halfW * SCALE, labelH * SCALE);
    const id = sctx.getImageData(0, 0, stripCanvas.width, stripCanvas.height);
    const d  = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
      const v = lum > 180 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    sctx.putImageData(id, 0, 0);

    // Sparse-text PSM finds isolated "Lv.NN" labels reliably.
    const tiers = await this.ocrTiers(worker, stripCanvas, halfW);
    // FC badges are detected on the ORIGINAL pixels (not the thresholded
    // strip) because the red shield colour is the anchor — that information
    // is lost after the tier-preprocessing pass.
    const fcsBySlot = await this.detectFCBadges(worker, ctx, halfW, labelTop, labelH);

    // If we couldn't recover all 3 tiers there's no point assigning anything
    // — fall back so the user gets sensible defaults to edit.
    if (tiers.length < 3) return fallback;

    const sortedTiers = [...tiers].sort((a, b) => a.x - b.x).slice(0, 3);
    const fcMap = new Map<number, number>();
    for (const f of fcsBySlot) fcMap.set(f.slot, f.value);

    const mk = (idx: number): TroopLevel => ({
      tier: sortedTiers[idx].value,
      fc:   fcMap.get(idx) ?? 0,
    });
    return { inf: mk(0), lanc: mk(1), mark: mk(2) };
  }

  /**
   * Find FC badges by colour: every badge is a small bright-red shield in
   * the upper-right corner of an icon. We mask bright-red pixels in the
   * search rect, flood-fill into connected blobs, take the 3 largest, then
   * OCR the white digit inside each one with multi-PSM voting.
   *
   * Returns slot-indexed results: slot 0 = leftmost icon (infantry),
   * 1 = middle (lancer), 2 = right (marksman). Missing badges → caller
   * defaults that slot to FC 0.
   */
  private async detectFCBadges(
    worker: Awaited<ReturnType<typeof createWorker>>,
    ctx: CanvasRenderingContext2D,
    searchW: number,
    searchY0: number,
    searchH: number,
  ): Promise<Array<{ slot: number; value: number }>> {
    const imgData = ctx.getImageData(0, searchY0, searchW, searchH);
    const px = imgData.data;

    // Bright-red mask: high R, low G/B, large gap to G and B.
    const mask = new Uint8Array(searchW * searchH);
    for (let y = 0; y < searchH; y++) {
      for (let x = 0; x < searchW; x++) {
        const i = (y * searchW + x) * 4;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        if (r > 170 && g < 90 && b < 90 && r - g > 80 && r - b > 80) {
          mask[y * searchW + x] = 1;
        }
      }
    }

    // 4-connected flood-fill into blobs.
    const labels = new Int32Array(searchW * searchH);
    let nextLabel = 1;
    const blobs: Array<{ minX: number; minY: number; maxX: number; maxY: number; count: number }> = [];
    const stack: number[] = [];
    for (let y = 0; y < searchH; y++) {
      for (let x = 0; x < searchW; x++) {
        const idx = y * searchW + x;
        if (!mask[idx] || labels[idx] !== 0) continue;
        const lbl = nextLabel++;
        stack.length = 0;
        stack.push(idx);
        const blob = { minX: x, minY: y, maxX: x, maxY: y, count: 0 };
        while (stack.length) {
          const p = stack.pop()!;
          if (labels[p] !== 0) continue;
          labels[p] = lbl;
          blob.count++;
          const qx = p % searchW;
          const qy = (p - qx) / searchW;
          if (qx < blob.minX) blob.minX = qx;
          if (qy < blob.minY) blob.minY = qy;
          if (qx > blob.maxX) blob.maxX = qx;
          if (qy > blob.maxY) blob.maxY = qy;
          if (qx > 0           && mask[p - 1]       && labels[p - 1]       === 0) stack.push(p - 1);
          if (qx < searchW - 1 && mask[p + 1]       && labels[p + 1]       === 0) stack.push(p + 1);
          if (qy > 0           && mask[p - searchW] && labels[p - searchW] === 0) stack.push(p - searchW);
          if (qy < searchH - 1 && mask[p + searchW] && labels[p + searchW] === 0) stack.push(p + searchW);
        }
        blobs.push(blob);
      }
    }

    // Filter noise + huge bars; keep the 3 largest roughly-square blobs.
    // FC badges are hexagonal shields ≈ 30×30 px — nearly square.  Non-badge
    // red elements (troop-icon borders, HP bars) are elongated, so requiring a
    // minimum squareness ratio eliminates them.
    const candidates = blobs
      .filter(b => b.count >= 30)
      .filter(b => {
        const bw = b.maxX - b.minX;
        const bh = b.maxY - b.minY;
        if (bw >= 80 || bh >= 80) return false;
        const ratio = Math.min(bw, bh) / Math.max(bw, bh);
        return ratio > 0.85;  // reject elongated shapes
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    if (candidates.length === 0) return [];

    // OCR each badge with multi-PSM voting. Inset the bbox 18% inward to drop
    // the shield outline — without it Tesseract sometimes drops the digit.
    const SCALE = 6;
    const INSET = 0.18;
    const PSMS = ['10', '8', '7', '13', '6'];
    const out: Array<{ slot: number; value: number }> = [];

    for (const b of candidates) {
      const bw = b.maxX - b.minX + 1;
      const bh = b.maxY - b.minY + 1;
      const insetX = Math.round(bw * INSET);
      const insetY = Math.round(bh * INSET);
      const cx = b.minX + insetX;
      const cy = searchY0 + b.minY + insetY;
      const cw = bw - insetX * 2;
      const ch = bh - insetY * 2;
      if (cw < 4 || ch < 4) continue;

      const crop = document.createElement('canvas');
      crop.width  = cw * SCALE;
      crop.height = ch * SCALE;
      const cctx = crop.getContext('2d', { willReadFrequently: true })!;
      cctx.imageSmoothingEnabled = false;
      cctx.drawImage(ctx.canvas, cx, cy, cw, ch, 0, 0, crop.width, crop.height);

      // White digit → black foreground (Tesseract loves dark-on-white).
      const cid = cctx.getImageData(0, 0, crop.width, crop.height);
      const cd = cid.data;
      for (let p = 0; p < cd.length; p += 4) {
        const lum = (cd[p] + cd[p + 1] + cd[p + 2]) / 3;
        const v = lum > 180 ? 0 : 255;
        cd[p] = cd[p + 1] = cd[p + 2] = v;
        cd[p + 3] = 255;
      }
      cctx.putImageData(cid, 0, 0);

      const votes = new Map<string, number>();
      for (const psm of PSMS) {
        await worker.setParameters({
          tessedit_char_whitelist: '12345',
          tessedit_pageseg_mode: psm,
        } as any);
        const r = await worker.recognize(crop);
        const t = r.data.text.replace(/[^12345]/g, '');
        if (t.length === 1) votes.set(t, (votes.get(t) ?? 0) + 1);
      }
      let winner = '', winCount = 0;
      for (const [v, c] of votes) {
        if (c > winCount) { winner = v; winCount = c; }
      }
      if (!winner) continue;

      // Slot = which horizontal third the badge centre falls in.
      const centerX = b.minX + bw / 2;
      const slot = Math.min(2, Math.max(0, Math.floor((centerX / searchW) * 3)));
      out.push({ slot, value: parseInt(winner, 10) });
    }
    return out;
  }

  /**
   * Run OCR over the tier strip. Splits the strip into 3 vertical thirds (one
   * per troop slot) and OCRs each independently — this isolates tiny "Lv.N.0"
   * labels from neighbouring text (troop counts, FC badges) that confuse
   * Tesseract when the whole strip is processed at once.
   */
  private async ocrTiers(
    worker: Awaited<ReturnType<typeof createWorker>>,
    strip: HTMLCanvasElement,
    imgW: number,
  ): Promise<Array<{ x: number; value: number }>> {
    const flatPattern = /(?:L?v\.?\s*)?(\d{1,2})\.0(?!\d)/gi;
    const stripW = strip.width;
    const stripH = strip.height;
    const thirdW = Math.round(stripW / 3);

    const matches: Array<{ x: number; value: number }> = [];

    for (let slot = 0; slot < 3; slot++) {
      const sx = slot * thirdW;
      const sw = slot < 2 ? thirdW : stripW - sx;

      // Extract one-third sub-strip.
      const sub = document.createElement('canvas');
      sub.width = sw;
      sub.height = stripH;
      const sctx = sub.getContext('2d', { willReadFrequently: true })!;
      sctx.drawImage(strip, sx, 0, sw, stripH, 0, 0, sw, stripH);

      // Try PSM 11 (sparse), then PSM 6 (block) as fallback.
      let tier = 0;
      for (const psm of ['11', '6'] as const) {
        await worker.setParameters({
          tessedit_char_whitelist: 'Lv.0123456789',
          tessedit_pageseg_mode: psm as any,
        } as any);
        const { data } = await worker.recognize(sub);
        const nums = [...data.text.matchAll(flatPattern)]
          .map((m: RegExpExecArray) => parseInt(m[1], 10))
          .filter((v: number) => v >= 1 && v <= 11);
        if (nums.length > 0) { tier = nums[0]; break; }
      }
      if (tier > 0) {
        matches.push({ x: imgW * (slot + 0.5) / 3, value: tier });
      }
    }
    return matches;
  }

  /**
   * Locates the top y of the dark "Stat Bonuses" header band that sits
   * directly above the first stat row. We do NOT read the text — the game
   * is localized — instead we look for a sustained horizontal band where
   * mean luminance dips noticeably below the cream card background.
   * Falls back to `firstStatY` if no dark band is found.
   */
  private findHeaderTop(imgData: ImageData, imgW: number, firstStatY: number): number {
    const data = imgData.data;
    const x0 = Math.round(imgW * 0.20);
    const x1 = Math.round(imgW * 0.80);
    const searchTop = Math.max(0, firstStatY - 250);

    const rowLuma = (y: number): number => {
      let sum = 0, n = 0;
      for (let x = x0; x < x1; x += 4) {
        const i = (y * imgW + x) * 4;
        sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
        n++;
      }
      return n > 0 ? sum / n : 255;
    };

    // Sample a small window just above the first stat row to estimate the
    // cream-background luma (the gap between header and table).
    let bgSum = 0, bgN = 0;
    for (let y = Math.max(0, firstStatY - 18); y < Math.max(0, firstStatY - 2); y++) {
      bgSum += rowLuma(y); bgN++;
    }
    const bgLuma   = bgN > 0 ? bgSum / bgN : 240;
    const darkThr  = bgLuma - 20;

    // Walk up from just above the first stat row, find the bottom of the
    // first sustained dark stretch (≥ 6 consecutive dark rows = the header).
    let darkBottom = -1, run = 0;
    for (let y = firstStatY - 4; y >= searchTop; y--) {
      const lum = rowLuma(y);
      if (lum < darkThr) {
        if (darkBottom < 0) darkBottom = y;
        run++;
        if (run >= 6) break;
      } else {
        darkBottom = -1;
        run = 0;
      }
    }
    if (darkBottom < 0) return firstStatY;

    // From there, walk further up while still dark to find the header top.
    let headerTop = darkBottom;
    for (let y = darkBottom - 1; y >= searchTop; y--) {
      if (rowLuma(y) < darkThr) headerTop = y;
      else break;
    }
    return headerTop;
  }

  /**
   * Returns true for pixels that are stat-value text in the battle report.
   * The left column is RED when the player loses, GREEN when the player wins.
   */
  private isStatText(r: number, g: number, b: number): boolean {
    const isRed   = r > 180 && g < 120 && b < 120 && r - g > 60;
    const isGreen = g > 160 && r < 140 && b < 120 && g - r > 40;
    return isRed || isGreen;
  }

  /**
   * Parses a Tesseract output string into a floating-point stat value.
   * The game renders values as "D...D.D%" (1-4 digits, one decimal digit).
   * Common Tesseract errors:
   *   "+573.9%" → "+573.97"  (the % gets read as a trailing "7")
   *   "+338.0"  → "+338.07"  (same)
   *   "+573.9"  → "5739"     (the dot is missed)
   */
  private parseStatText(text: string): number {
    if (!text) return 0;
    const t = text.replace(/\s|%/g, '');
    const m = t.match(/\+?(\d+(?:\.\d+)?)/);
    if (!m) return 0;
    let s = m[1];
    const dot = s.indexOf('.');
    if (dot >= 0) {
      // Force exactly 1 decimal digit
      s = s.slice(0, dot + 2);
    } else if (s.length >= 3) {
      // Dot was missed — split off the last digit as the decimal
      s = s.slice(0, -1) + '.' + s.slice(-1);
    }
    return parseFloat(s);
  }

  private cropAndThreshold(
    ctx: CanvasRenderingContext2D,
    x0: number, y0: number, w: number, h: number,
    scale: number,
  ): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width  = w * scale;
    out.height = h * scale;
    const oc = out.getContext('2d', { willReadFrequently: true })!;
    oc.drawImage(ctx.canvas, x0, y0, w, h, 0, 0, out.width, out.height);
    const id = oc.getImageData(0, 0, out.width, out.height);
    for (let i = 0; i < id.data.length; i += 4) {
      // Threshold both red (loss) and green (win) stat text to black foreground
      const v = this.isStatText(id.data[i], id.data[i + 1], id.data[i + 2]) ? 0 : 255;
      id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
      id.data[i + 3] = 255;
    }
    oc.putImageData(id, 0, 0);
    return out;
  }
}
