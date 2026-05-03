// Verify the new detectTroopLevels() pipeline mirrors what the service does.
// Run: node scripts/debug-troop-verify.mjs public/test-battlereport5.jpg

import { createCanvas, loadImage } from 'canvas';
import { writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createWorker } from 'tesseract.js';

const inFile = process.argv[2] ?? 'public/test-battlereport5.jpg';
const img = await loadImage(inFile);
const W = img.width, H = img.height;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
ctx.drawImage(img, 0, 0);
const data = ctx.getImageData(0, 0, W, H).data;

// Stat row bands
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
    if (isStatText(data[i], data[i+1], data[i+2])) n++;
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

// Header band (luminance dip)
const hx0 = Math.round(W * 0.20), hx1 = Math.round(W * 0.80);
const rowLuma = (y) => {
  let s = 0, n = 0;
  for (let x = hx0; x < hx1; x += 4) {
    const i = (y * W + x) * 4;
    s += (data[i] + data[i+1] + data[i+2]) / 3; n++;
  }
  return s / n;
};
let bgSum = 0, bgN = 0;
for (let y = Math.max(0, firstStatY - 18); y < firstStatY - 2; y++) { bgSum += rowLuma(y); bgN++; }
const darkThr = (bgSum / bgN) - 20;
const searchTop = Math.max(0, firstStatY - 250);
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

// Mirror new detectTroopLevels()
const halfW = Math.round(W / 2);
const fullH = headerTop - 4;
const labelTop = Math.max(0, fullH - Math.round(fullH * 0.35));
const labelH = fullH - labelTop;
const SCALE = 3;
const strip = createCanvas(halfW * SCALE, labelH * SCALE);
const sctx = strip.getContext('2d');
sctx.imageSmoothingEnabled = false;
sctx.drawImage(canvas, 0, labelTop, halfW, labelH, 0, 0, halfW * SCALE, labelH * SCALE);
const id = sctx.getImageData(0, 0, strip.width, strip.height);
const dd = id.data;
for (let i = 0; i < dd.length; i += 4) {
  const lum = (dd[i] + dd[i+1] + dd[i+2]) / 3;
  const v = lum > 180 ? 0 : 255;
  dd[i] = dd[i+1] = dd[i+2] = v;
  dd[i+3] = 255;
}
sctx.putImageData(id, 0, 0);

const baseName = basename(inFile, '.jpg').replace(/\.png$/, '');
const stripFile = join(dirname(inFile), `${baseName}.troop-final.png`);
writeFileSync(stripFile, strip.toBuffer('image/png'));
console.log(`wrote: ${stripFile}  (${strip.width}×${strip.height})`);

const worker = await createWorker('eng', 1);
await worker.setParameters({
  tessedit_char_whitelist: 'Lv.0123456789',
  tessedit_pageseg_mode: '11',
});
const r = await worker.recognize(stripFile);
console.log('text:', JSON.stringify(r.data.text));
const words = r.data.words ?? [];
console.log(`words.length = ${words.length}`);
for (const w of words) console.log(`  word: "${w.text}"`);

const tierPattern = /^(?:L?v\.?)?(\d{1,2})\.0$/i;
const tiers = [];
for (const w of words) {
  const t = w.text.replace(/[\s,]/g, '');
  const m = t.match(tierPattern);
  if (m) {
    const v = parseInt(m[1], 10);
    if (v >= 1 && v <= 11) {
      tiers.push({ x: (w.bbox.x0 + w.bbox.x1) / 2, value: v });
    }
  }
}
console.log('tier matches:', tiers);
tiers.sort((a, b) => a.x - b.x);
console.log('via words: inf=', tiers[0]?.value, 'lanc=', tiers[1]?.value, 'mark=', tiers[2]?.value);

// Text fallback (this is what the production service hits when words is empty)
const fallbackNums = [...r.data.text.matchAll(/(?:L?v\.?\s*)?(\d{1,2})\.0(?!\d)/gi)]
  .map(m => parseInt(m[1], 10))
  .filter(v => v >= 1 && v <= 11);
console.log('via text fallback:', fallbackNums);

// FC OCR — uses the SAME preprocessed canvas
console.log('\n── FC OCR on the same (thresholded) canvas ──');
await worker.setParameters({
  tessedit_char_whitelist: '12345',
  tessedit_pageseg_mode: '11',
});
const fcr = await worker.recognize(stripFile);
console.log('text:', JSON.stringify(fcr.data.text));

// Try FC on the RAW (not thresholded) canvas
const stripRaw = createCanvas(halfW * SCALE, labelH * SCALE);
const sctxR = stripRaw.getContext('2d');
sctxR.imageSmoothingEnabled = false;
sctxR.drawImage(canvas, 0, labelTop, halfW, labelH, 0, 0, halfW * SCALE, labelH * SCALE);
const stripRawFile = join(dirname(inFile), `${baseName}.troop-raw.png`);
writeFileSync(stripRawFile, stripRaw.toBuffer('image/png'));

console.log('\n── FC OCR on RAW (unthresholded) bottom-35% crop ──');
const fcr2 = await worker.recognize(stripRawFile);
console.log('text:', JSON.stringify(fcr2.data.text));

// Try FC on a TIGHT crop of just the icon row (upper portion of bottom-35%)
const iconH = Math.round(labelH * 0.6);
const stripIcon = createCanvas(halfW * SCALE, iconH * SCALE);
const sctxI = stripIcon.getContext('2d');
sctxI.imageSmoothingEnabled = false;
sctxI.drawImage(canvas, 0, labelTop, halfW, iconH, 0, 0, halfW * SCALE, iconH * SCALE);
const stripIconFile = join(dirname(inFile), `${baseName}.troop-icons.png`);
writeFileSync(stripIconFile, stripIcon.toBuffer('image/png'));

console.log('\n── FC OCR on RAW icon-row crop (top 60% of bottom-35%) ──');
const fcr3 = await worker.recognize(stripIconFile);
console.log('text:', JSON.stringify(fcr3.data.text));

await worker.terminate();
