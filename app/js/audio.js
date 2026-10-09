/* ============================================================
   audio.js — microphone capture + session control (100% on-device)

   Mic PCM ─▶ dsp.js FeatureExtractor ─▶ (calibrating) collect frames
                                       └▶ (counting)    LiveCounter

   The browser's own voice processing is switched OFF: noise suppression
   treats a sustained "Ommm" as stationary noise and fades it out, and
   automatic gain control drifts the level after calibration — both made
   real repetitions go uncounted. dsp.js does its own noise handling.
   No audio ever leaves the device; nothing is stored except the learned
   feature template (numbers, not sound).
   ============================================================ */
window.AudioEngine = (function () {
  "use strict";
  const DSP = window.MantraDSP;
  const AUTO_PAUSE_S = 120;           // silence before auto-pause (battery)
  const CAL_MAX_S = 150;

  let ctx = null, stream = null, src = null, tap = null, sink = null;
  let sampleRate = 48000;
  let mode = "off";                   // off | idle | calibrate | count
  let fx = null;                      // FeatureExtractor for the current run
  let cb = {};

  // calibration state
  let cal = null;                     // { frames, pcm[], pcmLen, vad, lastTry, result }
  let learned = null;                 // { samples, sr } — the learned repetition (playback)
  let lastTeach = null;               // last teach recording (only for "save for troubleshooting")
  let debug = false;                  // keep the last minute of live audio + a match log
  let liveRing = null, livePos = 0, liveFull = false;
  let matchLog = [];
  let player = null;

  // counting state
  let counter = null;
  let countT0 = 0;

  /* ---------------- mic plumbing ---------------- */
  async function getStream() {
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) throw Object.assign(new Error("Microphone API unavailable (needs https:// or localhost)."), { code: "insecure" });
    const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    try { return await md.getUserMedia({ audio: raw }); }
    catch (e) {
      if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) throw Object.assign(e, { code: "denied" });
      if (e && e.name === "NotFoundError") throw Object.assign(e, { code: "nomic" });
      return await md.getUserMedia({ audio: true });   // constraints unsupported → plain mic
    }
  }

  /** Open the mic (inside a user gesture the first time). */
  async function open() {
    if (stream && stream.getAudioTracks().some((t) => t.readyState === "live")) {
      if (ctx && ctx.state === "suspended") await ctx.resume().catch(() => {});
      return true;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw Object.assign(new Error("Web Audio is not supported in this browser."), { code: "noaudio" });
      if (!ctx || ctx.state === "closed") ctx = new AC();
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      stream = await getStream();
      sampleRate = ctx.sampleRate;
      src = ctx.createMediaStreamSource(stream);
      sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
      tap = null;
      if (ctx.audioWorklet && window.AudioWorkletNode) {
        try {
          await ctx.audioWorklet.addModule("js/pcm-worklet.js");
          tap = new AudioWorkletNode(ctx, "pcm-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
          tap.port.onmessage = (ev) => onPcm(ev.data);
        } catch (e) { tap = null; }
      }
      if (!tap) {   // older Safari: ScriptProcessor fallback
        tap = ctx.createScriptProcessor(2048, 1, 1);
        tap.onaudioprocess = (ev) => onPcm(new Float32Array(ev.inputBuffer.getChannelData(0)));
      }
      src.connect(tap); tap.connect(sink);
      // if the OS takes the mic away (call, other app), tell the UI
      stream.getAudioTracks().forEach((t) => { t.onended = () => { release(); emit("onError", { code: "ended", msg: "The microphone was turned off by the system." }); }; });
      if (mode === "off") mode = "idle";
      return true;
    } catch (e) {
      release();
      throw e;
    }
  }

  /** Release the mic completely (privacy indicator off). */
  function release() {
    try { if (tap) { tap.port && (tap.port.onmessage = null); tap.onaudioprocess = null; tap.disconnect(); } } catch (e) {}
    try { if (src) src.disconnect(); } catch (e) {}
    try { if (sink) sink.disconnect(); } catch (e) {}
    if (stream) stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    stream = src = tap = sink = null;
    mode = "off"; counter = null; cal = null; fx = null;
  }

  function emit(name, arg) { try { cb[name] && cb[name](arg); } catch (e) { console.error(e); } }

  /* ---------------- PCM → frames ---------------- */
  function onPcm(chunk) {
    if (!fx || (mode !== "calibrate" && mode !== "count")) return;
    if (mode === "calibrate") { cal.pcm.push(chunk); cal.pcmLen += chunk.length; }
    else if (debug) {
      if (!liveRing || liveRing.length !== sampleRate * 60) { liveRing = new Float32Array(sampleRate * 60); livePos = 0; liveFull = false; }
      for (let i = 0; i < chunk.length; i++) { liveRing[livePos++] = chunk[i]; if (livePos === liveRing.length) { livePos = 0; liveFull = true; } }
    }
    const m = mode;
    for (const f of fx.push(chunk)) {
      if (mode !== m) break;            // calibration finished / paused mid-chunk
      if (m === "calibrate") calFrame(f); else countFrame(f);
    }
  }

  /** 0..1 meter value from a frame's level above the noise floor. */
  function meter(over) { return Math.max(0, Math.min(1, (over - 3) / 30)); }

  /* ---------------- calibration (teach) ---------------- */
  // Repetitions are recorded ONE AT A TIME so the engine knows exactly where
  // each one is (guessing them from a free-form recording failed as soon as
  // someone chanted more than ~3 times).
  const TEACH_REPS = 3;
  const SETTLE_S = 1.2;      // "get ready": measure the room before the first rep
  const END_SIL_S = 1.2;     // this much silence ends a repetition…
  const MIN_REP_S = 0.5;     // …if it had at least this much voice (else: a blip, ignored)
  const MAX_REP_S = 40;

  /**
   * Callbacks:
   *   onCalib({ phase: "settle"|"rep", rep, captured, hearing, level, deadMic, repVoiceS })
   *   onRep({ index, captured })   — a repetition was just recorded
   *   onCalibDone(result)          — learnMantra() result (+ result.captured)
   */
  async function startCalibration(callbacks) {
    cb = callbacks || {};
    await open();
    stopPlayback();
    fx = DSP.FeatureExtractor(sampleRate);
    cal = { frames: [], pcm: [], pcmLen: 0, vad: DSP.RoughVad(), reps: [],
            cur: null, lastVoice: 0 };
    mode = "calibrate";
  }

  function calFrame(f) {
    cal.frames.push(f);
    const v = cal.vad.feed(f);
    const settling = f.t < SETTLE_S;
    {   // capture runs from the start, so a chant begun during "get ready" isn't cut
      if (v.speech) {
        if (!cal.cur) cal.cur = { t0: f.t, voice: 0 };
        cal.cur.voice += DSP.HOP_S;
        cal.lastVoice = f.t;
      }
      const c = cal.cur;
      if (c && !v.speech && f.t - cal.lastVoice >= END_SIL_S) {
        cal.cur = null;
        if (c.voice >= MIN_REP_S) {
          cal.reps.push({ t0: Math.max(0, c.t0 - 0.15), t1: cal.lastVoice + 0.15 });
          emit("onRep", { index: cal.reps.length - 1, captured: cal.reps.length });
        }
      } else if (c && f.t - c.t0 > MAX_REP_S) {
        cal.cur = null;
        cal.reps.push({ t0: c.t0, t1: f.t });
        emit("onRep", { index: cal.reps.length - 1, captured: cal.reps.length });
      }
    }
    emit("onCalib", {
      phase: settling ? "settle" : "rep", settleLeft: Math.max(0, SETTLE_S - f.t),
      rep: cal.reps.length, captured: cal.reps.length, hearing: !settling && !!cal.cur && v.speech,
      repVoiceS: cal.cur ? cal.cur.voice : 0, level: meter(v.over), deadMic: v.deadMic
    });
    if (cal.reps.length >= TEACH_REPS || f.t >= CAL_MAX_S) finishCalibration();
  }

  /** Stop recording and learn (auto after 3 reps, or the user tapped Stop). */
  function finishCalibration() {
    if (mode !== "calibrate" || !cal) return;
    mode = "idle";
    // a repetition still in progress when Stop is tapped counts if it's long enough
    if (cal.cur && cal.cur.voice >= MIN_REP_S) cal.reps.push({ t0: Math.max(0, cal.cur.t0 - 0.15), t1: cal.lastVoice + 0.15 });
    const captured = cal.reps.length;
    let r = captured >= 2 ? DSP.learnMantra(cal.frames, { reps: cal.reps })
      : { ok: false, reason: captured ? "need_more_reps" : (DSP.learnMantra(cal.frames).reason === "no_voice" ? "no_voice" : "need_more_reps") };
    r.captured = captured;
    if (r.ok && r.medoid) {
      // keep just the learned repetition's audio, in memory, for "Hear it"
      const all = new Float32Array(cal.pcmLen);
      let o = 0; for (const c of cal.pcm) { all.set(c, o); o += c.length; }
      const a = Math.max(0, Math.floor((r.medoid.t0 - 0.15) * sampleRate));
      const b = Math.min(all.length, Math.ceil((r.medoid.t1 + 0.2) * sampleRate));
      learned = { samples: all.slice(a, b), sr: sampleRate };
    } else learned = null;
    lastTeach = { frames: cal.frames, pcm: cal.pcm, pcmLen: cal.pcmLen, sr: sampleRate, result: r };
    cal = null; fx = null;
    emit("onCalibDone", r);
  }

  function cancelCalibration() { if (mode === "calibrate") { mode = "idle"; cal = null; fx = null; } }

  /** Play the repetition the app learned (so the user can verify it's complete). */
  function playLearned(onEnd) {
    stopPlayback();
    if (!learned || !ctx) return false;
    const x = learned.samples;
    let peak = 1e-6; for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    const g = Math.min(0.9 / peak, 30);
    const buf = ctx.createBuffer(1, x.length, learned.sr);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < x.length; i++) ch[i] = x[i] * g;
    player = ctx.createBufferSource();
    player.buffer = buf; player.connect(ctx.destination);
    player.onended = () => { player = null; onEnd && onEnd(); };
    player.start();
    return true;
  }
  function stopPlayback() { if (player) { try { player.onended = null; player.stop(); } catch (e) {} player = null; } }
  function hasLearnedAudio() { return !!learned; }

  /* ---------------- counting ---------------- */
  /**
   * Start counting with a learned profile. Callbacks:
   *   onCount({ n, score, accept })  onLevel({ level, speech, progress })
   *   onEvent(e)  (held / rejected matches, for the details readout)
   *   onIdle()    (no voice for 2 min)   onError({code,msg})
   */
  async function startCounting(profile, opts, callbacks) {
    cb = callbacks || {};
    await open();
    stopPlayback();
    fx = DSP.FeatureExtractor(sampleRate);
    counter = DSP.LiveCounter(profile, { sensitivity: (opts && opts.sensitivity) || 1 });
    countT0 = 0;
    mode = "count";
  }

  let levelTick = 0, deadS = 0;
  function countFrame(f) {
    const r = counter.feed(f);
    deadS = f.db < -90 ? deadS + DSP.HOP_S : 0;
    if (!countT0) countT0 = f.t;
    if (debug) for (const e of r.events) { matchLog.push({ t: +f.t.toFixed(2), type: e.type, score: +e.score.toFixed(3), accept: +counter.accept.toFixed(3) }); if (matchLog.length > 500) matchLog.shift(); }
    if (r.counts) emit("onCount", { n: r.counts, score: r.events.length ? r.events[r.events.length - 1].score : null, accept: counter.accept });
    for (const e of r.events) if (e.type !== "count") emit("onEvent", Object.assign({ accept: counter.accept }, e));
    if ((++levelTick & 1) === 0) emit("onLevel", { level: meter(r.over), speech: r.speech, progress: r.progress, deadMic: deadS > 3 });
    const lastVoice = counter.lastSpeechT >= 0 ? counter.lastSpeechT : countT0;
    if (f.t - lastVoice > AUTO_PAUSE_S) { mode = "idle"; emit("onIdle"); }
  }

  /** Stop counting but keep the mic open (quick resume). */
  function pause() { if (mode === "count" || mode === "calibrate") { mode = "idle"; counter = null; cal = null; fx = null; } }
  function setSensitivity(s) { if (counter) counter.setSensitivity(s); }

  /* ---------------- troubleshooting export (local download only) ---------------- */
  function setDebug(on) { debug = !!on; if (!on) { liveRing = null; matchLog = []; } }

  function wavBlob(f32, sr) {
    const n = f32.length, buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) d.setUint8(o + i, t.charCodeAt(i)); };
    str(0, "RIFF"); d.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
    d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
    d.setUint32(24, sr, true); d.setUint32(28, sr * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
    str(36, "data"); d.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, Math.max(-1, Math.min(1, f32[i])) * 32767, true);
    return new Blob([buf], { type: "audio/wav" });
  }

  /**
   * Recordings for troubleshooting: the last teach session and the last
   * minute of live chanting (if "details" was on), plus the match log.
   * Returns null when there's nothing recorded.
   */
  function exportDebug(profile) {
    const out = { files: [] };
    if (lastTeach) {
      const all = new Float32Array(lastTeach.pcmLen);
      let o = 0; for (const c of lastTeach.pcm) { all.set(c, o); o += c.length; }
      out.files.push({ name: "jap-teach.wav", blob: wavBlob(all, lastTeach.sr) });
    }
    if (liveRing && (liveFull || livePos > 0)) {
      const live = liveFull ? new Float32Array(liveRing.length) : liveRing.slice(0, livePos);
      if (liveFull) { live.set(liveRing.subarray(livePos)); live.set(liveRing.subarray(0, livePos), liveRing.length - livePos); }
      out.files.push({ name: "jap-live.wav", blob: wavBlob(live, sampleRate) });
    }
    const info = {
      when: new Date().toISOString(), sampleRate, userAgent: navigator.userAgent,
      teach: lastTeach ? { reps: lastTeach.result && lastTeach.result.reps, ok: lastTeach.result && lastTeach.result.ok,
        reason: lastTeach.result && lastTeach.result.reason, dropped: lastTeach.result && lastTeach.result.dropped } : null,
      profile: profile ? Object.assign({}, profile, { template: undefined, noiseMel: undefined, mu: undefined, sd: undefined }) : null,
      matchLog
    };
    out.files.push({ name: "jap-debug.json", blob: new Blob([JSON.stringify(info, null, 2)], { type: "application/json" }) });
    return out.files.length > 1 ? out : null;
  }

  /* ---------------- test hook ---------------- */
  /**
   * Drive the real pipeline without a microphone (E2E tests): replaces the
   * mic with PCM pushed via __push(samples). Everything downstream —
   * features, VAD, calibration, matching, UI — is the production path.
   */
  const __test = {
    simulate(sr) {
      sampleRate = sr || 16000;
      open = async () => { if (mode === "off") mode = "idle"; return true; };
    },
    push(samples) { onPcm(samples instanceof Float32Array ? samples : Float32Array.from(samples)); },
    mode: () => mode
  };

  return {
    open, release, pause,
    startCalibration, finishCalibration, cancelCalibration,
    playLearned, stopPlayback, hasLearnedAudio,
    startCounting, setSensitivity,
    setDebug, exportDebug,
    __test
  };
})();
