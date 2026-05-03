// Regenerate badge templates from fb1 canonical crops.
// Uses a single representative card per troop (from known-good fb1 frames)
// to build a BADGE_W x BADGE_H grayscale template that matches the canonical
// coordinate space used at classify time.
import { loadImage, createCanvas } from 'canvas';
import fs from 'node:fs';
import path from 'node:path';

const CANON_W = 220, CANON_H = 240;
const SRC_PAD_L = 0.08, SRC_PAD_T = 0.18, SRC_PAD_R = 0.05, SRC_PAD_B = 0.05;
const R_BADGE = { x: 10, y: 25, w: 55, h: 55 };
const BADGE_W = 64, BADGE_H = 64;

// Representative frame → troop mapping from fb1 (verified by eye).
const REPS = {
  Infantry: 2,   // #2 is clearly Infantry (blue shield)
  Marksman: 1,   // #1 is clearly Marksman (arrow badge)
  Lancer:   5,   // #5 is clearly Lancer (lance badge)
};

// Card detection (mirrored from debug-scan-canonical.mjs)
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

(async () => {
  const img = await loadImage('public/test-fullbox1.jpg');
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, img.width, img.height);
  const frames = detectCardFrames(imgData, img.width, img.height);
  console.log(`detected ${frames.length} frames`);

  const outDir = 'public/badge-templates';
  const files = { Infantry: 'infantry.png', Marksman: 'marksman.png', Lancer: 'lancer.png' };

  for (const [troop, idx] of Object.entries(REPS)) {
    const f = frames[idx - 1];
    if (!f) { console.log(`  !! no frame for ${troop} #${idx}`); continue; }
    const canon = canonicalize(canvas, f);

    const out = createCanvas(BADGE_W, BADGE_H);
    const oc = out.getContext('2d');
    oc.imageSmoothingEnabled = true;
    oc.fillStyle = '#103860';
    oc.fillRect(0, 0, BADGE_W, BADGE_H);
    oc.drawImage(canon, R_BADGE.x, R_BADGE.y, R_BADGE.w, R_BADGE.h, 0, 0, BADGE_W, BADGE_H);

    const outPath = path.join(outDir, files[troop]);
    fs.writeFileSync(outPath, out.toBuffer('image/png'));
    console.log(`  ${troop} #${idx} → ${outPath}`);
  }
})();
