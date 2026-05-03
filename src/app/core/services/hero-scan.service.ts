import { Injectable } from '@angular/core';

// Hero order as they appear in the in-game screenshot when sorted by Quality
// (gen-5 first, top-to-bottom, left-to-right). 4 columns × 4 rows.
const SCAN_ORDER: string[] = [
  'Gwen',     'Nora',     'Hector',   'Lynn',
  'Reina',    'Ahmose',   'Greg',     'Mia',
  'Logan',    'Alonso',   'Philly',   'Flint',
  'Zinman',   'Molly',    'Jeronimo', 'Natalia',
];

interface Band { start: number; end: number; }
interface Card { x: number; y: number; w: number; h: number; }

@Injectable({ providedIn: 'root' })
export class HeroScanService {

  async scan(imageFile: File): Promise<Map<string, number>> {
    const bitmap = await createImageBitmap(imageFile);

    const canvas = document.createElement('canvas');
    canvas.width  = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);

    const imgW = bitmap.width;
    const imgH = bitmap.height;
    const imgData = ctx.getImageData(0, 0, imgW, imgH);
    bitmap.close();

    const cards = this.detectCardGrid(imgData);
    const result = new Map<string, number>();
    for (let i = 0; i < cards.length && i < SCAN_ORDER.length; i++) {
      result.set(SCAN_ORDER[i], this.countStars(imgData, cards[i]));
    }
    return result;
  }

  /**
   * Detects the orange hero card grid via horizontal/vertical projections of
   * an "orange-ish border" mask. Returns cards in row-major order
   * (top-to-bottom, left-to-right). Handles 4×N grids; if more than 16 cards
   * are visible the caller decides what to do with the surplus.
   */
  private detectCardGrid(imgData: ImageData): Card[] {
    const W = imgData.width, H = imgData.height;
    const data = imgData.data;

    const isOrange = (r: number, g: number, b: number) =>
      r > 200 && g > 90 && g < 170 && b < 90 && r - b > 120 && r - g > 50;

    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (isOrange(data[i], data[i + 1], data[i + 2])) mask[y * W + x] = 1;
      }
    }

    const rowProj = new Int32Array(H);
    for (let y = 0; y < H; y++) {
      let n = 0;
      for (let x = 0; x < W; x++) if (mask[y * W + x]) n++;
      rowProj[y] = n;
    }
    const colProj = new Int32Array(W);
    for (let x = 0; x < W; x++) {
      let n = 0;
      for (let y = 0; y < H; y++) if (mask[y * W + x]) n++;
      colProj[x] = n;
    }

    const findBands = (proj: Int32Array, len: number, thr: number, minLen: number): Band[] => {
      const bands: Band[] = [];
      let inB = false, bs = 0;
      for (let i = 0; i < len; i++) {
        if (proj[i] >= thr) {
          if (!inB) { inB = true; bs = i; }
        } else if (inB) {
          if (i - bs >= minLen) bands.push({ start: bs, end: i });
          inB = false;
        }
      }
      if (inB && len - bs >= minLen) bands.push({ start: bs, end: len });
      return bands;
    };

    const rawRowBands = findBands(rowProj, H, 20, 40);
    const colBands    = findBands(colProj, W, Math.round(H * 0.02), 40);
    if (rawRowBands.length < 2 || colBands.length < 4) return [];

    // Pick the 4 widest column bands (left→right) for the 4 card columns.
    const cols4 = [...colBands]
      .sort((a, b) => (b.end - b.start) - (a.end - a.start))
      .slice(0, 4)
      .sort((a, b) => a.start - b.start);

    // Use the first two clean row bands as anchor; project row pitch downward.
    const r0 = rawRowBands[0];
    const r1 = rawRowBands[1];
    const pitch = r1.start - r0.start;
    const rowH  = r0.end - r0.start;
    if (pitch <= 0 || rowH <= 0) return [];

    // Generate candidate rows, but drop any whose center has too little card
    // content — that filters out phantom rows past the bottom of the actual
    // grid.  The first two rows established the pitch via orange borders, but
    // later rows may have purple/pink/gold borders so we test for ANY
    // saturated colour, not just orange.
    const cardW = cols4[0].end - cols4[0].start;
    const minRowOrange = Math.round(cardW * 0.5);
    const rows: Band[] = [];
    for (let i = 0; i < 8; i++) {
      const start = r0.start + i * pitch;
      const end   = Math.min(start + rowH, H);
      // Need at least 60% of a card height to read portrait + stars.
      if (end - start < rowH * 0.6) break;

      // Fast check: does this row have enough orange? (works for most rows)
      let maxN = 0;
      const midA = start + Math.round(rowH * 0.05);
      const midB = end   - Math.round(rowH * 0.05);
      for (let y = midA; y <= midB; y += 4) {
        if (rowProj[y] > maxN) maxN = rowProj[y];
      }
      if (maxN >= minRowOrange) { rows.push({ start, end }); continue; }

      // Fallback: check for ANY saturated card-border colour (purple, gold,
      // pink…). A card border pixel has high saturation — max-min channel
      // spread ≥ 60 and at least one channel > 140.
      let hasContent = false;
      for (let y = midA; y <= midB && !hasContent; y += 4) {
        let saturated = 0;
        for (let x = 0; x < W; x++) {
          const idx = (y * W + x) * 4;
          const r = data[idx], g = data[idx + 1], b = data[idx + 2];
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if (mx > 140 && mx - mn > 60) saturated++;
        }
        if (saturated >= minRowOrange) hasContent = true;
      }
      if (hasContent) rows.push({ start, end });
    }

    const cards: Card[] = [];
    for (const rb of rows) {
      for (const cb of cols4) {
        cards.push({
          x: cb.start,
          y: rb.start,
          w: cb.end - cb.start,
          h: rb.end - rb.start,
        });
      }
    }
    return cards;
  }

  /**
   * Counts active (blue/cyan) stars by peak-detection on the bottom strip of
   * an actual card bbox. Returns 0..5.
   */
  private countStars(imgData: ImageData, card: Card): number {
    const MIN_RUN  = Math.round(card.w * 0.06);
    const GAP_FILL = Math.round(card.w * 0.02);

    // The blue star row sits ~88–98% down the card.
    const stripTop    = Math.round(card.y + card.h * 0.88);
    const stripBottom = Math.round(card.y + card.h * 0.99);

    const xStart = Math.round(card.x);
    const xEnd   = Math.round(card.x + card.w);
    const blueCols: boolean[] = new Array(xEnd - xStart).fill(false);

    for (let xi = xStart; xi < xEnd; xi++) {
      for (let yi = stripTop; yi < stripBottom; yi += 1) {
        if (xi < 0 || xi >= imgData.width || yi < 0 || yi >= imgData.height) continue;
        const idx = (yi * imgData.width + xi) * 4;
        const r = imgData.data[idx];
        const g = imgData.data[idx + 1];
        const b = imgData.data[idx + 2];
        if (b > 100 && b > r * 1.1 && g > 80) { blueCols[xi - xStart] = true; break; }
      }
    }

    const smooth = [...blueCols];
    for (let fill = 1; fill <= GAP_FILL; fill++) {
      for (let i = fill; i < smooth.length - fill; i++) {
        if (blueCols[i - fill] && blueCols[i + fill]) smooth[i] = true;
      }
    }

    let stars = 0, inRun = false, runLen = 0;
    for (let i = 0; i < smooth.length; i++) {
      if (smooth[i]) { inRun = true; runLen++; }
      else if (inRun) { if (runLen >= MIN_RUN) stars++; inRun = false; runLen = 0; }
    }
    if (inRun && runLen >= MIN_RUN) stars++;

    return Math.min(5, stars);
  }
}
