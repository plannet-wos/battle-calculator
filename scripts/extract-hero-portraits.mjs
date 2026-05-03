// One-off bootstrap script: detects the 4-column orange hero card grid in
// a heroes screenshot and crops each portrait to public/hero-templates/.
//
// Usage: node scripts/extract-hero-portraits.mjs public/test-heroes2.png
//
// After running, manually rename slot-r-c.png → <heroname>.png so the
// HeroScanService can match against named references.

import { createCanvas, loadImage } from 'canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const inFile = process.argv[2] ?? 'public/test-heroes2.png';
const outDir = 'public/hero-templates';
mkdirSync(outDir, { recursive: true });

const img = await loadImage(inFile);
const W = img.width, H = img.height;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
ctx.drawImage(img, 0, 0);
const data = ctx.getImageData(0, 0, W, H).data;

// Orange border color: high R, mid G, low B
const isOrange = (r, g, b) =>
  r > 200 && g > 90 && g < 170 && b < 90 && r - b > 120 && r - g > 50;

// Each card is a big connected blob of orange. Flood fill all orange
// pixels and treat each blob ≥ minArea as one card.
const mask = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (isOrange(data[i], data[i+1], data[i+2])) mask[y * W + x] = 1;
  }
}

// DEBUG: dump the mask as a binary png
{
  const dbg = createCanvas(W, H);
  const dctx = dbg.getContext('2d');
  const did = dctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const v = mask[i] ? 255 : 0;
    did.data[i*4] = did.data[i*4+1] = did.data[i*4+2] = v;
    did.data[i*4+3] = 255;
  }
  dctx.putImageData(did, 0, 0);
  writeFileSync('public/test-heroes2.orange-mask.png', dbg.toBuffer('image/png'));
}

// Projection-based grid detection. Card borders connect into one giant
// blob, so flood fill is useless here. Instead we use horizontal /
// vertical projections of the orange mask to find row/column bands.
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

// A row band is a sustained run of rows where rowProj > threshold.
// Card rows have varying orange density (top border vs interior decoration),
// so use a low threshold and merge bands separated by small gaps.
const rowThr = 20;
const colThr = Math.round(H * 0.02);

const findBands = (proj, len, thr, minLen) => {
  const bands = [];
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

const mergeBands = (bands, maxGap) => {
  if (bands.length <= 1) return bands;
  const out = [bands[0]];
  for (let i = 1; i < bands.length; i++) {
    const prev = out[out.length - 1];
    if (bands[i].start - prev.end <= maxGap) prev.end = bands[i].end;
    else out.push(bands[i]);
  }
  return out;
};

let rowBands = findBands(rowProj, H, rowThr, 40);
const colBands = findBands(colProj, W, colThr, 40);

console.log(`row bands (${rowBands.length}):`, rowBands.map(b => `${b.start}-${b.end}`).join(' '));
console.log(`col bands (${colBands.length}):`, colBands.map(b => `${b.start}-${b.end}`).join(' '));

// Keep only the 4 widest column bands (the 4 card columns).
const cols4 = [...colBands]
  .sort((a, b) => (b.end - b.start) - (a.end - a.start))
  .slice(0, 4)
  .sort((a, b) => a.start - b.start);

// The first two rows are usually clean. Use them as an anchor and project
// the rest of the grid from row pitch (start[1] - start[0]) and row height.
// This handles short / noisy bands lower in the image.
let goodRows = rowBands;
if (rowBands.length >= 2) {
  const r0 = rowBands[0];
  const r1 = rowBands[1];
  const pitch = r1.start - r0.start;
  const rowH = r0.end - r0.start;
  goodRows = [];
  for (let i = 0; i < 8; i++) {
    const start = r0.start + i * pitch;
    const end = start + rowH;
    if (end > H) break;
    goodRows.push({ start, end });
  }
}

const medianRowH = goodRows.length ? goodRows[0].end - goodRows[0].start : 0;
console.log(`kept ${cols4.length} columns, ${goodRows.length} rows (row h=${medianRowH})`);

// Build (row × col) card bboxes.
const fullRows = goodRows.map(rb =>
  cols4.map(cb => ({
    x: cb.start,
    y: rb.start,
    w: cb.end - cb.start,
    h: rb.end - rb.start,
  }))
);
for (let i = 0; i < fullRows.length; i++) {
  const r = fullRows[i];
  console.log(`  row ${i}: y=${r[0].y} h=${r[0].h}  cards x=[${r.map(c => c.x).join(',')}]`);
}

// ── Extract portraits ─────────────────────────────────────────────────────
// Portrait sits in the upper ~65% of each card. Inset 8% from each side
// to drop the orange border so the crop is clean art only.
const PORTRAIT_TOP_FRAC    = 0.05;
const PORTRAIT_HEIGHT_FRAC = 0.55;
const PORTRAIT_INSET_FRAC  = 0.08;
const OUT_SIZE = 96;  // square reference size

// Annotated debug overlay
ctx.lineWidth = 4;
ctx.strokeStyle = 'rgba(0, 220, 0, 1)';

let count = 0;
for (let r = 0; r < fullRows.length; r++) {
  const row = fullRows[r];
  for (let c = 0; c < 4; c++) {
    const card = row[c];
    const px = card.x + card.w * PORTRAIT_INSET_FRAC;
    const py = card.y + card.h * PORTRAIT_TOP_FRAC;
    const pw = card.w * (1 - 2 * PORTRAIT_INSET_FRAC);
    const ph = card.h * PORTRAIT_HEIGHT_FRAC;

    // Square crop centered on the portrait
    const side = Math.min(pw, ph);
    const cx = px + (pw - side) / 2;
    const cy = py + (ph - side) / 2;

    const out = createCanvas(OUT_SIZE, OUT_SIZE);
    out.getContext('2d').drawImage(canvas, cx, cy, side, side, 0, 0, OUT_SIZE, OUT_SIZE);
    const outFile = join(outDir, `slot-${r}-${c}.png`);
    writeFileSync(outFile, out.toBuffer('image/png'));
    count++;

    ctx.strokeRect(cx, cy, side, side);
    ctx.fillStyle = 'rgba(0, 220, 0, 1)';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(`r${r}c${c}`, cx + 4, cy + 24);
  }
}
console.log(`wrote ${count} portrait crops to ${outDir}/`);

// Save annotated debug image
const dbgFile = inFile.replace(/\.(png|jpg)$/i, '.hero-grid-debug.png');
writeFileSync(dbgFile, canvas.toBuffer('image/png'));
console.log(`wrote debug overlay: ${dbgFile}`);
