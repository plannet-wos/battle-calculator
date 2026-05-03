// Run the same crop + OCR pipeline as detectTroopLevels() in the service
// and dump everything Tesseract sees, plus the regex matches.
//
// Run: node scripts/debug-troop-ocr.mjs public/test-battlereport5.jpg

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

// ─── stat row band detection (mirrors stats-scan.service.ts) ───────────────
const isStatText = (r, g, b) => {
  const isRed   = r > 180 && g < 120 && b < 120 && r - g > 60;
  const isGreen = g > 160 && r < 140 && b < 120 && g - r > 40;
  return isRed || isGreen;
};
const lx0 = Math.round(W * 0.04);
const lx1 = Math.round(W * 0.33);
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
let inBand = false, bs = 0;
for (let y = 0; y < H; y++) {
  if (sm[y] >= 5) {
    if (!inBand) { inBand = true; bs = y; }
  } else if (inBand) { bands.push({ start: bs, end: y }); inBand = false; }
}
if (inBand) bands.push({ start: bs, end: H });
const statBands = bands.slice(-12);
const firstStatY = statBands[0].start;

// ─── header band detection ─────────────────────────────────────────────────
const hx0 = Math.round(W * 0.20);
const hx1 = Math.round(W * 0.80);
const rowLuma = (y) => {
  let s = 0, n = 0;
  for (let x = hx0; x < hx1; x += 4) {
    const i = (y * W + x) * 4;
    s += (data[i] + data[i + 1] + data[i + 2]) / 3;
    n++;
  }
  return s / n;
};
const searchTop = Math.max(0, firstStatY - 250);
let bgSum = 0, bgN = 0;
for (let y = Math.max(0, firstStatY - 18); y < Math.max(0, firstStatY - 2); y++) {
  bgSum += rowLuma(y); bgN++;
}
const bgLuma = bgN ? bgSum / bgN : 240;
const darkThr = bgLuma - 20;
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

// ─── crop the troop strip (left half × above header) ───────────────────────
const halfW = Math.round(W / 2);
const stripH = headerTop - 4;
const strip = createCanvas(halfW, stripH);
strip.getContext('2d').drawImage(canvas, 0, 0, halfW, stripH, 0, 0, halfW, stripH);
const stripFile = join(dirname(inFile), basename(inFile, '.jpg').replace(/\.png$/, '') + '.troop-strip.png');
writeFileSync(stripFile, strip.toBuffer('image/png'));
console.log(`wrote strip: ${stripFile}  (${halfW}×${stripH})`);

// ─── run OCR with same params as the service ──────────────────────────────
const worker = await createWorker('eng', 1);

console.log('\n── TIER OCR (whitelist Lv.0-9, PSM 11) ──');
await worker.setParameters({
  tessedit_char_whitelist: 'Lv.0123456789',
  tessedit_pageseg_mode: '11',
});
const tierRes = await worker.recognize(stripFile);
console.log('text:', JSON.stringify(tierRes.data.text));
const words = tierRes.data.words ?? [];
console.log(`words (${words.length}):`);
for (const w of words) {
  console.log(`  "${w.text}"  bbox=[${w.bbox.x0},${w.bbox.y0}..${w.bbox.x1},${w.bbox.y1}]  conf=${w.confidence?.toFixed(0)}`);
}
console.log('\nregex matches /L?v\\.?(\\d{1,2})/i:');
for (const w of words) {
  const m = w.text.replace(/\s/g, '').match(/L?v\.?(\d{1,2})/i);
  if (m) console.log(`  "${w.text}" → ${m[1]}`);
}

console.log('\n── FC OCR (whitelist 1-5, PSM 11) ──');
await worker.setParameters({
  tessedit_char_whitelist: '12345',
  tessedit_pageseg_mode: '11',
});
const fcRes = await worker.recognize(stripFile);
console.log('text:', JSON.stringify(fcRes.data.text));
const fcWords = fcRes.data.words ?? [];
console.log(`words (${fcWords.length}):`);
for (const w of fcWords) {
  console.log(`  "${w.text}"  bbox=[${w.bbox.x0},${w.bbox.y0}..${w.bbox.x1},${w.bbox.y1}]  conf=${w.confidence?.toFixed(0)}`);
}

await worker.terminate();
