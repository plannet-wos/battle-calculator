// Color-based FC badge detection: find bright-red blobs in the troop strip,
// crop each one, and OCR the single digit inside.
//
// Run: node scripts/debug-fc-color.mjs public/test-battlereport3.jpg

import { createCanvas, loadImage } from 'canvas';
import { writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createWorker } from 'tesseract.js';

const inFile = process.argv[2] ?? 'public/test-battlereport3.jpg';
const img = await loadImage(inFile);
const W = img.width, H = img.height;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
ctx.drawImage(img, 0, 0);
const data = ctx.getImageData(0, 0, W, H).data;

// ─── stat row + header detection (mirrors the service) ────────────────────
const isStatText = (r, g, b) => {
  const isRed   = r > 180 && g < 120 && b < 120 && r - g > 60;
  const isGreen = g > 160 && r < 140 && b < 120 && g - r > 40;
  return isRed || isGreen;
};
const lx0 = Math.round(W * 0.04), lx1 = Math.round(W * 0.33);
const rowRed = new Int32Array(H);
for (let y = 0; y < H; y++) {
  let n = 0;
  for (let x = lx0; x < lx1; x += 2) {
    const i = (y * W + x) * 4;
    if (isStatText(data[i], data[i + 1], data[i + 2])) n++;
  }
  rowRed[y] = n;
}
const sm = new Float32Array(H);
for (let y = 0; y < H; y++) {
  let s = 0, n = 0;
  for (let yy = Math.max(0, y - 3); yy <= Math.min(H - 1, y + 3); yy++) {
    s += rowRed[yy]; n++;
  }
  sm[y] = s / n;
}
const bands = [];
let inB = false, bs = 0;
for (let y = 0; y < H; y++) {
  if (sm[y] >= 5) { if (!inB) { inB = true; bs = y; } }
  else if (inB) { bands.push({ start: bs, end: y }); inB = false; }
}
const firstStatY = bands.slice(-12)[0].start;

const hx0 = Math.round(W * 0.20), hx1 = Math.round(W * 0.80);
const rowLuma = (y) => {
  let s = 0, n = 0;
  for (let x = hx0; x < hx1; x += 4) {
    const i = (y * W + x) * 4;
    s += (data[i] + data[i + 1] + data[i + 2]) / 3; n++;
  }
  return s / n;
};
const searchTop = Math.max(0, firstStatY - 250);
let bgSum = 0, bgN = 0;
for (let y = Math.max(0, firstStatY - 18); y < firstStatY - 2; y++) { bgSum += rowLuma(y); bgN++; }
const darkThr = (bgSum / bgN) - 20;
let darkBottom = -1, run = 0;
for (let y = firstStatY - 4; y >= searchTop; y--) {
  if (rowLuma(y) < darkThr) { if (darkBottom < 0) darkBottom = y; run++; if (run >= 6) break; }
  else { darkBottom = -1; run = 0; }
}
let headerTop = firstStatY;
if (darkBottom >= 0) {
  headerTop = darkBottom;
  for (let y = darkBottom - 1; y >= searchTop; y--) {
    if (rowLuma(y) < darkThr) headerTop = y; else break;
  }
}

const halfW = Math.round(W / 2);
const stripH = headerTop - 4;
// Search the bottom 35% (where the icons are)
const searchY0 = Math.max(0, stripH - Math.round(stripH * 0.35));
const searchY1 = stripH;

console.log(`image:        ${W}×${H}`);
console.log(`stripH:       ${stripH}`);
console.log(`search area:  x=[0..${halfW}]  y=[${searchY0}..${searchY1}]`);

// ─── find bright-red pixels in the search area ────────────────────────────
const isBrightRed = (r, g, b) => r > 170 && g < 90 && b < 90 && r - g > 80 && r - b > 80;

const sw = halfW;
const sh = searchY1 - searchY0;
const mask = new Uint8Array(sw * sh);
for (let y = 0; y < sh; y++) {
  for (let x = 0; x < sw; x++) {
    const i = ((y + searchY0) * W + x) * 4;
    if (isBrightRed(data[i], data[i + 1], data[i + 2])) {
      mask[y * sw + x] = 1;
    }
  }
}

// ─── connected-component blob extraction (4-connected flood) ──────────────
const labels = new Int32Array(sw * sh);
let nextLabel = 1;
const blobs = []; // {label, minX, minY, maxX, maxY, count}
const stack = [];
for (let y = 0; y < sh; y++) {
  for (let x = 0; x < sw; x++) {
    const idx = y * sw + x;
    if (mask[idx] && labels[idx] === 0) {
      const lbl = nextLabel++;
      stack.length = 0;
      stack.push(idx);
      const blob = { label: lbl, minX: x, minY: y, maxX: x, maxY: y, count: 0 };
      while (stack.length) {
        const p = stack.pop();
        if (labels[p] !== 0) continue;
        labels[p] = lbl;
        blob.count++;
        const px = p % sw, py = (p - px) / sw;
        if (px < blob.minX) blob.minX = px;
        if (py < blob.minY) blob.minY = py;
        if (px > blob.maxX) blob.maxX = px;
        if (py > blob.maxY) blob.maxY = py;
        if (px > 0      && mask[p - 1]  && labels[p - 1]  === 0) stack.push(p - 1);
        if (px < sw - 1 && mask[p + 1]  && labels[p + 1]  === 0) stack.push(p + 1);
        if (py > 0      && mask[p - sw] && labels[p - sw] === 0) stack.push(p - sw);
        if (py < sh - 1 && mask[p + sw] && labels[p + sw] === 0) stack.push(p + sw);
      }
      blobs.push(blob);
    }
  }
}

// Filter: badges are small but solid (not single stray pixels). Keep top by
// size, then sort by x position to assign to inf/lanc/mark.
const candidates = blobs
  .filter(b => b.count >= 30)                // ignore noise
  .filter(b => (b.maxX - b.minX) < 80)       // not a huge red bar
  .filter(b => (b.maxY - b.minY) < 80)
  .sort((a, b) => b.count - a.count)
  .slice(0, 10);

console.log(`found ${blobs.length} red blobs total, ${candidates.length} candidates`);
for (const b of candidates) {
  console.log(`  label=${b.label}  count=${b.count}  bbox=[${b.minX},${b.minY}..${b.maxX},${b.maxY}]  (${b.maxX - b.minX}×${b.maxY - b.minY})`);
}

// Pick top 3 by size, sort by x
const top3 = candidates.slice(0, 3).sort((a, b) => a.minX - b.minX);

// ─── visualize: draw all candidate boxes on the source image ──────────────
ctx.lineWidth = 4;
ctx.font = 'bold 22px sans-serif';
for (let i = 0; i < candidates.length; i++) {
  const b = candidates[i];
  const x = b.minX;
  const y = b.minY + searchY0;
  const w = b.maxX - b.minX + 1;
  const h = b.maxY - b.minY + 1;
  const isTop3 = top3.includes(b);
  ctx.strokeStyle = isTop3 ? 'rgba(0, 200, 255, 1)' : 'rgba(255, 200, 0, 0.8)';
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = isTop3 ? 'cyan' : 'orange';
  ctx.fillText(`${b.count}`, x + w + 4, y + 18);
}
ctx.strokeStyle = 'rgba(0, 180, 0, 0.7)';
ctx.lineWidth = 3;
ctx.strokeRect(0, searchY0, halfW, sh);

const baseName = basename(inFile, '.jpg').replace(/\.png$/, '');
const debugFile = join(dirname(inFile), `${baseName}.fc-debug.png`);
writeFileSync(debugFile, canvas.toBuffer('image/png'));
console.log(`wrote: ${debugFile}`);

// ─── crop each top-3 badge, INNER crop only (avoid shield outline), OCR ──
const worker = await createWorker('eng', 1);

const SCALE = 6;
// NEGATIVE pad: shrink the bbox inward to drop the shield outline noise.
const INSET = 0.18;
const PSMS = ['10', '8', '7', '13', '6'];

const fcResults = [];
for (let i = 0; i < top3.length; i++) {
  const b = top3[i];
  const bw = b.maxX - b.minX + 1;
  const bh = b.maxY - b.minY + 1;
  const insetX = Math.round(bw * INSET);
  const insetY = Math.round(bh * INSET);
  const cx = b.minX + insetX;
  const cy = b.minY + searchY0 + insetY;
  const cw = bw - insetX * 2;
  const ch = bh - insetY * 2;
  const crop = createCanvas(cw * SCALE, ch * SCALE);
  const cctx = crop.getContext('2d');
  cctx.imageSmoothingEnabled = false;
  cctx.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw * SCALE, ch * SCALE);

  // White digit inside red shield → bright pixels become black foreground.
  const cid = cctx.getImageData(0, 0, crop.width, crop.height);
  const cd = cid.data;
  for (let p = 0; p < cd.length; p += 4) {
    const lum = (cd[p] + cd[p + 1] + cd[p + 2]) / 3;
    const v = lum > 180 ? 0 : 255;
    cd[p] = cd[p + 1] = cd[p + 2] = v;
    cd[p + 3] = 255;
  }
  cctx.putImageData(cid, 0, 0);

  const cropFile = join(dirname(inFile), `${baseName}.fc-crop-${i}.png`);
  writeFileSync(cropFile, crop.toBuffer('image/png'));

  // Vote across PSMs
  const votes = new Map();
  for (const psm of PSMS) {
    await worker.setParameters({
      tessedit_char_whitelist: '12345',
      tessedit_pageseg_mode: psm,
    });
    const r = await worker.recognize(cropFile);
    const t = r.data.text.replace(/[^12345]/g, '');
    if (t.length === 1) {
      votes.set(t, (votes.get(t) ?? 0) + 1);
    }
  }
  let winner = '', winCount = 0;
  for (const [v, c] of votes) {
    if (c > winCount) { winner = v; winCount = c; }
  }
  console.log(`badge ${i} (x=${b.minX}): votes=${JSON.stringify([...votes.entries()])} → ${winner}`);
  fcResults.push({ x: b.minX, value: winner ? parseInt(winner, 10) : 0 });
}

console.log('\nFC values:', fcResults.map(r => r.value).join(', '));
await worker.terminate();
