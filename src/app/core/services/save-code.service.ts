import { Injectable } from '@angular/core';
import {
  doc,
  getDoc,
  getFirestore,
  runTransaction,
  serverTimestamp,
  Firestore,
} from 'firebase/firestore';

import { HeroInput, GearScanResult, BattleReportScan } from '../models/hero.model';
import { MergedRecommendation } from '../sim/simulator.service';

/**
 * One save-slot stored in Firestore at /saves/{code}. Designed to round-trip
 * the user's entire calculator inputs PLUS the cached calculate-result so a
 * loaded code displays the recommendation cards instantly without needing to
 * re-run the (potentially 2-min) recommender.
 */
export interface SaveCodePayload {
  /** Schema version — bump when the shape changes incompatibly. */
  v: number;
  heroes: HeroInput[];
  gear: GearScanResult;
  stats: BattleReportScan;
  /** Optional: cached output of `recommendAll` at save time. Pure data
   *  (Scenario / MergedRecommendation are plain interfaces with no methods)
   *  so it round-trips through Firestore cleanly. */
  recommendations?: MergedRecommendation[];
}

/** Result envelope returned by `save()`. */
export interface SaveCodeResult {
  code: string;
}

/**
 * Alphabet used for save codes. Excludes visually-confusable chars (0/O,
 * 1/I/L) so a code can be read off a screen and typed without mistakes.
 * 31 chars × 4 positions = 923,521 unique codes.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 4;
const MAX_RETRIES = 8;

@Injectable({ providedIn: 'root' })
export class SaveCodeService {
  private _db: Firestore | null = null;

  private get db(): Firestore {
    // Lazy so initializeApp(...) in app.config.ts has definitely run.
    if (!this._db) this._db = getFirestore();
    return this._db;
  }

  /**
   * Generates a fresh code, writes the payload via a transaction (so we can
   * atomically refuse to overwrite an existing code), and retries on the rare
   * collision. Throws if MAX_RETRIES collide in a row.
   */
  async save(payload: Omit<SaveCodePayload, 'v'>): Promise<SaveCodeResult> {
    const data: SaveCodePayload = { v: 1, ...payload };

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const code = randomCode();
      const ref = doc(this.db, 'saves', code);
      const winner = await runTransaction(this.db, async tx => {
        const snap = await tx.get(ref);
        if (snap.exists()) return null;            // collision — retry
        tx.set(ref, { ...data, createdAt: serverTimestamp() });
        return code;
      });
      if (winner) return { code: winner };
    }
    throw new Error('Save-code generation failed: too many collisions');
  }

  /**
   * Reads a save by code. Returns null if the code does not exist, or if the
   * stored payload is from a future incompatible version.
   */
  async load(code: string): Promise<SaveCodePayload | null> {
    const normalized = normalizeCode(code);
    if (!normalized) return null;
    const ref = doc(this.db, 'saves', normalized);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const raw = snap.data() as Partial<SaveCodePayload>;
    if (raw.v !== 1 || !raw.heroes || !raw.gear || !raw.stats) return null;
    return {
      v: raw.v,
      heroes: raw.heroes,
      gear: raw.gear,
      stats: raw.stats,
      recommendations: raw.recommendations,
    };
  }
}

/** Random 4-char code drawn from the Crockford-ish alphabet. */
function randomCode(): string {
  let out = '';
  // crypto.getRandomValues for unbiased draws (Math.random would be fine here
  // too, but this costs us nothing).
  const buf = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(buf);
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Cleans user-typed input — uppercases, drops whitespace, validates length and
 * alphabet. Returns null if the input can't be a real code. Generated codes
 * never contain `0`, `1`, `I`, `L`, or `O`, so a user typing those gets a
 * clean "not found" rather than a silent miscoercion.
 */
function normalizeCode(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw.toUpperCase().replace(/\s+/g, '');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}
