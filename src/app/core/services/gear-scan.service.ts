import { Injectable } from '@angular/core';
import { createWorker } from 'tesseract.js';
import { DetectedGearItem, GearScanResult } from '../models/hero.model';

// ─────────────────────────────────────────────────────────────────────────────
// Gear-card scan pipeline.
//
// Rather than chase floating offsets in raw pixel space, every detected card
// is canonicalised into a fixed-size bitmap (CANON_W × CANON_H) and all fields
// are then read from FIXED sub-regions inside that bitmap.
//
// Steps:
//   1. Detect each card's rarity-frame bbox via warm-colour blob labelling.
//   2. Warp the source region (frame + small margins that include the troop
//      badge above-left and the mastery pill at the bottom) into the canonical
//      bitmap, one per card.
//   3. From that canonical bitmap, extract fixed sub-regions:
//        R_BADGE    top-left → troop classification (NCC vs badge templates)
//        R_BONUS    upper    → OCR "+NN" white enhancement text
//        R_ICON     centre   → piece classification (NCC vs piece templates)
//        R_MASTERY  bottom   → OCR "Lv.NN" yellow mastery text
//   4. Dedup per (troop × piece) and return the best.
// ─────────────────────────────────────────────────────────────────────────────

const PIECES = ['head', 'gloves', 'belt', 'shoes'] as const;
const TROOPS = ['Infantry', 'Marksman', 'Lancer'] as const;
type Piece = typeof PIECES[number];
type Troop = typeof TROOPS[number];

// Per-piece template variants that exist on disk. The new scanner resamples
// each template onto the canonical ICON size and compares with masked-gray NCC.
const PIECE_VARIANT_FILES: Record<Piece, string[]> = {
  head:   ['a', 'b', 'c', 'd', 'e'],
  gloves: ['a', 'b', 'c', 'd'],
  belt:   ['a', 'b', 'c', 'd'],
  shoes:  ['a', 'b', 'c', 'd'],
};

// Canonical card bitmap dimensions. Aspect ~0.92 matches the real card with
// the chosen source padding below (frame.w × 1.13 by frame.h × 1.23).
const CANON_W = 220;
const CANON_H = 240;

// How much of the source image around the rarity frame to include in the
// canonical bitmap. The troop badge sits ~13 % above and ~6 % left of the
// frame, so we pad a bit more than that. Bottom + right pads are small
// because the frame already contains the mastery pill and hero avatar.
const SRC_PAD_L = 0.08;
const SRC_PAD_T = 0.18;
const SRC_PAD_R = 0.05;
const SRC_PAD_B = 0.05;

// Fixed sub-regions inside the canonical bitmap. Coordinates were measured
// across the 7 test fixtures; after canonicalisation the rarity frame always
// lands at y≈43..221 inside the 220×240 canvas, so these regions are stable.
//
//   R_BADGE   — troop badge (above-left of the frame). classifyTroop sweeps a
//               small (size × x × y) window inside this box because the badge
//               can drift ±4 px between fixtures.
//   R_BONUS   — upper strip right of the badge, generous enough to fit both
//               the "+NN" white text and the optional green enhance arrow.
//   R_ICON    — middle block covering the gear item. Overlaps the bonus text
//               area but toMaskedGrayNorm() suppresses white/green pixels so
//               the text and arrow don't bias the NCC.
//   R_MASTERY — bottom strip wide enough to include "Lv.NN" both when it's
//               centred (no equipped hero) and when a hero avatar pushes it
//               rightward.
const R_BADGE   = { x:  10, y:  25, w:  55, h:  55 };
const R_BONUS   = { x:  80, y:  35, w: 140, h:  60 };
const R_ICON    = { x:  20, y:  50, w: 180, h: 135 };
const R_MASTERY = { x:  30, y: 180, w: 190, h:  55 };

// Template sizes used inside NCC. Templates are resampled to these sizes on
// load; the on-card regions are resampled to the same size at classify time.
const BADGE_W = 64, BADGE_H = 64;
const ICON_TMPL_W = 128, ICON_TMPL_H = 64;

interface Frame { x: number; y: number; w: number; h: number }

@Injectable({ providedIn: 'root' })
export class GearScanService {

  private badgeTemplates: Map<Troop, Float32Array> | null = null;
  private pieceTemplates: Map<Piece, Float32Array[]> | null = null;

  // ─── public entry point ────────────────────────────────────────────────────
  async scan(imageFile: File): Promise<GearScanResult> {
    const bitmap = await createImageBitmap(imageFile);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result: GearScanResult = { infantry: [], lancer: [], marksman: [] };

    const frames = this.detectCardFrames(imgData);
    if (frames.length === 0) return result;

    await this.loadBadgeTemplates();
    await this.loadPieceTemplates();

    // Canonicalise every detected card once. Piece/colour/troop/OCR all read
    // from these fixed-size bitmaps.
    const canons = frames.map(f => this.canonicalize(ctx, f));

    // Pass 1: classify every card (troop, color, piece).
    interface Pending { canon: HTMLCanvasElement; item: DetectedGearItem }
    const queue: Pending[] = [];
    for (let i = 0; i < frames.length; i++) {
      const canon = canons[i];
      const troop = this.classifyTroop(canon);
      if (!troop) continue;
      const color = this.detectColor(canon);
      const piece = this.classifyPiece(canon);
      queue.push({
        canon,
        item: { type: troop, color, piece, bonusLevel: 0, masteryLevel: 0 },
      });
    }
    if (queue.length === 0) return result;

    // Pass 2: OCR bonus + mastery. One worker, two sweeps (one sweep =
    // one setParameters() call + one recognize() per card).
    const worker = await createWorker('eng');
    try {
      await worker.setParameters({
        tessedit_char_whitelist: '+0123456789',
        tessedit_pageseg_mode: '7' as any,
      });
      for (const { canon, item } of queue) {
        item.bonusLevel = await this.ocrBonus(worker, canon);
      }

      await worker.setParameters({
        tessedit_char_whitelist: 'Lv.0123456789',
        tessedit_pageseg_mode: '7' as any,
      });
      for (const { canon, item } of queue) {
        item.masteryLevel = await this.ocrMastery(worker, canon, item.color);
      }
    } finally {
      await worker.terminate();
    }

    // Pass 3: dedup — keep the first card per (troop × piece).
    // Cards are iterated in image order (top→bottom, left→right).  Because the
    // scan instructions tell the user to sort by value (highest first), the
    // first match for each slot IS the best one.  Later duplicates are almost
    // always misclassifications that would corrupt the correct card's values.
    for (const type of ['infantry', 'lancer', 'marksman'] as const) {
      const slots: Partial<Record<Piece, DetectedGearItem>> = {};
      for (const { item } of queue) {
        if (item.type.toLowerCase() !== type) continue;
        if (item.piece === 'unknown') continue;
        const p = item.piece as Piece;
        if (!slots[p]) slots[p] = item;
      }
      for (const p of PIECES) {
        const it = slots[p];
        if (it) result[type].push(it);
      }
    }
    return result;
  }

  // ─── card detection (blob labelling on the warm rarity-frame mask) ────────
  private detectCardFrames(imgData: ImageData): Frame[] {
    const w = imgData.width, h = imgData.height;
    let mask = this.buildFrameMask(imgData.data, w, h);
    mask = this.dilate(mask, w, h, Math.max(3, Math.round(w * 0.008)));
    const boxes = this.labelComponents(mask, w, h);
    const frames = this.filterCardBlobs(boxes, w);
    frames.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return frames;
  }

  private buildFrameMask(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
    const mask = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // Warm rarity frame: strongly red-dominant, not too blue. Catches both
      // red (high mastery) and orange (mid-tier) frames.
      if (r > 130 && r > g + 20 && r > b + 30 && b < 140) mask[p] = 1;
    }
    return mask;
  }

  private dilate(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let dy = -radius; dy <= radius && !v; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -radius; dx <= radius && !v; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (mask[yy * w + xx]) v = 1;
          }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  private labelComponents(mask: Uint8Array, w: number, h: number) {
    const labels = new Int32Array(w * h);
    const parent = [0];
    let next = 1;
    const find = (a: number): number => {
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    };
    const union = (a: number, b: number) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!mask[p]) continue;
        const l = x > 0 ? labels[p - 1] : 0;
        const u = y > 0 ? labels[p - w] : 0;
        if (l && u) { labels[p] = Math.min(l, u); union(l, u); }
        else if (l) labels[p] = l;
        else if (u) labels[p] = u;
        else { labels[p] = next; parent[next] = next; next++; }
      }
    }
    interface Box { minX: number; minY: number; maxX: number; maxY: number; area: number }
    const boxes = new Map<number, Box>();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!labels[p]) continue;
        const r = find(labels[p]);
        let box = boxes.get(r);
        if (!box) { box = { minX: x, minY: y, maxX: x, maxY: y, area: 0 }; boxes.set(r, box); }
        if (x < box.minX) box.minX = x;
        if (y < box.minY) box.minY = y;
        if (x > box.maxX) box.maxX = x;
        if (y > box.maxY) box.maxY = y;
        box.area++;
      }
    }
    return boxes;
  }

  private filterCardBlobs(
    boxes: Map<number, { minX: number; minY: number; maxX: number; maxY: number; area: number }>,
    imgW: number,
  ): Frame[] {
    const cand: Frame[] = [];
    for (const b of boxes.values()) {
      const w = b.maxX - b.minX + 1;
      const h = b.maxY - b.minY + 1;
      if (w < imgW * 0.10 || w > imgW * 0.5) continue;
      if (h < imgW * 0.08) continue;
      const aspect = w / h;
      if (aspect < 0.7 || aspect > 1.8) continue;
      if (b.area / (w * h) < 0.5) continue;
      cand.push({ x: b.minX, y: b.minY, w, h });
    }
    if (cand.length === 0) return [];
    const ws = cand.map(c => c.w).sort((a, b) => a - b);
    const hs = cand.map(c => c.h).sort((a, b) => a - b);
    const mw = ws[Math.floor(ws.length / 2)];
    const mh = hs[Math.floor(hs.length / 2)];
    return cand.filter(c =>
      Math.abs(c.w - mw) < mw * 0.25 && Math.abs(c.h - mh) < mh * 0.25,
    );
  }

  // ─── canonicalisation ──────────────────────────────────────────────────────
  private canonicalize(ctx: CanvasRenderingContext2D, f: Frame): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = CANON_W; c.height = CANON_H;
    const cx = c.getContext('2d', { willReadFrequently: true })!;
    cx.imageSmoothingEnabled = true;
    const sx = f.x - f.w * SRC_PAD_L;
    const sy = f.y - f.h * SRC_PAD_T;
    const sw = f.w * (1 + SRC_PAD_L + SRC_PAD_R);
    const sh = f.h * (1 + SRC_PAD_T + SRC_PAD_B);
    cx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, CANON_W, CANON_H);
    return c;
  }

  // ─── troop badge classification ────────────────────────────────────────────
  private async loadBadgeTemplates(): Promise<void> {
    if (this.badgeTemplates) return;
    const files: Record<Troop, string> = {
      Infantry: 'infantry.png',
      Marksman: 'marksman.png',
      Lancer: 'lancer.png',
    };
    const n = BADGE_W * BADGE_H;
    const grays: Record<Troop, Float32Array> = {
      Infantry: new Float32Array(n),
      Marksman: new Float32Array(n),
      Lancer: new Float32Array(n),
    };
    for (const troop of TROOPS) {
      const blob = await fetch(`/badge-templates/${files[troop]}`).then(r => r.blob());
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = BADGE_W; c.height = BADGE_H;
      const cx = c.getContext('2d', { willReadFrequently: true })!;
      cx.drawImage(bmp, 0, 0, BADGE_W, BADGE_H);
      bmp.close();
      const data = cx.getImageData(0, 0, BADGE_W, BADGE_H).data;
      const g = grays[troop];
      for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        g[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
    }
    // Difference-of-mean: subtract per-pixel mean across all troops so the
    // shared shield outline cancels and only the unique inner icon drives NCC.
    const mean = new Float32Array(n);
    for (const t of TROOPS) for (let j = 0; j < n; j++) mean[j] += grays[t][j];
    for (let j = 0; j < n; j++) mean[j] /= TROOPS.length;
    const map = new Map<Troop, Float32Array>();
    for (const t of TROOPS) {
      const diff = new Float32Array(n);
      for (let j = 0; j < n; j++) diff[j] = grays[t][j] - mean[j];
      map.set(t, this.normalize(diff));
    }
    this.badgeTemplates = map;
  }

  private classifyTroop(canon: HTMLCanvasElement): Troop | null {
    // Extract the R_BADGE region from the canonical bitmap and match it
    // against the mean-subtracted badge templates. We do a small sweep of
    // (x,y,size) around the nominal region because canonicalisation only
    // normalises frame position — the badge sits a few px above-left of
    // the frame top-left so different fixtures can push it ±4 px.
    const tc = document.createElement('canvas');
    tc.width = BADGE_W; tc.height = BADGE_H;
    const tcx = tc.getContext('2d', { willReadFrequently: true })!;
    tcx.imageSmoothingEnabled = true;
    const n = BADGE_W * BADGE_H;
    const g = new Float32Array(n);
    let best: Troop | null = null;
    let bestScore = -Infinity;
    const SIZES = [48, 55, 62];
    const OFFS = [-6, -3, 0, 3, 6];
    for (const sz of SIZES) {
      for (const ox of OFFS) {
        for (const oy of OFFS) {
          const sx = R_BADGE.x + ox;
          const sy = R_BADGE.y + oy;
          if (sx < 0 || sy < 0 || sx + sz > CANON_W || sy + sz > CANON_H) continue;
          tcx.fillStyle = '#103860';
          tcx.fillRect(0, 0, BADGE_W, BADGE_H);
          tcx.drawImage(canon, sx, sy, sz, sz, 0, 0, BADGE_W, BADGE_H);
          const d = tcx.getImageData(0, 0, BADGE_W, BADGE_H).data;
          for (let i = 0, j = 0; i < d.length; i += 4, j++) {
            g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          }
          const gn = this.normalize(g.slice());
          for (const t of TROOPS) {
            const tg = this.badgeTemplates!.get(t)!;
            let score = 0;
            for (let i = 0; i < n; i++) score += gn[i] * tg[i];
            score /= n;
            if (score > bestScore) { bestScore = score; best = t; }
          }
        }
      }
    }
    if (bestScore < 0.08) return null;
    return best;
  }

  // ─── piece icon classification ─────────────────────────────────────────────
  private async loadPieceTemplates(): Promise<void> {
    if (this.pieceTemplates) return;
    const map = new Map<Piece, Float32Array[]>();
    for (const piece of PIECES) {
      const arr: Float32Array[] = [];
      for (const v of PIECE_VARIANT_FILES[piece]) {
        const url = `/gear-templates/piece_${piece}_${v}.png`;
        const res = await fetch(url);
        if (!res.ok) continue;
        // SPA hosting (Firebase) rewrites missing assets to index.html with a
        // 200 status, so the response can be HTML even when res.ok. Reject
        // anything that isn't actually an image before decoding.
        if (!(res.headers.get('content-type') ?? '').startsWith('image/')) continue;
        const bmp = await createImageBitmap(await res.blob());
        const c = document.createElement('canvas');
        c.width = ICON_TMPL_W; c.height = ICON_TMPL_H;
        const cx = c.getContext('2d', { willReadFrequently: true })!;
        cx.imageSmoothingEnabled = true;
        cx.drawImage(bmp, 0, 0, ICON_TMPL_W, ICON_TMPL_H);
        bmp.close();
        const img = cx.getImageData(0, 0, ICON_TMPL_W, ICON_TMPL_H);
        arr.push(this.toMaskedGrayNorm(img.data, ICON_TMPL_W * ICON_TMPL_H));
      }
      map.set(piece, arr);
    }
    this.pieceTemplates = map;
  }

  private classifyPiece(canon: HTMLCanvasElement): Piece {
    const c = document.createElement('canvas');
    c.width = ICON_TMPL_W; c.height = ICON_TMPL_H;
    const cx = c.getContext('2d', { willReadFrequently: true })!;
    cx.imageSmoothingEnabled = true;
    cx.drawImage(canon, R_ICON.x, R_ICON.y, R_ICON.w, R_ICON.h, 0, 0, ICON_TMPL_W, ICON_TMPL_H);
    const cardG = this.toMaskedGrayNorm(
      cx.getImageData(0, 0, ICON_TMPL_W, ICON_TMPL_H).data,
      ICON_TMPL_W * ICON_TMPL_H,
    );
    let bestPiece: Piece = 'head';
    let bestNcc = -Infinity;
    for (const piece of PIECES) {
      let pieceMax = -Infinity;
      for (const tg of this.pieceTemplates!.get(piece) ?? []) {
        let s = 0;
        for (let i = 0; i < cardG.length; i++) s += cardG[i] * tg[i];
        s /= cardG.length;
        if (s > pieceMax) pieceMax = s;
      }
      if (pieceMax > bestNcc) { bestNcc = pieceMax; bestPiece = piece; }
    }
    return bestPiece;
  }

  private toMaskedGrayNorm(data: Uint8ClampedArray, n: number): Float32Array {
    // Mask out everything that isn't the gear item itself:
    //   • warm rarity-backdrop (red or orange panel)  → critical so red
    //     templates match orange card crops and vice-versa
    //   • near-white pixels                          → the "+NN" bonus label
    //     that overlaps the top of the icon area
    //   • saturated greens                           → the enhance-arrow icon
    //     that sits to the right of the bonus label
    // The templates on disk were extracted without bonus text / arrows, so
    // suppressing these on the scanned card too makes the two comparable.
    const gray = new Float32Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const isBackdrop  = r > 130 && r - b > 40 && r >= g && b < 150;
      const isBonusText = r > 200 && g > 200 && b > 200;
      const isArrow     = g > 170 && g > r + 15 && g > b + 15;
      gray[j] = (isBackdrop || isBonusText || isArrow) ? 128 : 0.299 * r + 0.587 * g + 0.114 * b;
    }
    let mean = 0;
    for (let j = 0; j < n; j++) mean += gray[j];
    mean /= n;
    let std = 0;
    for (let j = 0; j < n; j++) std += (gray[j] - mean) ** 2;
    std = Math.sqrt(std / n) + 1e-6;
    for (let j = 0; j < n; j++) gray[j] = (gray[j] - mean) / std;
    return gray;
  }

  private normalize(arr: Float32Array): Float32Array {
    const n = arr.length;
    let mean = 0;
    for (let j = 0; j < n; j++) mean += arr[j];
    mean /= n;
    let std = 0;
    for (let j = 0; j < n; j++) std += (arr[j] - mean) ** 2;
    std = Math.sqrt(std / n) + 1e-6;
    const out = new Float32Array(n);
    for (let j = 0; j < n; j++) out[j] = (arr[j] - mean) / std;
    return out;
  }

  // ─── rarity colour ─────────────────────────────────────────────────────────
  private detectColor(canon: HTMLCanvasElement): 'red' | 'orange' | 'unknown' {
    // Sample the right-hand side of the rarity frame's top strip. That area
    // is always clean backdrop (between the bonus label at top-right and the
    // gear icon in the centre).
    const cx = canon.getContext('2d', { willReadFrequently: true })!;
    const d = cx.getImageData(100, 55, 110, 20).data;
    let sumR = 0, sumG = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (r > 130 && r - b > 40 && r >= g && b < 150) { sumR += r; sumG += g; n++; }
    }
    if (n < 20) return 'unknown';
    return sumG / sumR < 0.55 ? 'red' : 'orange';
  }

  // ─── OCR: bonus "+NN" (upper-third white text) ─────────────────────────────
  private async ocrBonus(
    worker: Awaited<ReturnType<typeof createWorker>>,
    canon: HTMLCanvasElement,
  ): Promise<number> {
    const cx = canon.getContext('2d', { willReadFrequently: true })!;
    const rd = cx.getImageData(R_BONUS.x, R_BONUS.y, R_BONUS.w, R_BONUS.h);
    const isWhite = (r: number, g: number, b: number) =>
      r > 215 && g > 215 && b > 215;
    const bbox = this.findTextBBox(rd.data, R_BONUS.w, R_BONUS.h, isWhite);
    if (!bbox) return 0;
    const crop = this.buildOcrCrop(canon, R_BONUS, bbox, 6, isWhite);
    const { data: { text } } = await worker.recognize(crop);
    const m = text.replace(/\s/g, '').match(/\+?(\d+)/);
    if (!m) return 0;
    let v = parseInt(m[1], 10);
    if (v > 100) {
      // Tesseract very occasionally adds a spurious leading "1". Try trimming.
      const trimmed = parseInt(m[1].slice(1), 10);
      v = (trimmed > 0 && trimmed <= 100) ? trimmed : 100;
    }
    return v;
  }

  // ─── OCR: mastery "Lv.NN" (bottom yellow text) ────────────────────────────
  // Strategy:
  //   1. PSM 7 first (fast path).
  //   2. If the result violates the colour rule (red ⇒ ≥ 10), try fallback
  //      PSMs and pick the most-voted valid candidate.
  //   3. If still nothing valid for a red card, floor to 10 — the in-game rule
  //      guarantees red gear is at least Lv.10, so reporting 0 is wrong by
  //      construction. The user can always edit afterwards.
  private async ocrMastery(
    worker: Awaited<ReturnType<typeof createWorker>>,
    canon: HTMLCanvasElement,
    color: 'red' | 'orange' | 'unknown',
  ): Promise<number> {
    const cx = canon.getContext('2d', { willReadFrequently: true })!;
    const rd = cx.getImageData(R_MASTERY.x, R_MASTERY.y, R_MASTERY.w, R_MASTERY.h);
    const isYellow = (r: number, g: number, b: number) =>
      r > 180 && g > 150 && b < 130 && r - b > 60;
    const isValid = (v: number) => v > 0 && (color !== 'red' || v >= 10);
    const redFloor = (v: number) => (color === 'red' && v < 10 ? 10 : v);

    const bbox = this.findTextBBox(rd.data, R_MASTERY.w, R_MASTERY.h, isYellow);
    if (!bbox) return color === 'red' ? 10 : 0;
    const crop = this.buildOcrCrop(canon, R_MASTERY, bbox, 6, isYellow);

    // Fast path: single PSM 7 read (worker is already configured for it).
    const first = this.parseMasteryText((await worker.recognize(crop)).data.text);
    if (isValid(first)) return first;

    // Fallback: vote across other PSMs, prefer valid candidates.
    const votes = new Map<number, number>();
    if (first > 0) votes.set(first, 1);
    for (const psm of ['8', '13', '6']) {
      await worker.setParameters({ tessedit_pageseg_mode: psm as any });
      const v = this.parseMasteryText((await worker.recognize(crop)).data.text);
      if (v > 0) votes.set(v, (votes.get(v) ?? 0) + 1);
    }
    // Restore default PSM for the next card.
    await worker.setParameters({ tessedit_pageseg_mode: '7' as any });

    let bestV = 0, bestCount = 0;
    for (const [v, c] of votes) {
      if (!isValid(v)) continue;
      if (c > bestCount || (c === bestCount && v > bestV)) {
        bestV = v; bestCount = c;
      }
    }
    if (bestV > 0) return bestV;
    return redFloor(first);
  }

  private parseMasteryText(text: string): number {
    if (!text) return 0;
    const t = text.replace(/\s/g, '');
    const m = t.match(/(?:Lv\.?|v\.?|L\.?|\.|^)(\d+)/i);
    let digits = m ? m[1] : (t.match(/\d+/g)?.pop() ?? '');
    if (!digits) return 0;
    // Tesseract sometimes glues the "L" onto the leading digit as "1".
    if (digits.length === 3 && digits[0] === '1') digits = digits.slice(1);
    let v = parseInt(digits, 10);
    // Hard cap: in-game mastery max is 20.  Any OCR read above that is noise.
    if (v > 20) return 0;
    return v;
  }

  // ─── OCR crop helpers ──────────────────────────────────────────────────────
  /**
   * Find the tight bounding box of text-coloured pixels inside a region. The
   * upper-third bonus label has exactly one text band; the mastery label
   * similarly has a single band between the hero avatar and the pill edge.
   */
  private findTextBBox(
    data: Uint8ClampedArray,
    w: number,
    h: number,
    isText: (r: number, g: number, b: number) => boolean,
  ): { minX: number; minY: number; maxX: number; maxY: number } | null {
    let minX = w, maxX = -1, minY = h, maxY = -1, count = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (isText(data[i], data[i + 1], data[i + 2])) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          count++;
        }
      }
    }
    if (count < 20 || maxX - minX < 6 || maxY - minY < 4) return null;
    return { minX, minY, maxX, maxY };
  }

  /** Build an upscaled binary (black text on white) crop for Tesseract. */
  private buildOcrCrop(
    canon: HTMLCanvasElement,
    region: { x: number; y: number; w: number; h: number },
    bbox: { minX: number; minY: number; maxX: number; maxY: number },
    scale: number,
    isText: (r: number, g: number, b: number) => boolean,
  ): HTMLCanvasElement {
    const pad = 4;
    const sx = region.x + Math.max(0, bbox.minX - pad);
    const sy = region.y + Math.max(0, bbox.minY - pad);
    const sw = Math.min(region.w - (bbox.minX - pad), (bbox.maxX - bbox.minX) + 2 * pad);
    const sh = Math.min(region.h - (bbox.minY - pad), (bbox.maxY - bbox.minY) + 2 * pad);
    const out = document.createElement('canvas');
    out.width = Math.max(1, sw) * scale;
    out.height = Math.max(1, sh) * scale;
    const oc = out.getContext('2d', { willReadFrequently: true })!;
    oc.imageSmoothingEnabled = true;
    oc.drawImage(canon, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const id = oc.getImageData(0, 0, out.width, out.height);
    for (let i = 0; i < id.data.length; i += 4) {
      const r = id.data[i], g = id.data[i + 1], b = id.data[i + 2];
      const v = isText(r, g, b) ? 0 : 255;
      id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
      id.data[i + 3] = 255;
    }
    oc.putImageData(id, 0, 0);
    return out;
  }
}
