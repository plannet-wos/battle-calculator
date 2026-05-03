// Node debug for the new CANONICAL gear-scan pipeline.
// Mirrors src/app/core/services/gear-scan.service.ts exactly:
//   1. detect rarity-frame blobs
//   2. canonicalise each card into a fixed 220x240 bitmap
//   3. classify troop (badge NCC) and piece (icon NCC)
//   4. detect rarity colour
//   5. extract + threshold BONUS and MASTERY sub-regions for OCR
//   6. dump per-card debug PNGs under scripts/debug-crops/canon/
//
// Run:  node scripts/debug-scan-canonical.mjs [path/to/test-fullboxN.jpg ...]
import { loadImage, createCanvas } from 'canvas';
import fs from 'node:fs';
import path from 'node:path';

const PIECES = ['head', 'gloves', 'belt', 'shoes'];
const PIECE_VARIANTS = {
  head:   ['a', 'b', 'c', 'd'],
  gloves: ['a', 'b', 'c', 'd'],
  belt:   ['a', 'b', 'c', 'd'],
  shoes:  ['a', 'b', 'c', 'd', 'e'],
};
const TROOPS = ['Infantry', 'Marksman', 'Lancer'];

const CANON_W = 220, CANON_H = 240;
const SRC_PAD_L = 0.08, SRC_PAD_T = 0.18, SRC_PAD_R = 0.05, SRC_PAD_B = 0.05;
const R_BADGE   = { x:  10, y:  25, w:  55, h:  55 };
const R_BONUS   = { x:  80, y:  35, w: 140, h:  60 };
const R_ICON    = { x:  20, y:  50, w: 180, h: 135 };
const R_MASTERY = { x:  30, y: 180, w: 190, h:  55 };

const BADGE_W = 64, BADGE_H = 64;
const ICON_TMPL_W = 128, ICON_TMPL_H = 64;

const IMAGES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'public/test-fullbox1.jpg',
      'public/test-fullbox2.png',
      'public/test-fullbox3.jpg',
      'public/test-fullbox4.png',
      'public/test-fullbox5.png',
      'public/test-fullbox6.jpg',
      'public/test-fullbox7.png',
    ];

// ─── card detection ──────────────────────────────────────────────────────────
function buildFrameMask(data, w, h) {
  const m = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > 130 && r > g + 20 && r > b + 30 && b < 140) m[p] = 1;
  }
  return m;
}
function dilate(mask, w, h, radius) {
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
function labelComponents(mask, w, h) {
  const labels = new Int32Array(w * h);
  const parent = [0];
  let next = 1;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
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
  const boxes = new Map();
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
function filterCardBlobs(boxes, imgW) {
  const cand = [];
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
function detectCardFrames(imgData, w, h) {
  let mask = buildFrameMask(imgData.data, w, h);
  mask = dilate(mask, w, h, Math.max(3, Math.round(w * 0.008)));
  const boxes = labelComponents(mask, w, h);
  const frames = filterCardBlobs(boxes, w);
  frames.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return frames;
}

// ─── canonicalise ────────────────────────────────────────────────────────────
function canonicalize(srcCanvas, f) {
  const c = createCanvas(CANON_W, CANON_H);
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = true;
  const sx = f.x - f.w * SRC_PAD_L;
  const sy = f.y - f.h * SRC_PAD_T;
  const sw = f.w * (1 + SRC_PAD_L + SRC_PAD_R);
  const sh = f.h * (1 + SRC_PAD_T + SRC_PAD_B);
  cx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, CANON_W, CANON_H);
  return c;
}

// ─── normalisation + template loaders ────────────────────────────────────────
function normalize(arr) {
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
function toMaskedGrayNorm(data, n) {
  // Mask out everything that isn't the gear item itself:
  //   • warm rarity-backdrop (red or orange panel)
  //   • near-white pixels (the "+NN" bonus label)
  //   • saturated greens (the enhance-arrow icon)
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
  return normalize(gray);
}
async function loadBadgeTemplates() {
  const files = { Infantry: 'infantry.png', Marksman: 'marksman.png', Lancer: 'lancer.png' };
  const n = BADGE_W * BADGE_H;
  const grays = {};
  for (const t of TROOPS) {
    const img = await loadImage(path.join('public/badge-templates', files[t]));
    const c = createCanvas(BADGE_W, BADGE_H);
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0, BADGE_W, BADGE_H);
    const d = cx.getImageData(0, 0, BADGE_W, BADGE_H).data;
    const g = new Float32Array(n);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    grays[t] = g;
  }
  const mean = new Float32Array(n);
  for (const t of TROOPS) for (let j = 0; j < n; j++) mean[j] += grays[t][j];
  for (let j = 0; j < n; j++) mean[j] /= TROOPS.length;
  const map = new Map();
  for (const t of TROOPS) {
    const diff = new Float32Array(n);
    for (let j = 0; j < n; j++) diff[j] = grays[t][j] - mean[j];
    map.set(t, normalize(diff));
  }
  return map;
}
async function loadPieceTemplates() {
  const map = new Map();
  for (const piece of PIECES) {
    const arr = [];
    for (const v of PIECE_VARIANTS[piece]) {
      const p = path.join('public/gear-templates', `piece_${piece}_${v}.png`);
      if (!fs.existsSync(p)) continue;
      const img = await loadImage(p);
      const c = createCanvas(ICON_TMPL_W, ICON_TMPL_H);
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = true;
      cx.drawImage(img, 0, 0, ICON_TMPL_W, ICON_TMPL_H);
      arr.push(toMaskedGrayNorm(cx.getImageData(0, 0, ICON_TMPL_W, ICON_TMPL_H).data, ICON_TMPL_W * ICON_TMPL_H));
    }
    map.set(piece, arr);
  }
  return map;
}

// ─── classifiers ─────────────────────────────────────────────────────────────
function classifyTroop(canon, badges) {
  const tc = createCanvas(BADGE_W, BADGE_H);
  const tcx = tc.getContext('2d');
  tcx.imageSmoothingEnabled = true;
  const n = BADGE_W * BADGE_H;
  const g = new Float32Array(n);
  const scores = { Infantry: -Infinity, Marksman: -Infinity, Lancer: -Infinity };
  let best = null, bestScore = -Infinity;
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
        const gn = normalize(Float32Array.from(g));
        for (const t of TROOPS) {
          const tg = badges.get(t);
          let score = 0;
          for (let i = 0; i < n; i++) score += gn[i] * tg[i];
          score /= n;
          if (score > scores[t]) scores[t] = score;
          if (score > bestScore) { bestScore = score; best = t; }
        }
      }
    }
  }
  if (bestScore < 0.08) return { type: null, scores };
  return { type: best, scores };
}
function classifyPiece(canon, pieces) {
  const c = createCanvas(ICON_TMPL_W, ICON_TMPL_H);
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = true;
  cx.drawImage(canon, R_ICON.x, R_ICON.y, R_ICON.w, R_ICON.h, 0, 0, ICON_TMPL_W, ICON_TMPL_H);
  const cardG = toMaskedGrayNorm(cx.getImageData(0, 0, ICON_TMPL_W, ICON_TMPL_H).data, ICON_TMPL_W * ICON_TMPL_H);
  const scores = {};
  let bestPiece = 'head', bestScore = -Infinity;
  for (const piece of PIECES) {
    let m = -Infinity;
    for (const tg of pieces.get(piece) ?? []) {
      let s = 0;
      for (let i = 0; i < cardG.length; i++) s += cardG[i] * tg[i];
      s /= cardG.length;
      if (s > m) m = s;
    }
    scores[piece] = m;
    if (m > bestScore) { bestScore = m; bestPiece = piece; }
  }
  return { piece: bestPiece, scores, iconCrop: c };
}
function detectColor(canon) {
  const cx = canon.getContext('2d');
  const d = cx.getImageData(100, 55, 110, 20).data;
  let sumR = 0, sumG = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r > 130 && r - b > 40 && r >= g && b < 150) { sumR += r; sumG += g; n++; }
  }
  if (n < 20) return { color: 'unknown', ratio: 0 };
  const ratio = sumG / sumR;
  return { color: ratio < 0.55 ? 'red' : 'orange', ratio };
}

// ─── sub-region text extraction (for visual OCR sanity) ──────────────────────
function findTextBBox(data, w, h, isText) {
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
  return { minX, minY, maxX, maxY, count };
}
function buildBinaryCrop(canon, region, bbox, scale, isText) {
  const pad = 4;
  const sx = region.x + Math.max(0, bbox.minX - pad);
  const sy = region.y + Math.max(0, bbox.minY - pad);
  const sw = Math.min(region.w - (bbox.minX - pad), (bbox.maxX - bbox.minX) + 2 * pad);
  const sh = Math.min(region.h - (bbox.minY - pad), (bbox.maxY - bbox.minY) + 2 * pad);
  const out = createCanvas(Math.max(1, sw) * scale, Math.max(1, sh) * scale);
  const oc = out.getContext('2d');
  oc.imageSmoothingEnabled = true;
  oc.drawImage(canon, sx, sy, sw, sh, 0, 0, out.width, out.height);
  const id = oc.getImageData(0, 0, out.width, out.height);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = isText(id.data[i], id.data[i + 1], id.data[i + 2]) ? 0 : 255;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  oc.putImageData(id, 0, 0);
  return out;
}

// ─── main loop ───────────────────────────────────────────────────────────────
(async () => {
  const badges = await loadBadgeTemplates();
  const pieces = await loadPieceTemplates();
  const outDir = 'scripts/debug-crops/canon';
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const imgPath of IMAGES) {
    if (!fs.existsSync(imgPath)) { console.log(`\n--- ${imgPath} MISSING ---`); continue; }
    console.log(`\n=== ${imgPath} ===`);
    const img = await loadImage(imgPath);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, img.width, img.height);
    const frames = detectCardFrames(imgData, img.width, img.height);
    console.log(`  ${frames.length} frames`);
    const base = path.basename(imgPath, path.extname(imgPath));
    const results = [];
    let i = 0;
    for (const f of frames) {
      i++;
      const canon = canonicalize(canvas, f);
      const { type, scores: tScores } = classifyTroop(canon, badges);
      if (!type) {
        fs.writeFileSync(`${outDir}/${base}_${String(i).padStart(2, '0')}_NOBADGE.png`, canon.toBuffer('image/png'));
        continue;
      }
      const { color, ratio } = detectColor(canon);
      const { piece, scores: pScores, iconCrop } = classifyPiece(canon, pieces);

      // Bonus region (white)
      const bonusRegionCtx = canon.getContext('2d');
      const bonusImg = bonusRegionCtx.getImageData(R_BONUS.x, R_BONUS.y, R_BONUS.w, R_BONUS.h);
      const isWhite = (r, g, b) => r > 215 && g > 215 && b > 215;
      const bonusBBox = findTextBBox(bonusImg.data, R_BONUS.w, R_BONUS.h, isWhite);
      const bonusCrop = bonusBBox ? buildBinaryCrop(canon, R_BONUS, bonusBBox, 6, isWhite) : null;

      // Mastery region (yellow)
      const masteryImg = bonusRegionCtx.getImageData(R_MASTERY.x, R_MASTERY.y, R_MASTERY.w, R_MASTERY.h);
      const isYellow = (r, g, b) => r > 180 && g > 150 && b < 130 && r - b > 60;
      const masteryBBox = findTextBBox(masteryImg.data, R_MASTERY.w, R_MASTERY.h, isYellow);
      const masteryCrop = masteryBBox ? buildBinaryCrop(canon, R_MASTERY, masteryBBox, 6, isYellow) : null;

      const tag = `${type[0]}_${piece[0]}_${color[0]}`;
      const nameBase = `${base}_${String(i).padStart(2, '0')}_${tag}`;
      fs.writeFileSync(`${outDir}/${nameBase}_canon.png`, canon.toBuffer('image/png'));
      fs.writeFileSync(`${outDir}/${nameBase}_icon.png`, iconCrop.toBuffer('image/png'));
      if (bonusCrop) fs.writeFileSync(`${outDir}/${nameBase}_bonus.png`, bonusCrop.toBuffer('image/png'));
      if (masteryCrop) fs.writeFileSync(`${outDir}/${nameBase}_mastery.png`, masteryCrop.toBuffer('image/png'));

      const pStr = Object.entries(pScores).map(([p, s]) => `${p[0]}:${s.toFixed(3)}`).join(' ');
      const tStr = Object.entries(tScores).map(([t, s]) => `${t[0]}:${s.toFixed(2)}`).join(' ');
      console.log(
        `  #${String(i).padStart(2)} ${type.padEnd(8)} ${color.padEnd(7)} → ${piece.padEnd(6)} ` +
        `bonusPx=${bonusBBox?.count ?? 0} masterPx=${masteryBBox?.count ?? 0} [${pStr}] <${tStr}>`,
      );
      results.push({ type, color, piece });
    }

    // Dedup summary
    const rank = (it) => (it.color === 'red' ? 1000 : it.color === 'orange' ? 500 : 0);
    console.log('  --- dedup ---');
    for (const type of ['Infantry', 'Lancer', 'Marksman']) {
      const slots = {};
      for (const r of results) {
        if (r.type !== type) continue;
        if (!slots[r.piece] || rank(r) > rank(slots[r.piece])) slots[r.piece] = r;
      }
      const filled = PIECES.map(p => slots[p] ? `${p}(${slots[p].color})` : `${p}-MISSING`);
      console.log(`  ${type.padEnd(8)}: ${filled.join(' | ')}`);
    }
  }
})();
