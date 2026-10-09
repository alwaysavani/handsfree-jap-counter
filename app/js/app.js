/* ============================================================
   app.js — UI controller
   States: idle → (teach) → running ⇄ paused → done
   ============================================================ */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const DSP = window.MantraDSP;

  const PRESETS = [
    { name: "Om Namah Shivaya",       dev: "ॐ नमः शिवाय" },
    { name: "Hare Krishna",           dev: "हरे कृष्ण हरे कृष्ण कृष्ण कृष्ण हरे हरे" },
    { name: "Om Gam Ganapataye Namah", dev: "ॐ गं गणपतये नमः" },
    { name: "Gayatri Mantra",         dev: "ॐ भूर्भुवः स्वः तत्सवितुर्वरेण्यम्" },
    { name: "Mahamrityunjaya Mantra", dev: "ॐ त्र्यम्बकं यजामहे सुगन्धिं पुष्टिवर्धनम्" },
    { name: "Om Namo Narayanaya",     dev: "ॐ नमो नारायणाय" },
    { name: "Shri Ram Jai Ram",       dev: "श्री राम जय राम जय जय राम" }
  ];
  const devOf = (m) => (PRESETS.find((p) => p.name === m) || {}).dev || "";

  /* ---------------- state ---------------- */
  const S = Store.Settings.load();
  let mode = "idle";              // idle | running | paused | done
  let count = 0;
  let startedAt = null;           // ms epoch, current mala
  let wakeLock = null;
  let lvl = 0;

  const el = {
    app: $("#app"), mala: $("#mala"), beads: $("#beads"), repArc: $("#rep-arc"),
    count: $("#count"), countSub: $("#count-sub"),
    status: $("#status"), statusText: $("#status-text"), details: $("#details"),
    mantraName: $("#mantra-name"), mantraDev: $("#mantra-dev"),
    streak: $("#streak"), streakNum: $("#streak-num"),
    main: $("#btn-main"), mainLabel: $("#main-label"),
    toast: $("#toast")
  };

  /* ---------------- profile helpers ---------------- */
  function profile() {
    const p = Store.Profiles.get(S.mantra);
    return DSP.profileOk(p) ? p : null;
  }

  /* ---------------- session persistence ---------------- */
  function saveSession() {
    const s = Store.Session.load() || {};
    s.byMantra = s.byMantra || {};
    s.byMantra[S.mantra] = { count, startedAt };
    s.wasRunning = mode === "running";
    Store.Session.save(s);
  }
  function loadCountFor(m) {
    const s = Store.Session.load();
    const r = s && s.byMantra && s.byMantra[m];
    count = r ? r.count || 0 : 0;
    startedAt = r ? r.startedAt || null : null;
  }

  /* ---------------- rendering ---------------- */
  let beadCount = 0;
  function beadsFor() { return S.target > 0 && S.target <= 108 ? S.target : 108; }

  function buildBeads() {
    const B = beadsFor();
    if (B === beadCount) return;
    beadCount = B;
    const R = 186, cx = 200, cy = 200, gap = (B <= 21 ? 14 : 7) * Math.PI / 180;
    const r = B <= 21 ? 9.5 : B <= 54 ? 6.6 : 4.7;
    const ns = "http://www.w3.org/2000/svg";
    el.beads.textContent = "";
    for (let i = 0; i < B; i++) {
      const a = -Math.PI / 2 + gap + (i / (B - 1)) * (2 * Math.PI - 2 * gap);
      const c = document.createElementNS(ns, "circle");
      c.setAttribute("cx", (cx + R * Math.cos(a)).toFixed(2));
      c.setAttribute("cy", (cy + R * Math.sin(a)).toFixed(2));
      c.setAttribute("r", r);
      c.setAttribute("class", "bead");
      el.beads.appendChild(c);
    }
  }

  function renderCount(bump) {
    buildBeads();
    const B = beadCount;
    let filled;
    if (S.target > 0 && S.target <= 108) filled = Math.min(count, S.target);
    else filled = count === 0 ? 0 : (count % 108 || 108);
    const nodes = el.beads.children;
    for (let i = 0; i < B; i++) {
      nodes[i].classList.toggle("on", i < filled);
      nodes[i].classList.remove("now");
    }
    if (bump && filled > 0) {
      nodes[filled - 1].classList.add("now");
    }
    el.count.textContent = String(count);
    if (bump) { el.count.classList.remove("bump"); void el.count.offsetWidth; el.count.classList.add("bump"); }
    if (S.target > 0) {
      el.countSub.textContent = S.target > 108
        ? `of ${S.target} · mala ${Math.min(Math.floor(count / 108) + 1, Math.ceil(S.target / 108))}`
        : `of ${S.target}`;
    } else {
      el.countSub.textContent = count >= 108 ? `mala ${Math.floor(count / 108) + (count % 108 ? 1 : 0)}` : "no limit";
    }
  }

  function renderMantra() {
    el.mantraName.textContent = S.mantra;
    el.mantraDev.textContent = devOf(S.mantra);
    document.querySelectorAll(".teach-mantra").forEach((n) => { n.textContent = S.mantra; });
  }

  function renderStreak() {
    const st = Store.Streak.stats();
    el.streak.hidden = st.streak < 1;
    el.streakNum.textContent = String(st.streak);
    el.streak.title = `${st.streak}-day streak · ${st.today} chants today`;
  }

  function setStatus(text, state) {
    el.statusText.textContent = text;
    el.status.dataset.state = state || "idle";
  }

  function idleStatus() {
    if (mode === "done") return setStatus("Mala complete", "idle");
    if (mode === "paused") return setStatus("Paused", "paused");
    if (!profile()) return setStatus("Teach this mantra once to begin", "idle");
    setStatus(count > 0 ? "Tap start to continue" : "Tap start and chant", "idle");
  }

  function renderMain() {
    const on = mode === "running";
    el.main.classList.toggle("is-on", on);
    const label = on ? "Pause" : mode === "paused" ? "Resume" : mode === "done" ? "New mala" : profile() ? "Start" : "Teach";
    el.mainLabel.textContent = label;
    el.main.setAttribute("aria-label", on ? "Pause listening" : label === "Teach" ? "Teach this mantra" : label + " chanting");
  }

  function setDetails(text) {
    el.details.hidden = !S.showDetails || !text;
    el.details.textContent = text || "";
  }

  let toastT = null;
  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => el.toast.classList.remove("show"), ms || 2400);
  }

  /* ---------------- sheets ---------------- */
  let openSheet = null, lastFocus = null;
  function showSheet(id) {
    if (openSheet) hideSheet(true);
    const sh = $(id);
    lastFocus = document.activeElement;
    sh.hidden = false;
    openSheet = sh;
    const f = sh.querySelector(".step[data-step='" + (sh.dataset.step || "") + "'] .btn.primary") ||
              sh.querySelector(".btn.primary, [data-close], button");
    if (f) setTimeout(() => f.focus({ preventScroll: true }), 30);
  }
  function hideSheet(silent) {
    if (!openSheet) return;
    const sh = openSheet;
    openSheet = null;
    sh.hidden = true;
    if (sh.id === "sheet-teach") onTeachClosed();
    if (!silent && lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) hideSheet();
    else if (openSheet && e.target === openSheet) hideSheet();   // scrim tap
  });

  /* ---------------- wake lock ---------------- */
  async function lockScreen() {
    try {
      if ("wakeLock" in navigator && !wakeLock && document.visibilityState === "visible") {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch (e) { wakeLock = null; }
  }
  function unlockScreen() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }

  /* ---------------- listening ---------------- */
  async function startListening() {
    const p = profile();
    if (!p) { openTeach(); return; }
    if (mode === "done" || (S.target > 0 && count >= S.target)) newMala();
    setStatus("Starting microphone…", "idle");
    try {
      await AudioEngine.startCounting(p, { sensitivity: S.sensitivity }, {
        onCount, onLevel, onEvent,
        onIdle: () => { pause("idle"); },
        onError: (e) => { pause(); showMicError(e); }
      });
    } catch (e) { mode = "idle"; renderMain(); idleStatus(); showMicError(e); return; }
    mode = "running";
    if (!startedAt) startedAt = Date.now();
    saveSession();
    renderMain();
    setStatus("Listening", "listening");
    setDetails(`listening · match threshold ${(p.accept * S.sensitivity).toFixed(2)}`);
    lockScreen();
  }

  function pause(reason) {
    if (mode !== "running") return;
    AudioEngine.pause();
    if (reason === "idle") AudioEngine.release();
    mode = "paused";
    lvl = 0; el.mala.style.setProperty("--lvl", "0");
    el.repArc.style.strokeDashoffset = "100";
    unlockScreen();
    saveSession();
    renderMain();
    if (reason === "idle") setStatus("Paused after 2 minutes of silence", "paused");
    else idleStatus();
  }

  function onCount(ev) {
    for (let i = 0; i < ev.n; i++) increment(true);
    if (ev.score != null) setDetails(`✓ counted · score ${ev.score.toFixed(2)} (≤ ${ev.accept.toFixed(2)})${ev.n > 1 ? " · +" + (ev.n - 1) + " confirmed" : ""}`);
  }

  function onEvent(e) {
    const why = e.type === "held" ? "borderline — will count if the next one matches"
      : e.type === "miss" ? "no count" : e.type;
    const sc = e.score === Infinity || e.score == null ? "no full-length match (too short?)"
      : `${e.type === "miss" ? "closest" : "score"} ${e.score.toFixed(2)} (needs ≤ ${e.accept.toFixed(2)})`;
    setDetails(`${why} · ${sc}`);
  }

  let statusHold = 0;
  function onLevel(l) {
    lvl = Math.max(l.level, lvl * 0.82);
    el.mala.style.setProperty("--lvl", lvl.toFixed(3));
    el.repArc.style.strokeDashoffset = String(Math.round(100 - l.progress * 100));
    if (mode !== "running" || Date.now() < statusHold) return;
    if (l.deadMic) setStatus("No sound from the microphone — is it muted?", "warn");
    else if (l.speech) setStatus("Hearing you…", "hearing");
    else setStatus("Listening", "listening");
  }

  /* ---------------- counting ---------------- */
  function increment(fromVoice) {
    if (mode === "done") return;
    if (S.target > 0 && count >= S.target) return;
    count++;
    if (!startedAt) startedAt = Date.now();
    Store.Streak.add(1);
    renderCount(true);
    renderStreak();
    saveSession();
    if (S.tickOn) Chime.bead();
    if (S.vibrateOn) Chime.vibrate([22]);
    if (fromVoice) { statusHold = Date.now() + 700; setStatus(`Counted ${count}`, "hearing"); }
    if (S.target > 0 && count >= S.target) complete();
    else if (count % 108 === 0) {          // a full mala inside 1008 / no-limit
      if (S.soundOn) Chime.ring(3, 0.35);
      toast(`Mala ${count / 108} complete`);
    }
  }

  function decrement() {
    if (count <= 0) return;
    if (mode === "done") mode = "paused";
    count--;
    Store.Streak.add(-1);
    renderCount(false);
    renderStreak();
    saveSession();
    renderMain();
    if (mode !== "running") idleStatus();
  }

  function newMala() {
    count = 0;
    startedAt = null;
    if (mode === "done") mode = "idle";
    renderCount(false);
    saveSession();
  }

  /* ---------------- completion ---------------- */
  function complete() {
    if (mode === "running") { AudioEngine.pause(); unlockScreen(); }
    AudioEngine.release();
    mode = "done";
    el.mala.style.setProperty("--lvl", "0");
    el.repArc.style.strokeDashoffset = "100";
    if (S.soundOn) Chime.ring();
    if (S.vibrateOn) Chime.vibrate([80, 60, 80, 60, 140]);
    renderMain();
    idleStatus();
    saveSession();
    const st = Store.Streak.stats();
    const minutes = startedAt ? Math.max(1, Math.round((Date.now() - startedAt) / 60000)) : 0;
    $("#done-body").textContent = `${count} × ${S.mantra}` + (minutes ? ` · ${minutes} min` : "") + (st.streak > 1 ? ` · ${st.streak}-day streak` : "");
    const data = { theme: Themes.byId(S.theme), mantra: S.mantra, count, minutes, streak: st.streak, beads: beadsFor() };
    const card = Share.buildCard(data);
    const prev = $("#card-preview");
    prev.textContent = ""; prev.appendChild(card);
    doneData = data; doneCard = card;
    setTimeout(() => showSheet("#sheet-done"), 600);
  }
  let doneData = null, doneCard = null;

  /* ---------------- teach (calibration) ---------------- */
  const teach = $("#sheet-teach");
  const wave = $("#teach-wave");
  const waveCtx = wave.getContext("2d");
  let waveHist = [];
  let teaching = false;
  let keepMic = false;          // closing the teach sheet straight into counting

  function teachStep(step) {
    teach.dataset.step = step;
  }

  function openTeach() {
    if (mode === "running") pause();
    renderMantra();
    teachStep("intro");
    showSheet("#sheet-teach");
  }

  let teachT0 = 0, teachTimer = null, gotItUntil = 0;
  async function beginListeningForTeach() {
    Chime.unlock();
    teachStep("listen");
    waveHist = [];
    drawWave();
    $("#btn-teach-done").disabled = true;
    $("#btn-teach-done").hidden = true;
    setRepSteps(0, false);
    setRec("ready", "Get ready");
    $("#teach-step-title").textContent = "Get ready…";
    $("#teach-step-sub").textContent = "Stay quiet for a moment while I listen to the room.";
    $("#teach-hint").textContent = "";
    $("#rec-time").textContent = "0:00";
    try {
      await AudioEngine.startCalibration({ onCalib, onRep, onCalibDone });
      teaching = true;
      teachT0 = 0;
    } catch (e) {
      hideSheet(true);
      showMicError(e);
    }
  }

  function setRec(state, label) {
    const pill = $("#rec-pill");
    if (pill.dataset.state !== state) pill.dataset.state = state;
    $("#rec-label").textContent = label;
  }

  function setRepSteps(captured, hearing) {
    const items = $("#rep-steps").children;
    for (let i = 0; i < items.length; i++) {
      items[i].classList.toggle("done", i < captured);
      items[i].classList.toggle("now", i === captured);
      items[i].classList.toggle("hearing", i === captured && hearing);
    }
    $("#rep-steps").setAttribute("aria-label", `${captured} of 3 repetitions recorded`);
  }

  const ORD = ["first", "second", "third"];
  function onCalib(c) {
    // Tall orange bars = your chanting being recorded; a faint grey ripple =
    // background sound (shows the mic is alive without looking like a detection).
    waveHist.push(c.hearing ? { v: Math.max(0.18, c.level), voice: true } : { v: Math.min(0.12, c.level * 0.25), voice: false });
    if (waveHist.length > 300) waveHist.shift();
    if (waveHist.length % 2 === 0) drawWave();
    if (c.phase === "settle") {
      setRec("ready", "Get ready");
      $("#teach-step-title").textContent = `Get ready… ${Math.ceil(c.settleLeft)}`;
      return;
    }
    if (!teachT0) { teachT0 = Date.now(); Chime.vibrate([40]); }
    const secs = Math.floor((Date.now() - teachT0) / 1000);
    $("#rec-time").textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    setRec(c.hearing ? "hearing" : "rec", c.hearing ? "Recording · hearing you" : "Recording");
    setRepSteps(c.captured, c.hearing);
    $("#btn-teach-done").disabled = c.captured < 2;
    $("#btn-teach-done").hidden = c.captured < 2;
    if (Date.now() < gotItUntil) return;
    const n = Math.min(c.captured, 2);
    $("#teach-step-title").textContent = `Repetition ${n + 1} of 3`;
    const hint = $("#teach-hint");
    if (c.deadMic) {
      $("#teach-step-sub").textContent = "No sound from the microphone.";
      hint.textContent = "Is it muted, or being used by another app?";
    } else if (c.hearing) {
      $("#teach-step-sub").textContent = `Hearing you — finish the ${ORD[n]} repetition, then pause.`;
      hint.textContent = "";
    } else {
      $("#teach-step-sub").textContent = `Chant ${S.mantra} once now.`;
      hint.textContent = c.repVoiceS > 0 ? "Waiting for the pause that ends this repetition…" : "Then pause — I'll move on automatically.";
    }
  }

  function onRep(r) {
    Chime.bead();
    Chime.vibrate([30]);
    setRepSteps(r.captured, false);
    gotItUntil = Date.now() + 900;
    $("#teach-step-title").textContent = r.captured >= 3 ? "Got all 3 ✓" : `Got it ✓`;
    $("#teach-step-sub").textContent = r.captured >= 3 ? "Recording stopped. Learning your mantra…" : `Repetition ${r.captured} recorded. Now the ${ORD[r.captured]}…`;
    if (r.captured >= 3) setRec("stopped", "Recording stopped");
  }

  function drawWave() {
    const w = wave.width, h = wave.height, n = 150, bw = w / n;
    waveCtx.clearRect(0, 0, w, h);
    const cs = getComputedStyle(document.documentElement);
    const accent = cs.getPropertyValue("--accent").trim() || "#C8540A";
    const off = cs.getPropertyValue("--bead-off").trim() || "rgba(0,0,0,.12)";
    const data = waveHist.slice(-n);
    for (let i = 0; i < n; i++) {
      const d = data[i - (n - data.length)] || { v: 0, voice: false };
      const bh = Math.max(2, d.v * (h - 16));
      waveCtx.fillStyle = d.voice ? accent : off;
      waveCtx.fillRect(i * bw + 1, (h - bh) / 2, Math.max(1, bw - 2), bh);
    }
  }

  const REASONS = {
    no_voice: ["I couldn't hear you", "Check that the microphone isn't muted, move a little closer, and chant at your normal volume."],
    too_short: ["That was very short", "Chant the mantra 3 times, with a short breath between each."],
    too_little_voice: ["I need a little more", "Chant the full mantra 3 times, with a short breath between each."],
    need_more_reps: ["I need at least 2 repetitions", "Chant the mantra once, pause for a second, and repeat — the screen shows each repetition as it's recorded."],
    reps_differ: ["The repetitions sounded different", "Make sure each one is the complete mantra, chanted the same way. Let's record them again."]
  };

  function onCalibDone(r) {
    teaching = false;
    setRec("stopped", "Recording stopped");
    teachStep("result");
    const icon = $("#teach-result-icon");
    const play = $("#btn-teach-play");
    if (r.ok) {
      Store.Profiles.set(S.mantra, r.profile);
      icon.className = "step-icon ok";
      icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
      $("#teach-result-title").textContent = "Mantra learned";
      const skipped = r.dropped ? ` (${r.dropped} sounded different and was skipped)` : "";
      $("#teach-result-body").textContent =
        `Learned from ${r.profile.nReps} repetitions, about ${r.profile.repSec.toFixed(1)} s of chanting each${skipped}. From now on each full repetition of ${S.mantra} adds one.`;
      play.hidden = !AudioEngine.hasLearnedAudio();
      $("#teach-play-hint").hidden = play.hidden;
      $("#btn-teach-start").textContent = "Start chanting";
      $("#btn-teach-again").textContent = "Teach again";
      renderMain(); idleStatus(); refreshVoiceRow();
    } else {
      const [title, body] = REASONS[r.reason] || REASONS.need_more_reps;
      icon.className = "step-icon bad";
      icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>';
      $("#teach-result-title").textContent = title;
      $("#teach-result-body").textContent = body;
      play.hidden = true; $("#teach-play-hint").hidden = true;
      $("#btn-teach-start").textContent = "Try again";
      $("#btn-teach-again").textContent = "Cancel";
      teach.dataset.failed = "1";
      return;
    }
    teach.dataset.failed = "";
    setTimeout(() => $("#btn-teach-start").focus({ preventScroll: true }), 30);
  }

  function onTeachClosed() {
    if (teaching) { AudioEngine.cancelCalibration(); teaching = false; }
    AudioEngine.stopPlayback();
    if (!keepMic && mode !== "running") AudioEngine.release();
    keepMic = false;
  }

  $("#btn-teach-go").addEventListener("click", beginListeningForTeach);
  $("#btn-teach-done").addEventListener("click", () => AudioEngine.finishCalibration());
  $("#btn-teach-cancel").addEventListener("click", () => hideSheet());
  $("#btn-teach-start").addEventListener("click", () => {
    if (teach.dataset.failed === "1") { beginListeningForTeach(); return; }
    keepMic = true;
    hideSheet(true);
    startListening();
  });
  $("#btn-teach-again").addEventListener("click", () => {
    if (teach.dataset.failed === "1") { hideSheet(); return; }
    beginListeningForTeach();
  });
  $("#btn-teach-play").addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (b.dataset.playing === "1") { AudioEngine.stopPlayback(); b.dataset.playing = ""; b.querySelector("span").textContent = "Hear what I learned"; return; }
    if (AudioEngine.playLearned(() => { b.dataset.playing = ""; b.querySelector("span").textContent = "Hear what I learned"; })) {
      b.dataset.playing = "1"; b.querySelector("span").textContent = "Stop";
    }
  });

  /* ---------------- mantra picker ---------------- */
  function renderMantraList() {
    const list = $("#mantra-list");
    list.textContent = "";
    const customs = Store.CustomMantras.load();
    const all = PRESETS.map((p) => ({ name: p.name, dev: p.dev, custom: false }))
      .concat(customs.map((c) => ({ name: c, dev: "", custom: true })));
    const profiles = Store.Profiles.all();
    for (const m of all) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.className = "mantra-row";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(m.name === S.mantra));
      b.dataset.mantra = m.name;
      const learned = DSP.profileOk(profiles[m.name]);
      b.innerHTML = '<svg class="mr-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' +
        '<span class="mr-text"><span class="mr-name"></span><span class="mr-dev"></span></span>' +
        `<span class="mr-badge${learned ? "" : " todo"}">${learned ? "Voice learned" : "Not taught"}</span>`;
      b.querySelector(".mr-name").textContent = m.name;
      b.querySelector(".mr-dev").textContent = m.dev || (m.custom ? "Your mantra" : "");
      li.appendChild(b);
      list.appendChild(li);
    }
  }

  function selectMantra(m) {
    if (m === S.mantra) return;
    if (mode === "running") pause();
    saveSession();
    S.mantra = m;
    Store.Settings.save(S);
    loadCountFor(m);
    if (mode === "done") mode = "idle";
    if (mode === "paused" && count === 0) mode = "idle";
    renderMantra(); renderCount(false); renderMain(); idleStatus(); setDetails("");
  }

  $("#btn-mantra").addEventListener("click", () => { renderMantraList(); showSheet("#sheet-mantra"); });
  $("#mantra-list").addEventListener("click", (e) => {
    const b = e.target.closest(".mantra-row");
    if (!b) return;
    selectMantra(b.dataset.mantra);
    hideSheet();
    if (!profile()) setTimeout(openTeach, 250);
  });
  $("#form-add-mantra").addEventListener("submit", (e) => {
    e.preventDefault();
    const inp = $("#custom-mantra");
    const m = inp.value.trim().replace(/\s+/g, " ");
    if (!m) { inp.focus(); return; }
    Store.CustomMantras.add(m);
    inp.value = "";
    selectMantra(m);
    hideSheet();
    setTimeout(openTeach, 250);
  });

  /* ---------------- settings ---------------- */
  function markSeg(sel, val) {
    document.querySelectorAll(sel + " button").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.v) === Number(val))));
  }
  function refreshVoiceRow() {
    const p = profile();
    $("#voice-state").textContent = p ? `“${S.mantra}” learned` : `“${S.mantra}” not taught yet`;
    $("#voice-sub").textContent = p ? `${p.nReps} repetitions · ${new Date(p.savedAt || Date.now()).toLocaleDateString()}` : "Needed for hands-free counting";
    $("#btn-reteach").textContent = p ? "Teach again" : "Teach now";
  }
  function renderSettings() {
    markSeg("#seg-target", S.target);
    markSeg("#seg-sens", S.sensitivity);
    const sw = $("#swatches");
    sw.textContent = "";
    for (const t of Themes.list) {
      const b = document.createElement("button");
      b.className = "swatch";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(t.id === S.theme));
      b.setAttribute("aria-label", t.name);
      b.title = t.name;
      b.dataset.theme = t.id;
      const i = document.createElement("i");
      i.style.background = `linear-gradient(135deg, ${t.bg} 0 50%, ${t.accent} 50% 100%)`;
      b.appendChild(i);
      sw.appendChild(b);
    }
    $("#opt-tick").checked = !!S.tickOn;
    $("#opt-sound").checked = !!S.soundOn;
    $("#opt-vibrate").checked = !!S.vibrateOn;
    $("#opt-details").checked = !!S.showDetails;
    $("#btn-debug").hidden = !S.showDetails;
    refreshVoiceRow();
  }

  $("#btn-settings").addEventListener("click", () => { renderSettings(); showSheet("#sheet-settings"); });
  $("#seg-target").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.target = Number(b.dataset.v);
    Store.Settings.save(S);
    markSeg("#seg-target", S.target);
    if (mode === "done" && (S.target === 0 || count < S.target)) mode = "paused";
    renderCount(false); renderMain();
    if (mode !== "running") idleStatus();
  });
  $("#seg-sens").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.sensitivity = Number(b.dataset.v);
    Store.Settings.save(S);
    markSeg("#seg-sens", S.sensitivity);
    AudioEngine.setSensitivity(S.sensitivity);
  });
  $("#swatches").addEventListener("click", (e) => {
    const b = e.target.closest(".swatch"); if (!b) return;
    S.theme = b.dataset.theme;
    Store.Settings.save(S);
    Themes.apply(Themes.byId(S.theme));
    document.querySelectorAll(".swatch").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  });
  const bindToggle = (id, key, after) => $(id).addEventListener("change", (e) => { S[key] = e.target.checked; Store.Settings.save(S); after && after(); });
  bindToggle("#opt-tick", "tickOn", () => S.tickOn && Chime.bead());
  bindToggle("#opt-sound", "soundOn");
  bindToggle("#opt-vibrate", "vibrateOn", () => S.vibrateOn && Chime.vibrate([30]));
  bindToggle("#opt-details", "showDetails", () => {
    setDetails(S.showDetails ? "details on" : "");
    AudioEngine.setDebug(S.showDetails);
    $("#btn-debug").hidden = !S.showDetails;
  });
  $("#btn-debug").addEventListener("click", () => {
    const out = AudioEngine.exportDebug(profile());
    if (!out) { toast("Nothing recorded yet — teach or chant first"); return; }
    out.files.forEach((f, i) => setTimeout(() => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(f.blob); a.download = f.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, i * 400));
    toast("Saved to your device — nothing was uploaded");
  });
  $("#btn-reteach").addEventListener("click", () => { hideSheet(true); openTeach(); });

  /* ---------------- completion sheet ---------------- */
  $("#btn-share").addEventListener("click", async () => {
    if (!doneCard) return;
    const r = await Share.shareCard(doneCard, Share.message(doneData));
    if (r === "downloaded") toast("Image saved");
  });
  $("#btn-wa").addEventListener("click", () => {
    if (!doneData) return;
    window.open(Share.whatsappUrl(Share.message(doneData)), "_blank", "noopener");
  });
  $("#btn-save").addEventListener("click", () => { if (doneCard) { Share.download(doneCard); toast("Image saved"); } });
  $("#btn-again").addEventListener("click", () => { hideSheet(true); newMala(); startListening(); });

  /* ---------------- reset ---------------- */
  $("#btn-reset").addEventListener("click", () => {
    if (count === 0) { toast("Count is already 0"); return; }
    showSheet("#sheet-confirm");
  });
  $("#btn-confirm-yes").addEventListener("click", () => {
    hideSheet();
    const wasRunning = mode === "running";
    newMala();
    if (!wasRunning) { mode = "idle"; renderMain(); idleStatus(); }
    toast("Count reset");
  });

  /* ---------------- mic errors ---------------- */
  async function showMicError(e) {
    const code = (e && e.code) || (e && e.name) || "";
    let title = "Microphone needed", html;
    if (code === "denied" || code === "NotAllowedError") {
      html = "<p>Jap Counter needs the microphone to count your chants hands-free. It's processed on this device only.</p>" +
        "<ol><li>Tap the lock / settings icon next to the address bar.</li><li>Set <b>Microphone</b> to <b>Allow</b>.</li><li>Come back and tap <b>Try again</b>.</li></ol>" +
        "<p class='tiny'>On iPhone: Settings ▸ Safari ▸ Microphone ▸ Allow. On Android: Chrome ▸ Site settings ▸ Microphone.</p>";
    } else if (code === "insecure") {
      title = "Open over https";
      html = "<p>Browsers only allow the microphone on secure pages. Open this app with an <b>https://</b> address (or <b>localhost</b> during development).</p>";
    } else if (code === "nomic" || code === "NotFoundError") {
      title = "No microphone found";
      html = "<p>Connect a microphone (or check that your headset is switched on) and try again.</p>";
    } else if (code === "ended") {
      title = "Microphone stopped";
      html = "<p>The system took the microphone away — perhaps a call or another app. Tap <b>Try again</b> to continue.</p>";
    } else {
      html = "<p>The microphone couldn't be started. Close other apps that may be using it, then try again.</p>";
    }
    $("#err-title").textContent = title;
    $("#err-body").innerHTML = html;
    if (e && e.message && !/denied|insecure|nomic|ended/.test(code)) {
      const p = document.createElement("p");
      p.className = "tiny"; p.textContent = e.message;
      $("#err-body").appendChild(p);
    }
    $("#err-diag-wrap").hidden = true;
    showSheet("#sheet-error");
    try {
      const d = await MicCheck.run();
      $("#err-diag").textContent = MicCheck.render(d);
      $("#err-diag-wrap").hidden = false;
    } catch (x) {}
  }
  $("#btn-err-retry").addEventListener("click", () => { hideSheet(true); onMain(); });

  /* ---------------- main controls ---------------- */
  function onMain() {
    Chime.unlock();
    if (mode === "running") { pause(); return; }
    if (!profile()) { openTeach(); return; }
    startListening();
  }
  el.main.addEventListener("click", onMain);
  $("#btn-plus").addEventListener("click", () => { Chime.unlock(); if (mode === "done") return; increment(false); if (mode === "idle") renderMain(); });
  $("#btn-minus").addEventListener("click", decrement);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openSheet) { hideSheet(); return; }
    if (openSheet || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === " " && !e.target.closest("button")) { e.preventDefault(); onMain(); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); increment(false); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); decrement(); }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && mode === "running") {
      lockScreen();
      AudioEngine.open().catch((e) => { pause(); showMicError(e); });   // iOS suspends audio in the background
    }
  });
  window.addEventListener("pagehide", saveSession);

  /* ---------------- boot ---------------- */
  function init() {
    Themes.apply(Themes.byId(S.theme));
    AudioEngine.setDebug(S.showDetails);
    loadCountFor(S.mantra);
    const s = Store.Session.load();
    if (count > 0) mode = (S.target > 0 && count >= S.target) ? "done" : "paused";
    if (s && s.wasRunning && count > 0) mode = "paused";
    renderMantra();
    renderCount(false);
    renderStreak();
    renderMain();
    idleStatus();
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  }

  // debugging / tests
  window.__app = { state: () => ({ count, mode, target: S.target, mantra: S.mantra, hasProfile: !!profile() }) };

  init();
})();
