// Visualize what region detectTroopLevels() is currently cropping for
// troop tier / FC OCR. Outputs an annotated PNG next to the input image.
//
// Run:  node scripts/debug-troop-scan.mjs public/test-battlereport1.jpg
//
// Mirrors stats-scan.service.ts:
//   • find 12 stat rows by red/green pixel bands in left ~33%
//   • find the dark "Stat Bonuses" header band by luminance dip
//   • troop strip = LEFT half × everything above header

import { createCanvas, loadImage } from 'canvas';
import { writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const inFile = process.argv[2] ?? 'public/test-battlereport1.jpg';
const img = await loadImage(inFile);
const W = img.width, H = img.height;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
ctx.drawImage(img, 0, 0);

const imgData = ctx.getImageData(0, 0, W, H);
const data = imgData.data;

const isStatText = (r, g, b) => {
  const isRed   = r > 180 && g < 120 && b < 120 && r - g > 60;
  const isGreen = g > 160 && r < 140 && b < 120 && g - r > 40;
  return isRed || isGreen;
};

// ── stat row detection ─────────────────────────────────────────────────────
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
  } else if (inBand) {
    bands.push({ start: bs, end: y });
    inBand = false;
  }
}
if (inBand) bands.push({ start: bs, end: H });
const statBands = bands.slice(-12);
const firstStatY = statBands[0].start;

// ── header band detection (luminance dip) ──────────────────────────────────
const hx0 = Math.round(W * 0.20);
const hx1 = Math.round(W * 0.80);
const rowLuma = (y) => {
  let sum = 0, n = 0;
  for (let x = hx0; x < hx1; x += 4) {
    const i = (y * W + x) * 4;
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    n++;
  }
  return n > 0 ? sum / n : 255;
};

const searchTop = Math.max(0, firstStatY - 250);
let bgSum = 0, bgN = 0;
for (let y = Math.max(0, firstStatY - 18); y < Math.max(0, firstStatY - 2); y++) {
  bgSum += rowLuma(y); bgN++;
}
const bgLuma  = bgN > 0 ? bgSum / bgN : 240;
const darkThr = bgLuma - 20;

let darkBottom = -1, run = 0;
for (let y = firstStatY - 4; y >= searchTop; y--) {
  if (rowLuma(y) < darkThr) {
    if (darkBottom < 0) darkBottom = y;
    run++;
    if (run >= 6) break;
  } else {
    darkBottom = -1;
    run = 0;
  }
}
let headerTop = firstStatY;
let headerBottom = firstStatY;
if (darkBottom >= 0) {
  headerBottom = darkBottom;
  headerTop = darkBottom;
  for (let y = darkBottom - 1; y >= searchTop; y--) {
    if (rowLuma(y) < darkThr) headerTop = y;
    else break;
  }
}

// ── troop strip = left half × everything above headerTop ───────────────────
const halfW   = Math.round(W / 2);
const stripH  = headerTop - 4;
// Tier crop: bottom 35% of the strip (matches detectTroopLevels)
const labelTop = Math.max(0, stripH - Math.round(stripH * 0.35));
const labelH   = stripH - labelTop;

console.log(`image:        ${W}×${H}`);
console.log(`firstStatY:   ${firstStatY}`);
console.log(`bgLuma:       ${bgLuma.toFixed(1)}  darkThr: ${darkThr.toFixed(1)}`);
console.log(`headerBand:   y=[${headerTop}..${headerBottom}]`);
console.log(`full strip:   x=[0..${halfW}]  y=[0..${stripH}]  (${halfW}×${stripH})`);
console.log(`tier crop:    x=[0..${halfW}]  y=[${labelTop}..${stripH}]  (${halfW}×${labelH})`);
console.log(`FC crop:      same as tier crop  ← BUG: FC badges are above this region`);

// full strip — light green outline only
ctx.lineWidth = 4;
ctx.strokeStyle = 'rgba(0, 180, 0, 0.7)';
ctx.strokeRect(0, 0, halfW, stripH);
ctx.fillStyle = 'rgb(0, 140, 0)';
ctx.font = 'bold 22px sans-serif';
ctx.fillText(`full troop strip (${halfW}×${stripH})`, 16, 26);

// tier crop — solid green fill (current tier OCR region = also current FC OCR region)
ctx.fillStyle = 'rgba(0, 220, 0, 0.30)';
ctx.fillRect(0, labelTop, halfW, labelH);
ctx.lineWidth = 6;
ctx.strokeStyle = 'rgba(0, 180, 0, 1)';
ctx.strokeRect(0, labelTop, halfW, labelH);
ctx.fillStyle = 'rgb(0, 140, 0)';
ctx.font = 'bold 28px sans-serif';
ctx.fillText(`tier + FC OCR region`, 16, labelTop + 32);

// header band — orange
ctx.lineWidth = 4;
ctx.strokeStyle = 'rgba(255, 140, 0, 1)';
ctx.fillStyle   = 'rgba(255, 140, 0, 0.30)';
ctx.fillRect(0, headerTop, W, headerBottom - headerTop + 1);
ctx.strokeRect(0, headerTop, W, headerBottom - headerTop + 1);
ctx.fillStyle = 'rgb(200, 90, 0)';
ctx.fillText(`header band  y=[${headerTop}..${headerBottom}]`, 16, headerTop - 8);

// stat table top — blue line
ctx.strokeStyle = 'rgba(0, 100, 255, 0.95)';
ctx.lineWidth = 3;
ctx.beginPath();
ctx.moveTo(0, firstStatY);
ctx.lineTo(W, firstStatY);
ctx.stroke();
ctx.fillStyle = 'rgba(0, 100, 255, 0.95)';
ctx.fillText(`first stat row y=${firstStatY}`, 16, firstStatY + 28);

const outFile = join(dirname(inFile), basename(inFile, '.jpg').replace(/\.png$/, '') + '.scan-debug.png');
writeFileSync(outFile, canvas.toBuffer('image/png'));
console.log(`wrote: ${outFile}`);
