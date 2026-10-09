/* ============================================================
   dsp.js — on-device mantra signal processing (pure JS, no DOM)

   Pipeline
     PCM ─▶ FeatureExtractor ─▶ frames {t, db, mel[26]}     (every 20 ms)
         ─▶ Normalizer: adaptive noise floor + voice-activity detection,
            spectral noise subtraction, MFCC (c1..c12), cepstral mean
            normalization, loudness contour. Only voiced frames are passed
            on (plus a 160 ms hangover); pauses are not matched at all.
         ─▶ MantraMatcher: streaming subsequence DTW against the learned
            template; one complete, non-overlapping match = one repetition
         ─▶ LiveCounter: acceptance rules (score, "worst stretch", length,
            pause boundaries, rhythm) → counts

   Why this design
     • Only the sounds of the mantra are compared, so pause length — between
       or inside repetitions — has no effect. A pause longer than any pause
       inside the taught mantra is a hard boundary: no match may span it.
     • Subsequence DTW must consume the WHOLE template, in order; a partial
       repetition is additionally caught by its "worst stretch" (the missing
       words align badly) and its length (≈40–60% of a repetition).
     • Teaching records 3 repetitions one at a time (exact boundaries),
       drops one that doesn't resemble the others, averages the rest into
       the template (DTW barycenter averaging), sets thresholds from how
       your repetitions score, then self-tests on the recording.
     • Rhythm: once a few repetitions have counted, a near-miss that lands
       on the beat with full-repetition length is counted too.

   See docs/engineering-solution.md for the full rationale and evaluation.

   Runs in the browser (window.MantraDSP) and in Node (require) so the
   exact same code is tested offline against recorded/synthetic audio.
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MantraDSP = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = 7;            // bump when the profile format changes (old profiles are discarded)
  const HOP_S = 0.02;           // 50 frames / second
  const WIN_S = 0.032;
  const N_MEL = 26;
  const N_CEP = 12;             // c1..c12 (c0 = loudness, handled separately)
  const MEL_LO = 90, MEL_HI = 4200;
  const L_WEIGHT = 2.0;         // weight of the loudness-contour dimension
  const HANGOVER = 8;           // frames (160 ms) of a gap still matched as quiet sound
  const MAX_PAUSE_FRAMES = 0;   // pauses are not matched at all: only the sounds of the mantra
  const VAD_ON_DB = 9;          // speech starts this far above the noise floor…
  const VAD_OFF_DB = 5;         // …and continues until it drops below this
  const FRAME_DIST_CAP = 2.6;   // one odd frame can't dominate a match
  const PAUSE_MISMATCH = 2.6;   // cost of aligning voice with silence (or vice versa)
  const SS_ALPHA = 1.6;         // spectral subtraction: over-subtraction factor
  const SS_FLOOR = 0.08;        // …and spectral floor (× noise)
  const NOISE_RISE_MAX = 8;     // dB the live noise floor may rise above the taught room level
  const NOISE_WIN = 300;        // frames (6 s) for the windowed noise-floor percentile
  const ABS_MIN_DB = -82;       // below this a frame is never voice (dead/muted mic, digital silence)
  const PEAK_ACCEPT = 1.0;      // max "worst stretch" cost of a match (see MantraMatcher)

  /* ------------------------------------------------------------------ */
  /* small numeric helpers                                               */
  /* ------------------------------------------------------------------ */
  function percentile(xs, p) {
    if (!xs.length) return 0;
    const s = Array.from(xs).sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
  }
  function median(xs) { return percentile(xs, 0.5); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* In-place iterative radix-2 FFT (re, im of length n = 2^k). */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // DCT-II basis for c1..c12 over the log-mel bands.
  const DCT = (function () {
    const rows = [];
    for (let k = 1; k <= N_CEP; k++) {
      const row = new Float32Array(N_MEL);
      for (let n = 0; n < N_MEL; n++) row[n] = Math.cos(Math.PI * k * (n + 0.5) / N_MEL);
      rows.push(row);
    }
    return rows;
  })();

  /**
   * Spectrally-subtracted MFCCs from mel band powers and a noise estimate.
   * Also sets cep.cleanDb: band energy with the noise removed, used for the
   * loudness contour so a fan/AC doesn't flatten the syllable rhythm.
   */
  function cepstrum(mel, noiseMel) {
    const lm = new Float32Array(N_MEL);
    let e = 0;
    for (let m = 0; m < N_MEL; m++) {
      const nz = noiseMel ? noiseMel[m] : 0;
      const clean = Math.max(mel[m] - SS_ALPHA * nz, SS_FLOOR * nz, 1e-10);
      e += Math.max(mel[m] - nz, 1e-10);
      lm[m] = Math.log(clean);
    }
    const cep = new Float32Array(N_CEP);
    for (let k = 0; k < N_CEP; k++) {
      let s = 0; const row = DCT[k];
      for (let n = 0; n < N_MEL; n++) s += row[n] * lm[n];
      cep[k] = s;
    }
    cep.cleanDb = 10 * Math.log10(e);
    return cep;
  }

  /* ------------------------------------------------------------------ */
  /* FeatureExtractor: PCM → frames {t, db, mel}                         */
  /* ------------------------------------------------------------------ */
  function FeatureExtractor(sampleRate) {
    const sr = sampleRate;
    const win = Math.round(sr * WIN_S);
    const hop = Math.round(sr * HOP_S);
    let nfft = 1; while (nfft < win) nfft <<= 1;
    const nBins = nfft / 2 + 1;

    const hamming = new Float32Array(win);
    for (let i = 0; i < win; i++) hamming[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (win - 1));

    // Triangular mel filterbank (bin weights).
    const mel = (f) => 2595 * Math.log10(1 + f / 700);
    const imel = (m) => 700 * (Math.pow(10, m / 2595) - 1);
    const hi = Math.min(MEL_HI, sr * 0.48);
    const mLo = mel(MEL_LO), mHi = mel(hi);
    const centers = [];
    for (let i = 0; i < N_MEL + 2; i++) centers.push(imel(mLo + (mHi - mLo) * i / (N_MEL + 1)) * nfft / sr);
    const filters = [];
    for (let m = 1; m <= N_MEL; m++) {
      const l = centers[m - 1], c = centers[m], r = centers[m + 1];
      const lo = Math.max(0, Math.floor(l)), up = Math.min(nBins - 1, Math.ceil(r));
      const w = [];
      for (let k = lo; k <= up; k++) w.push(Math.max(0, k < c ? (k - l) / (c - l) : (r - k) / (r - c)));
      filters.push({ lo, w });
    }

    let buf = new Float32Array(Math.max(win * 4, 8192));
    let len = 0;          // valid samples in buf
    let pos = 0;          // index in buf where the next frame starts
    let consumed = 0;     // absolute sample index of buf[0]
    const re = new Float32Array(nfft), im = new Float32Array(nfft);

    function frameAt(off) {
      let e = 0, prev = off > 0 ? buf[off - 1] : 0;
      re.fill(0); im.fill(0);
      for (let i = 0; i < win; i++) {
        const x = buf[off + i];
        e += x * x;
        re[i] = (x - 0.97 * prev) * hamming[i];   // pre-emphasis + window
        prev = x;
      }
      fft(re, im);
      const melP = new Float32Array(N_MEL);
      for (let m = 0; m < N_MEL; m++) {
        const f = filters[m];
        let s = 0;
        for (let k = 0; k < f.w.length; k++) {
          const b = f.lo + k;
          s += f.w[k] * (re[b] * re[b] + im[b] * im[b]);
        }
        melP[m] = s / win;   // sample-rate independent scale
      }
      return { db: 10 * Math.log10(e / win + 1e-12), mel: melP };
    }

    /** Append samples; returns an array of new frames {t, db, mel}. */
    function push(samples) {
      // compact: keep one sample before `pos` for pre-emphasis continuity
      const drop = Math.max(0, pos - 1);
      if (drop > 0) { buf.copyWithin(0, drop, len); len -= drop; pos -= drop; consumed += drop; }
      if (len + samples.length > buf.length) {
        const nb = new Float32Array(Math.max(buf.length * 2, len + samples.length));
        nb.set(buf.subarray(0, len)); buf = nb;
      }
      buf.set(samples, len); len += samples.length;
      const out = [];
      while (pos + win <= len) {
        const f = frameAt(pos);
        f.t = (consumed + pos + win / 2) / sr;
        out.push(f);
        pos += hop;
      }
      return out;
    }
    return { push, sampleRate: sr };
  }

  /** Convenience: all frames of a whole PCM buffer. */
  function extractAll(samples, sampleRate) {
    const fx = FeatureExtractor(sampleRate);
    const out = [];
    const B = 4096;
    for (let i = 0; i < samples.length; i += B) {
      const r = fx.push(samples.subarray(i, Math.min(samples.length, i + B)));
      for (const f of r) out.push(f);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Normalizer: VAD + features; pauses are dropped                       */
  /* Turns raw frames into the vector stream that DTW compares.           */
  /* ------------------------------------------------------------------ */
  // Canonical "silence" vector. dist() treats voice-vs-silence specially.
  const PAUSE_VEC = new Float32Array(N_CEP + 1);

  /**
   * @param {object} p { noiseDb, voiceDb, noiseMel[26], mu[12], sd[12] }
   * @param {boolean} adapt track noise/voice/channel drift (live sessions)
   */
  function Normalizer(p, adapt) {
    let noise = p.noiseDb;
    let voice = p.voiceDb;
    const noiseMel = Float32Array.from(p.noiseMel);
    const mu = Float32Array.from(p.mu);
    const sd = Float32Array.from(p.sd);
    let speech = false, hadSpeech = false;
    let pauseRun = 0;
    const hist = new Float32Array(NOISE_WIN);
    let hN = 0;
    const noiseCap = p.noiseDb + NOISE_RISE_MAX;

    function step(f) {
      const db = f.db;
      if (adapt) {
        // Noise floor: drops instantly; may RISE only while the last 6 s are
        // steady, and never more than NOISE_RISE_MAX dB above the room level
        // measured while teaching. A sustained, hummed chant is as "steady" as
        // a fan by any loudness/spectral test, and letting the floor follow it
        // made the voice itself become noise after a few seconds of continuous
        // chanting — counting stopped. A room that got much louder than when
        // the mantra was taught should be re-taught.
        hist[hN % NOISE_WIN] = db; hN++;
        // Downward: to the 5th percentile of the last few seconds — NOT to
        // single quiet frames. Real rooms fluctuate by ~4–6 dB; following the
        // quietest moments ratcheted the floor ~10 dB too low within a minute,
        // ordinary room sound then counted as voice, the voice model adapted
        // to it, and counting stalled mid-session. Never into digital silence.
        if (hN >= 50 && hN % 10 === 0) {
          const w = hist.subarray(0, Math.min(hN, NOISE_WIN));
          const p5 = percentile(w, 0.05), p20 = percentile(w, 0.2), p50 = percentile(w, 0.5);
          if (p5 < noise && p5 > ABS_MIN_DB - 12) noise = p5;
          // (a) the quietest 20% is extremely flat (< 1.5 dB spread): machine
          //     noise — fan, AC (~0.5 dB). A voice, even a held chant, never is
          //     (measured 2.4–4 dB; a real quiet room 4–6 dB). Follow it fully —
          //     otherwise loud fan noise between half-mantras looks like voice
          //     and they join into "full" repetitions.
          // (b) the whole window steady by loudness (no chanting, or a long
          //     held chant): rise at most NOISE_RISE_MAX above the taught room.
          const floorUnderVoice = p20 - p5 < 1.5;
          const allSteady = p50 - p5 < 6;
          const lim = floorUnderVoice ? Infinity : noiseCap;
          if (p5 > noise && noise < lim && (floorUnderVoice || allSteady)) noise = Math.min(lim, noise + Math.min(1.2, p5 - noise));
        }
      }
      const over = db - noise;
      speech = db > ABS_MIN_DB && (speech ? over > VAD_OFF_DB : over > VAD_ON_DB);
      // Noise spectrum for spectral subtraction: learn from quiet frames.
      if (adapt && !speech && over < VAD_OFF_DB) {
        for (let m = 0; m < N_MEL; m++) noiseMel[m] += (f.mel[m] - noiseMel[m]) * 0.05;
      }
      if (!speech) {
        pauseRun++;
        // Hangover: the first HANGOVER frames of a gap are still matched as
        // (quiet) sound — in noise the voice detector flickers off for a frame
        // or two inside a repetition, and dropping those frames looked like
        // missing words. Real pauses are longer and are not matched at all.
        if (pauseRun > HANGOVER || !hadSpeech) return { vec: pauseRun <= MAX_PAUSE_FRAMES ? PAUSE_VEC : null, speech: false, over };
        return { vec: features(f, false), speech: false, bridge: true, over };
      }
      pauseRun = 0;
      hadSpeech = true;
      return { vec: features(f, adapt), speech: true, over };
    }

    function features(f, learn) {
      const cep = cepstrum(f.mel, noiseMel);
      if (learn) {
        voice += (cep.cleanDb - voice) * 0.01;                           // ~2 s of speech
        for (let k = 0; k < N_CEP; k++) mu[k] += (cep[k] - mu[k]) * 0.003; // ~7 s of speech
      }
      const v = new Float32Array(N_CEP + 1);
      for (let k = 0; k < N_CEP; k++) v[k] = (cep[k] - mu[k]) / sd[k];
      v[N_CEP] = clamp((cep.cleanDb - voice) / 12, -1.5, 0.6) * L_WEIGHT;
      return v;
    }
    return { step, state() { return { noiseDb: noise, voiceDb: voice }; } };
  }

  /* ------------------------------------------------------------------ */
  /* Distances / DTW                                                      */
  /* ------------------------------------------------------------------ */
  const DIMS = N_CEP + 1;
  function dist(a, b) {
    if (a === PAUSE_VEC || b === PAUSE_VEC) return a === b ? 0 : PAUSE_MISMATCH;
    let s = 0;
    for (let k = 0; k < DIMS; k++) { const d = a[k] - b[k]; s += d * d; }
    const v = Math.sqrt(s / DIMS);
    return v > FRAME_DIST_CAP ? FRAME_DIST_CAP : v;
  }

  /** Full (both ends anchored) DTW, symmetric2 steps, normalized by n+m. */
  function dtwFull(A, B) {
    const n = A.length, m = B.length;
    if (!n || !m) return Infinity;
    const INF = 1e18;
    let prev = new Float64Array(m + 1).fill(INF), cur = new Float64Array(m + 1);
    prev[0] = 0;
    for (let i = 1; i <= n; i++) {
      cur.fill(INF);
      for (let j = 1; j <= m; j++) {
        const c = dist(A[i - 1], B[j - 1]);
        const d = prev[j - 1] + 2 * c, h = prev[j] + c, v = cur[j - 1] + c;
        cur[j] = d < h ? (d < v ? d : v) : (h < v ? h : v);
      }
      const t = prev; prev = cur; cur = t;
      prev[0] = INF;
    }
    return prev[m] / (n + m);
  }

  /** Full DTW alignment path (symmetric2), as [i, j] index pairs. */
  function dtwPath(A, B) {
    const n = A.length, m = B.length, INF = 1e18;
    const C = new Float64Array((n + 1) * (m + 1)).fill(INF), W = m + 1;
    C[0] = 0;
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      const c = dist(A[i - 1], B[j - 1]);
      C[i * W + j] = Math.min(C[(i - 1) * W + j - 1] + 2 * c, C[(i - 1) * W + j] + c, C[i * W + j - 1] + c);
    }
    const path = [];
    let i = n, j = m;
    while (i > 0 && j > 0) {
      path.push([i - 1, j - 1]);
      const d = C[(i - 1) * W + j - 1], u = C[(i - 1) * W + j], l = C[i * W + j - 1];
      if (d <= u && d <= l) { i--; j--; } else if (u <= l) i--; else j--;
    }
    return path;
  }

  /**
   * DTW barycenter averaging: align every member to the current average and
   * replace each average frame by the mean of the frames aligned to it.
   * Silence frames stay silence.
   */
  function dbaAverage(init, members, iters) {
    let avg = init;
    for (let it = 0; it < iters; it++) {
      const sum = avg.map(() => new Float64Array(DIMS)), cnt = new Int32Array(avg.length);
      for (const mem of members) {
        for (const [i, j] of dtwPath(mem, avg)) {
          if (avg[j] === PAUSE_VEC || mem[i] === PAUSE_VEC) continue;
          for (let k = 0; k < DIMS; k++) sum[j][k] += mem[i][k];
          cnt[j]++;
        }
      }
      avg = avg.map((v, j) => {
        if (v === PAUSE_VEC || !cnt[j]) return v;
        const out = new Float32Array(DIMS);
        for (let k = 0; k < DIMS; k++) out[k] = sum[j][k] / cnt[j];
        return out;
      });
    }
    return avg;
  }

  /* ------------------------------------------------------------------ */
  /* MantraMatcher — streaming subsequence DTW (SPRING-style)              */
  /* ------------------------------------------------------------------ */
  /**
   * cfg { template: Float32Array[], accept, softAccept }
   * push(vec, t) for every emitted vector; idle() for frames dropped by
   * the voice detector (pauses). Both return events { type:"count", score, soft, … }.
   * Alignment uses symmetric2 steps with local (greedy) length
   * normalization and slope limits, so a match must cover the whole
   * template at 1/3×–5× local speed.
   */
  function MantraMatcher(cfg) {
    const T = cfg.template;
    const M = T.length;
    const H_MAX = 4;      // live may be up to ~5× slower locally (held vowels)
    const V_MAX = 2;      // …or ~3× faster locally
    // Minimum length of a match: 62% of a repetition at your CURRENT pace
    // (setPace), so a half-mantra (~50%) never fits while a fast rep does.
    let minSpan = Math.max(3, Math.floor(M * 0.62));
    const maxSpan = Math.ceil(M * 2.5) + 4;
    const LOOKAHEAD = Math.max(6, Math.round(M * 0.15));
    let accept = cfg.accept;
    let softAccept = cfg.softAccept || cfg.accept;

    // E/X: running local cost along the path (EMA over ~12% of the template)
    // and its maximum — the "worst stretch". A partial repetition matches
    // most of the template well but one stretch (the missing words) badly;
    // a full repetition with natural variation is moderately off everywhere.
    const ALPHA = Math.min(0.5, 1 / Math.max(2, M * 0.12));
    let peakAccept = cfg.peakAccept || Infinity;
    const mk = () => ({ D: new Float64Array(M + 1).fill(Infinity), W: new Float64Array(M + 1),
      S: new Int32Array(M + 1), H: new Uint8Array(M + 1), V: new Uint8Array(M + 1),
      E: new Float64Array(M + 1), X: new Float64Array(M + 1) });
    let prev = mk(), cur = mk();
    let n = 0;               // emitted-vector index
    const times = new Map(); // emitted index → wall time (bounded)
    let cand = null;         // best pending end-of-template candidate
    let sinceCand = 0;
    let lastEnd = -1;        // emitted index of the last committed match end
    let progress = 0;
    let minSeen = Infinity, minSeenPeak = Infinity;
    let nearest = Infinity, nearestPeak = Infinity, nearestInfo = null;   // closest full-template score since the last takeNearest()

    const OVERLAP = 2;       // frames two consecutive matches may share
    let idleRun = 0;
    const boundaryFrames = Math.max(15, Math.round((cfg.boundarySec || 0.9) / HOP_S));

    function commit(out) {
      const c = cand; cand = null; sinceCand = 0;
      lastEnd = c.end;
      progress = 0;
      // kill every alignment that overlaps the committed match
      for (let j = 1; j <= M; j++) {
        if (prev.S[j] <= c.end - OVERLAP) prev.D[j] = Infinity;
        if (cur.S[j] <= c.end - OVERLAP) cur.D[j] = Infinity;
      }
      // borderline on either test → "soft": held until the next rep confirms it
      out.push({ type: "count", score: c.score, peak: c.peak, soft: c.score > accept || c.peak > peakAccept,
        start: c.tStart, end: c.tEnd, span: c.end - c.start + 1 });
    }

    /**
     * SPRING-style guard: is there an unfinished alignment of (roughly) the
     * same repetition that is doing clearly better than the candidate? Then
     * the candidate is an early, skewed alignment — e.g. a mantra whose two
     * halves end alike ("…Hare Hare / …Hare Hare") — and we must wait.
     */
    function blocked() {
      const D = prev.D, W = prev.W, S = prev.S;
      const lim = cand.start + 0.5 * (cand.end - cand.start);
      const jLo = Math.floor(M * 0.25), jHi = Math.floor(M * 0.85);
      for (let j = jLo; j <= jHi; j++) {
        if (D[j] < Infinity && S[j] <= lim && D[j] / W[j] < cand.score * 0.8) return true;
      }
      return false;
    }

    function push(x, t) {
      const out = [];
      const i = n++;
      idleRun = 0;
      times.set(i, t);
      if (times.size > maxSpan + 64) times.delete(i - maxSpan - 64);
      const pD = prev.D, pW = prev.W, pS = prev.S, pH = prev.H, pE = prev.E, pX = prev.X;
      const cD = cur.D, cW = cur.W, cS = cur.S, cH = cur.H, cV = cur.V, cE = cur.E, cX = cur.X;
      let bestProg = 0;
      for (let j = 1; j <= M; j++) {
        const c = dist(x, T[j - 1]);
        let bD, bW, bS, bH = 0, bV = 0, bE, bX, adv = true;
        if (j === 1) { bD = 2 * c; bW = 2; bS = i; bE = c; bX = 0; }   // a path may start here
        else { bD = pD[j - 1] + 2 * c; bW = pW[j - 1] + 2; bS = pS[j - 1]; bE = pE[j - 1]; bX = pX[j - 1]; }
        let bN = bD / bW;
        if (pD[j] < Infinity && pH[j] < H_MAX) {             // live advances, template holds
          const d = pD[j] + c, w = pW[j] + 1, nn = d / w;
          if (nn < bN) { bD = d; bW = w; bS = pS[j]; bH = pH[j] + 1; bV = 0; bN = nn; bE = pE[j]; bX = pX[j]; adv = false; }
        }
        if (j > 1 && cD[j - 1] < Infinity && cV[j - 1] < V_MAX) { // template advances, live holds
          const d = cD[j - 1] + c, w = cW[j - 1] + 1, nn = d / w;
          if (nn < bN) { bD = d; bW = w; bS = cS[j - 1]; bH = 0; bV = cV[j - 1] + 1; bN = nn; bE = cE[j - 1]; bX = cX[j - 1]; adv = true; }
        }
        // Only template-advancing steps update it (an extra breath inserted
        // into a live rep is absorbed by "template holds" steps), and a
        // voice/silence mismatch counts as merely "poor", not "terrible".
        if (adv) {
          bE += ((c === PAUSE_MISMATCH ? 1.0 : c) - bE) * ALPHA;
          // only the core of the mantra: soft onsets/tails (outer 10%) vanish
          // under background noise, while a real partial misses ≥ 35%
          if (j > M * 0.1 && j < M * 0.9 && bE > bX) bX = bE;
        }
        cE[j] = bE; cX[j] = bX;
        // never start inside an already-counted match; bound path length
        if (bS <= lastEnd - OVERLAP || i - bS > maxSpan) bD = Infinity;
        cD[j] = bD; cW[j] = bW; cS[j] = bS; cH[j] = bH; cV[j] = bV;
        if (bD < Infinity && bN <= softAccept && j > bestProg && i - bS >= j * 0.3) bestProg = j;
      }
      progress = bestProg / M;
      if (cD[M] < Infinity) {
        const score = cD[M] / cW[M];
        const span = i - cS[M] + 1;
        if (span >= minSpan && span <= maxSpan && score < minSeen) { minSeen = score; minSeenPeak = cX[M]; }
        if (span >= minSpan && span <= maxSpan && score < nearest) {
          nearest = score; nearestPeak = cX[M]; nearestInfo = { span, start: times.get(cS[M]), end: t };
        }
        // a clean alignment always beats a borderline one of the same repetition
        const hard = score <= accept && cX[M] <= peakAccept;
        const ok = score <= softAccept && cX[M] <= peakAccept * 1.12 && span >= minSpan && span <= maxSpan;
        // a new match that doesn't overlap the pending one is the NEXT
        // repetition: settle the pending one first instead of replacing it
        if (ok && cand && cS[M] > cand.end - OVERLAP) commit(out);
        if (ok && cD[M] < Infinity &&
            (!cand || (hard && !cand.hard) || (hard === cand.hard && score < cand.score))) {
          cand = { score, peak: cX[M], hard, start: cS[M], end: i, tStart: times.get(cS[M]), tEnd: t };
          sinceCand = 0;
        }
      }
      const tmp = prev; prev = cur; cur = tmp;
      if (cand) {
        sinceCand++;
        // a borderline candidate waits longer: a clean alignment of the same
        // repetition (usually ending a little later) may still arrive
        const wait = cand.hard ? LOOKAHEAD : LOOKAHEAD * 3;
        if ((sinceCand > wait && !blocked()) || sinceCand > M) commit(out);
      }
      return out;
    }

    /**
     * A frame dropped as a pause (the chanter is silent): commit
     * right away unless a better alignment is still mid-way (a pause INSIDE
     * a long mantra); give up waiting after ~1.6 s of silence.
     */
    function idle() {
      const out = [];
      idleRun++;
      const boundary = idleRun >= boundaryFrames;
      if (cand && (!blocked() || idleRun > 80 || boundary)) commit(out);
      if (!cand) progress = 0;
      // A pause longer than any pause inside the mantra ends a repetition:
      // no alignment may continue across it (otherwise two half-mantras
      // separated by a breath could join into one "full" repetition).
      if (boundary) { prev.D.fill(Infinity); cur.D.fill(Infinity); }
      return out;
    }

    return {
      push, idle,
      get progress() { return progress; },
      get minSeen() { return minSeen; },
      get minSeenPeak() { return minSeenPeak; },
      setPace(f) { minSpan = Math.max(3, Math.floor(M * 0.62 * clamp(f, 0.7, 1.3))); },
      takeNearest() {
        const v = Object.assign({ score: nearest, peak: nearestPeak }, nearestInfo || {});
        nearest = nearestPeak = Infinity; nearestInfo = null; return v;
      },
      get peakAccept() { return peakAccept; },
      setAccept(a, s, pk) { accept = a; softAccept = s || a; if (pk) peakAccept = pk; },
      get accept() { return accept; },
      M
    };
  }

  /**
   * Best (lowest) full-template subsequence score anywhere in `vecs`, with
   * the same step rules and span limits as live matching. Offline helper.
   */
  function bestScore(template, vecs, withPeak) {
    const m = MantraMatcher({ template, accept: -1, softAccept: -1 });
    for (const v of vecs) m.push(v, 0);
    return withPeak ? { score: m.minSeen, peak: m.minSeenPeak } : m.minSeen;
  }

  /** Run a matcher over a whole stream [{vec|null, t}] (offline helper). */
  function matchAll(template, stream, accept, softAccept) {
    const m = MantraMatcher({ template, accept, softAccept: softAccept || accept });
    const hits = [];
    for (const s of stream) for (const e of (s.vec ? m.push(s.vec, s.t) : m.idle())) hits.push(e);
    for (const e of m.idle()) hits.push(e);
    return hits;
  }

  /* ------------------------------------------------------------------ */
  /* Calibration: learn the mantra from ~3 repetitions                    */
  /* ------------------------------------------------------------------ */
  /**
   * @param {Array} frames raw frames from FeatureExtractor
   * @param {object} [opts] { reps: [{t0,t1}] } — where each repetition is, when
   *   the teach screen recorded them one by one (preferred). Without it the
   *   repetitions are found automatically (only reliable for ~3 of them).
   * @returns {object} { ok, reason?, profile?, reps?: [{t0,t1}], medoid?: {t0,t1}, dropped? }
   *   reason ∈ too_short | no_voice | too_little_voice | need_more_reps | reps_differ
   */
  function learnMantra(frames, opts) {
    opts = opts || {};
    if (!frames || frames.length < 50) return { ok: false, reason: "too_short" };
    const dbs = frames.map((f) => f.db);
    const loud = percentile(dbs, 0.97);
    // If the window is nearly all voice the low percentile sits in the voice;
    // never let the floor ride higher than 20 dB under the loud level.
    const noiseDb = Math.min(percentile(dbs, 0.08), loud - 20);
    if (loud < ABS_MIN_DB + 6 || loud - percentile(dbs, 0.08) < VAD_ON_DB + 3) return { ok: false, reason: "no_voice" };

    // Noise spectrum from the quietest frames.
    const noiseMel = new Float32Array(N_MEL);
    let nq = 0;
    for (const f of frames) if (f.db < noiseDb + 3) { for (let m = 0; m < N_MEL; m++) noiseMel[m] += f.mel[m]; nq++; }
    if (nq) for (let m = 0; m < N_MEL; m++) noiseMel[m] /= nq;

    // Speech mask + feature statistics.
    let sp = false;
    const spIdx = [];
    const ceps = [];
    for (let i = 0; i < frames.length; i++) {
      const over = frames[i].db - noiseDb;
      sp = frames[i].db > ABS_MIN_DB && (sp ? over > VAD_OFF_DB : over > VAD_ON_DB);
      if (sp) { spIdx.push(i); ceps.push(cepstrum(frames[i].mel, noiseMel)); }
    }
    if (spIdx.length * HOP_S < 1.2) return { ok: false, reason: "too_little_voice" };
    const voiceDb = median(ceps.map((c) => c.cleanDb));
    const mu = new Float32Array(N_CEP), sd = new Float32Array(N_CEP);
    for (const c of ceps) for (let k = 0; k < N_CEP; k++) mu[k] += c[k];
    for (let k = 0; k < N_CEP; k++) mu[k] /= ceps.length;
    for (const c of ceps) for (let k = 0; k < N_CEP; k++) { const d = c[k] - mu[k]; sd[k] += d * d; }
    for (let k = 0; k < N_CEP; k++) sd[k] = Math.max(1e-3, Math.sqrt(sd[k] / ceps.length));

    const base = { noiseDb, voiceDb, noiseMel: Array.from(noiseMel), mu: Array.from(mu), sd: Array.from(sd) };

    // The same normalizer the live session uses (frozen statistics here).
    const norm = Normalizer(base, false);
    const stream = frames.map((f) => { const r = norm.step(f); return { vec: r.vec, t: f.t, speech: r.speech }; });
    let em = stream.filter((s) => s.vec);
    while (em.length && !em[0].speech) em.shift();
    while (em.length && !em[em.length - 1].speech) em.pop();
    if (em.length < 40) return { ok: false, reason: "too_little_voice" };

    const vecs = (s) => em.slice(s.a, s.b).map((e) => e.vec);
    const trimPauses = (seg) => {
      let { a, b } = seg;
      while (a < b && !em[a].speech) a++;
      while (b > a && !em[b - 1].speech) b--;
      return { a, b };
    };
    const tIndex = (t) => { // emitted index for a wall time
      let lo = 0, hi = em.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (em[mid].t < t - 1e-6) lo = mid + 1; else hi = mid; }
      return lo;
    };
    let repSegs, tplSeg, template, kFound, dropped = 0;

    if (opts.reps) {
      // Repetitions recorded one at a time: boundaries are known exactly.
      repSegs = opts.reps.map((r) => trimPauses({ a: tIndex(r.t0), b: tIndex(r.t1) + 1 }))
        .filter((sg) => sg.b - sg.a >= 12);
      if (repSegs.length < 2) return { ok: false, reason: "need_more_reps" };
      // Drop a repetition that clearly isn't like the others (cut short, a
      // cough, a different phrase) — as long as at least 2 good ones remain.
      for (;;) {
        const V = repSegs.map(vecs);
        const lens = V.map((v) => v.length), lm = median(lens);
        const d = V.map((a, i) => median(V.filter((_, j) => j !== i).map((b) => dtwFull(a, b))));
        const dm = median(d);
        let worst = -1, wScore = 0;
        for (let i = 0; i < V.length; i++) {
          const lr = lens[i] / lm;
          const bad = (lr < 0.6 || lr > 1.65 ? 1 : 0) + (d[i] > Math.max(dm * 1.8, dm + 0.35) ? 1 : 0);
          if (bad && bad + d[i] > wScore) { wScore = bad + d[i]; worst = i; }
        }
        if (worst < 0) break;
        if (repSegs.length <= 2) return { ok: false, reason: "reps_differ" };
        repSegs.splice(worst, 1); dropped++;
      }
      kFound = repSegs.length;
    } else {
    // --- Step 1: rough split into k equal-ish reps, snapped to pauses/dips.
    const N = em.length;
    const cutScore = new Float32Array(N);   // higher = better place to split
    for (let i = 1; i < N - 1; i++) {
      if (!em[i].speech) cutScore[i] = 3;
      else {
        const L = em[i].vec[N_CEP];
        if (L < em[i - 1].vec[N_CEP] && L <= em[i + 1].vec[N_CEP]) cutScore[i] = Math.max(0, -L / L_WEIGHT);
      }
    }
    function segmentsFor(k) {
      const cuts = [0];
      const segLen = N / k;
      for (let c = 1; c < k; c++) {
        const target = Math.round(c * segLen);
        const rad = Math.round(segLen * 0.3);
        let best = target, bestV = -Infinity;
        for (let i = Math.max(cuts[cuts.length - 1] + 5, target - rad); i <= Math.min(N - 5, target + rad); i++) {
          const v = cutScore[i] - 1.5 * Math.abs(i - target) / segLen;
          if (v > bestV) { bestV = v; best = i; }
        }
        cuts.push(best);
      }
      cuts.push(N);
      const segs = [];
      for (let c = 0; c < k; c++) {
        let a = cuts[c], b = cuts[c + 1];
        while (a < b && !em[a].speech) a++;
        while (b > a && !em[b - 1].speech) b--;
        segs.push({ a, b });
      }
      return segs;
    }

    const kMax = Math.min(6, Math.floor(N / 20));
    let best = null;
    for (let k = 2; k <= kMax; k++) {
      const segs = segmentsFor(k);
      if (segs.some((s) => s.b - s.a < 12)) continue;
      const V = segs.map(vecs);
      const Dm = segs.map(() => new Array(k).fill(0));
      let sum = 0, cnt = 0;
      for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) {
        const d = dtwFull(V[a], V[b]);
        Dm[a][b] = Dm[b][a] = d; sum += d; cnt++;
      }
      const lens = segs.map((s) => s.b - s.a);
      const lm = lens.reduce((x, y) => x + y, 0) / k;
      const cv = Math.sqrt(lens.reduce((x, y) => x + (y - lm) * (y - lm), 0) / k) / lm;
      const cost = sum / cnt + 0.35 * cv;
      // prefer the longer unit (smaller k) unless a larger k is clearly better:
      // a mantra with an internal refrain must never be learned as half-mantras
      if (!best || cost < best.cost * 0.85) best = { k, segs, Dm, cost };
    }
    if (!best) return { ok: false, reason: "need_more_reps" };

    let med = 0, medSum = Infinity;
    for (let a = 0; a < best.k; a++) {
      const s = best.Dm[a].reduce((x, y) => x + y, 0);
      if (s < medSum) { medSum = s; med = a; }
    }
    tplSeg = best.segs[med];
    template = vecs(tplSeg);

    // --- Step 2: refine with the matcher itself (exact rep boundaries).
    repSegs = best.segs;
    const loose = matchAll(template, stream, 0.9).filter((h) => h.span >= template.length * 0.5);
    if (loose.length >= 2) {
      const segs = loose.map((h) => trimPauses({ a: tIndex(h.start), b: tIndex(h.end) + 1 }))
        .filter((s) => s.b - s.a >= 12);
      if (segs.length >= 2) repSegs = segs;
    }
    kFound = best.k;
    }
    {   // medoid: the repetition most like all the others becomes the template
      const V = repSegs.map(vecs);
      let m2 = 0, s2 = Infinity;
      for (let a = 0; a < V.length; a++) {
        let s = 0;
        for (let b = 0; b < V.length; b++) if (a !== b) s += dtwFull(V[a], V[b]);
        if (s < s2) { s2 = s; m2 = a; }
      }
      tplSeg = repSegs[m2];
      template = V[m2];
      // Average the repetitions that resemble the medoid into one template
      // (DTW barycenter averaging). Any single repetition has its own wobble
      // in pitch, vowel colour and timing; the average sits in the middle of
      // your repetitions, so live chanting scores closer and more steadily.
      // A repetition clearly unlike the rest (e.g. one that started during
      // "get ready") is left out of the average.
      const dists = V.map((v, i) => i === m2 ? 0 : dtwFull(v, V[m2]));
      const others = dists.filter((_, i) => i !== m2);
      const dMin = Math.min.apply(null, others);
      const members = V.filter((_, i) => i === m2 || dists[i] <= Math.max(dMin * 1.3, dMin + 0.08));
      if (members.length >= 2) template = dbaAverage(template, members, 2);
    }

    // --- Step 3: threshold.
    // Self scores: how each of your other reps matches the template.
    const pad = (arr) => {
      if (!MAX_PAUSE_FRAMES) return arr;
      const P = [PAUSE_VEC, PAUSE_VEC, PAUSE_VEC, PAUSE_VEC];
      return P.concat(arr, P);
    };
    const selfRes = repSegs.filter((sg) => sg !== tplSeg)
      .map((sg) => bestScore(template, pad(vecs(sg)), true))
      .filter((x) => x.score < Infinity);
    if (!selfRes.length) return { ok: false, reason: "need_more_reps" };
    const selfs = selfRes.map((x) => x.score);
    const selfMax = Math.max.apply(null, selfs);
    // Worst-stretch limit: 1.0 in normal rooms; if your own reps already
    // have rough stretches (a noisy room), allow proportionally more.
    // Worst-stretch limit: fixed. Measured on a real voice, full repetitions
    // stay ≤ ~0.9 and half-mantras start at ~1.0; deriving it from the taught
    // repetitions let a noisy teach open the gate for half-mantras.
    const peakAccept = PEAK_ACCEPT;
    // Impostors: partial repetitions ("Om Namah" of "Om Namah Shivaya").
    // These are exact template slices, so a real (varied) partial scores
    // higher still — this is a conservative lower bound.
    const M = template.length;
    const imp = Math.min(
      bestScore(template, pad(template.slice(0, Math.round(M * 0.6)))),
      bestScore(template, pad(template.slice(Math.round(M * 0.45))))
    );
    // Typical live variation (tempo, mic, room) adds ~0.2–0.3 to any score,
    // so the threshold sits above your reps by that much plus a share of the
    // partial-repetition penalty — clamped to a range validated on recordings.
    const s = Math.max(median(selfs), 0.22);
    // Upper bound from a real voice: full reps scored ≤ 0.75, half reps ≥ 0.84.
    let accept = clamp(s + 0.65 * imp, 0.42, 0.78);
    accept = Math.max(accept, Math.min(selfMax * 1.1, 0.8));    // your own reps must pass
    let softAccept = Math.max(accept, Math.min(accept * 1.18, 0.86));
    let peakA = peakAccept;
    const nReps = repSegs.length;
    const hits = repSegs.map((sg) => ({ start: em[sg.a].t, end: em[sg.b - 1].t }));

    const speechFrames = template.filter((v) => v !== PAUSE_VEC).length;
    // Longest pause INSIDE a taught repetition → anything clearly longer is a
    // boundary between repetitions. (Teaching ends a rep after 1.2 s silence,
    // so internal pauses are always shorter than that.)
    let maxInner = 0;
    for (const sg of repSegs) {
      const t0 = em[sg.a].t, t1 = em[sg.b - 1].t;
      let run = 0;
      for (const st of stream) {
        if (st.t < t0 || st.t > t1) continue;
        if (st.speech) run = 0; else { run++; maxInner = Math.max(maxInner, run * HOP_S); }
      }
    }
    const boundarySec = clamp(maxInner + 0.35, 0.6, 1.0);
    const repTimes = hits.map((h) => ({ t0: h.start, t1: h.end })).sort((a, b) => a.t0 - b.t0);
    const period = repTimes.length >= 2
      ? median(repTimes.slice(1).map((r, i) => r.t0 - repTimes[i].t0))
      : speechFrames * HOP_S + 0.6;

    const profile = {
      v: VERSION,
      noiseDb, voiceDb,
      noiseMel: base.noiseMel.map((x) => +x.toPrecision(4)),
      mu: base.mu, sd: base.sd,
      template: template.map((v) => v === PAUSE_VEC ? 0 : Array.from(v, (x) => Math.round(x * 1000) / 1000)),
      // finite numbers only: the profile is stored as JSON (Infinity → null)
      accept, softAccept, selfMax, impostor: Math.min(imp, 9), peakAccept: peakA,
      repSec: speechFrames * HOP_S,
      boundarySec,
      periodSec: period,
      nReps, k: kFound
    };

    // --- Step 4: self-test. Run the live counter over this very recording;
    // every repetition you just taught must count. If some don't, loosen the
    // thresholds step by step — never into the partial-repetition zone.
    const selfTest = () => {
      const lc = LiveCounter(profile);
      let n = 0;
      for (const f of frames) n += lc.feed(f).counts;
      return n;
    };
    let got = selfTest();
    // Only the average-score limit may relax (≤ 0.85, measured gap to real
    // half-mantras); the worst-stretch limit is the partial-mantra guard and
    // is never loosened — doing so let half-mantras count after a noisy teach.
    const cap = Math.min(0.85, imp * 0.92);
    for (let i = 0; i < 6 && got < nReps && profile.accept < cap; i++) {
      profile.accept = Math.min(cap, profile.accept * 1.05);
      profile.softAccept = Math.max(profile.accept, Math.min(0.88, profile.softAccept * 1.05));
      got = selfTest();
    }
    profile.selfTest = got;

    return {
      ok: true,
      dropped,
      reps: repTimes,
      medoid: { t0: em[tplSeg.a].t - WIN_S, t1: em[tplSeg.b - 1].t + WIN_S },
      profile
    };
  }

  /* ------------------------------------------------------------------ */
  /* LiveCounter: raw frames in → counts out                              */
  /* ------------------------------------------------------------------ */
  /**
   * @param {object} profile from learnMantra() (as stored)
   * @param {object} [opt] { sensitivity: 0.8 (strict) … 1.25 (lenient) }
   */
  function LiveCounter(profile, opt) {
    opt = opt || {};
    const template = profile.template.map((a) => a === 0 ? PAUSE_VEC : Float32Array.from(a));
    const impostor = Number.isFinite(profile.impostor) ? profile.impostor : 9;   // older JSON may hold null
    const norm = Normalizer(profile, true);
    let sens = opt.sensitivity || 1;
    const thr = () => {
      // Lenient may never cross into the partial-repetition zone.
      const cap = impostor * 0.95;
      const a = Math.min(profile.accept * sens, cap);
      return { a, s: Math.min(Math.max(a, profile.softAccept * sens), cap) };
    };
    // Lenient relaxes only the average-score limit: the worst-stretch limit is
    // the guard against partial mantras and is never loosened (on a real voice:
    // full reps ≤ 0.78, half reps ≥ 1.02).
    const peak = () => (profile.peakAccept || PEAK_ACCEPT) * clamp(sens, 0.85, 1);
    const t0 = thr();
    const matcher = MantraMatcher({ template, accept: t0.a, softAccept: t0.s, peakAccept: peak(), boundarySec: profile.boundarySec });
    let peakNow = peak();
    let pendingSoft = [];
    const confirmWindow = Math.max(4, profile.periodSec * 2.6);
    let lastSpeechT = -1;
    let heardSince = false, counted = false, quiet = 0;
    /*
     * Rhythm: japa is strongly periodic. Once a few reps have counted we know
     * your period (start-to-start) and the voiced length of a repetition. An
     * utterance that didn't quite pass the acoustic test still counts if it
     *   • lands on the beat (0.7–1.4 periods after the last counted rep),
     *   • is as long as your recent reps (0.8–1.25×) — a half-mantra is ~0.5×,
     *   • has no "missing words" stretch and a reasonable score.
     */
    const hist = [];     // recent counted reps { start, span }
    function remember(e) {
      if (e.start == null || !e.span) return;
      hist.push({ start: e.start, span: e.span });
      if (hist.length > 8) hist.shift();
      if (hist.length >= 3) matcher.setPace(median(hist.map((h) => h.span)) / matcher.M);
    }
    function rhythmOk(n) {
      if (hist.length < 3 || !isFinite(n.score) || n.start == null) return false;
      const per = median(hist.slice(1).map((h, i) => h.start - hist[i].start));
      const spanMed = median(hist.map((h) => h.span));
      const since = n.start - hist[hist.length - 1].start;
      return per > 0.5 &&
        since >= per * 0.7 && since <= per * 1.4 &&
        n.span >= spanMed * 0.8 && n.span <= spanMed * 1.25 &&
        n.peak <= peakNow * 1.1 &&
        n.score <= Math.min(impostor * 0.98, Math.max(thr().s, matcher.accept * 1.3), 0.98);
    }

    function setSensitivity(s) { sens = s; const t = thr(); matcher.setAccept(t.a, t.s, peak()); peakNow = peak(); }

    /** @returns {object} { counts, events, speech, over, progress } */
    function feed(f) {
      const r = norm.step(f);
      if (r.speech) lastSpeechT = f.t;
      const ev = r.vec ? matcher.push(r.vec, f.t) : matcher.idle();
      let counts = 0;
      const events = [];
      if (r.speech) { heardSince = true; quiet = 0; }
      else quiet += HOP_S;
      if (heardSince && quiet >= 0.3) {
        // End of an utterance. If nothing counted in it, try the rhythm check,
        // else report how close it got.
        heardSince = false;
        const near = matcher.takeNearest();
        if (!ev.length && !counted) {
          if (rhythmOk(near)) {
            counts += 1;
            remember(near);
            events.push({ type: "count", rhythm: true, score: near.score, peak: near.peak, span: near.span });
          } else events.push({ type: "miss", score: near.score, peak: near.peak, peakAccept: matcher.peakAccept });
        }
        counted = false;
      }
      for (const e of ev) {
        if (e.soft) {
          if (e.span < matcher.M * 0.8) continue;   // a short borderline match is a partial — drop it
          // Borderline rep: hold it. Chanting is repetitive — if the NEXT rep is
          // a clear match soon after, this one was real (mumbled, half-swallowed).
          // Two borderline reps in a row, at chanting rhythm, confirm each other
          // (otherwise a whole session just over the line would count nothing).
          // Only near-full-length matches are ever held, so halves can't chain.
          // Only reps whose worst stretch is clean may chain — a rough stretch
          // is the signature of a partial repetition.
          const clean = (x) => x.peak <= peakNow;
          const prevSoft = clean(e) ? pendingSoft.filter((p) => clean(p) && e.start - p.end < confirmWindow) : [];
          if (prevSoft.length) {
            counts += prevSoft.length + 1;
            remember(e);
            events.push({ type: "count", score: e.score, peak: e.peak, span: e.span, confirmed: prevSoft.length });
            pendingSoft = [];
            continue;
          }
          pendingSoft.push(e);
          if (pendingSoft.length > 2) pendingSoft.shift();
          events.push({ type: "held", score: e.score, peak: e.peak, span: e.span });
          continue;
        }
        // a held rep is confirmed by the next clear one only if its worst
        // stretch was clean — a rough stretch is what partial mantras look like
        const ok = pendingSoft.filter((p) => p.peak <= peakNow && e.start - p.end < confirmWindow);
        counts += 1 + ok.length;
        remember(e);
        counted = true; matcher.takeNearest();
        events.push({ type: "count", score: e.score, peak: e.peak, span: e.span, confirmed: ok.length });
        pendingSoft = [];
      }
      if (pendingSoft.length && f.t - pendingSoft[pendingSoft.length - 1].end > confirmWindow) pendingSoft = [];
      return { counts, events, speech: r.speech, over: r.over, progress: matcher.progress };
    }

    return {
      feed, setSensitivity,
      get accept() { return matcher.accept; },
      get lastSpeechT() { return lastSpeechT; },
      normState: () => norm.state()
    };
  }

  /** Voice-activity tracker for the calibration UI (before any profile exists). */
  function RoughVad() {
    const hist = [];
    let floor = 0, sp = false, maxRecent = -200, deadRun = 0;
    let speechS = 0, silenceRun = 0;
    function feed(f) {
      hist.push(f.db); if (hist.length > 1500) hist.shift();
      if (hist.length < 10 || hist.length % 10 === 0) floor = percentile(hist, 0.08);
      const over = f.db - floor;
      sp = f.db > ABS_MIN_DB && (sp ? over > VAD_OFF_DB : over > VAD_ON_DB + 1);
      if (sp) { speechS += HOP_S; silenceRun = 0; } else silenceRun += HOP_S;
      deadRun = f.db < -90 ? deadRun + HOP_S : 0;
      return { speech: sp, over, speechS, silenceS: silenceRun, deadMic: deadRun > 2.5 };
    }
    return { feed };
  }

  /** Is a stored profile usable by this engine version? */
  function profileOk(p) {
    return !!(p && p.v === VERSION && Array.isArray(p.template) && p.template.length >= 12);
  }

  return {
    VERSION, HOP_S,
    FeatureExtractor, extractAll, Normalizer, MantraMatcher, LiveCounter, RoughVad,
    learnMantra, matchAll, bestScore, dtwFull, profileOk, fft,
    _internal: { percentile, median, dist, cepstrum, PAUSE_VEC }
  };
});
