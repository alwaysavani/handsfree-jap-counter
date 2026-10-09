/* ============================================================
   miccheck.js — microphone capability diagnostics
   Runs only after a microphone failure, to explain it. Reports on:
     • HTTPS / secure context      • iframe permissions
     • API existence               • device enumeration
     • live getUserMedia result    • error classification
   ============================================================ */
window.MicCheck = (function () {

  async function run() {
    const d = { ts: new Date().toISOString() };

    /* ---- 1. Secure context ---- */
    d.protocol = location.protocol;
    d.hostname = location.hostname;
    try { d.isSecureContext = window.isSecureContext === true; } catch (e) { d.isSecureContext = undefined; }
    const local = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
    d.secureOK = d.protocol === "https:" || (d.protocol === "http:" && local);

    /* ---- iframe (permission policy) ---- */
    try {
      d.inIframe = window !== window.top;
      d.iframe = d.inIframe ? "IN IFRAME — add allow='microphone; *'" : "top-level (not iframe)";
    } catch (e) { d.iframe = "unknown"; }

    /* ---- 2. API existence ---- */
    d.hasMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    d.hasEnumerate = !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices);
    const AC = window.AudioContext || window.webkitAudioContext;
    d.hasAudioContext = !!AC;
    d.hasWorklet = d.hasAudioContext && "audioWorklet" in AC.prototype;
    d.hasVibrate = !!navigator.vibrate;
    d.hasWakeLock = "wakeLock" in navigator;
    d.hasShare = !!navigator.share;

    /* ---- 3. Device enumeration ---- */
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      d.devices = summarize(devs);
      d.deviceCount = d.devices.length;
      d.audioInputs = d.devices.filter(x => x.kind === "audioinput");
    } catch (e) { d.devicesError = String(e); d.deviceCount = -1; d.audioInputs = []; }

    /* ---- 4. Live getUserMedia attempt + error classification ---- */
    const live = await tryGetUserMedia();
    d.liveResult = live.result;          // 'ok-stream' | 'resolved-empty' | 'error' | 'unavailable'
    d.liveError = live.error;
    d.liveErrorCode = live.code;

    d.suggestions = suggest(d);
    return d;
  }

  function summarize(devs) {
    if (!Array.isArray(devs)) return [];
    return devs.map(x => ({ kind: x.kind, label: x.label }));
  }

  function classify(e) {
    const n = (e && e.name) || "";
    const direct = { "NotAllowedError": "User/browser rejected the mic permission prompt.",
                     "PermissionDeniedError": "User/browser rejected the mic permission prompt.",
                     "NotFoundError": "No microphone device was detected.",
                     "DevicesNotFoundError": "No microphone hardware/DSP device was detected.",
                     "NotReadableError": "Hardware issue or another app holds the mic exclusively.",
                     "TrackStartError": "Could not start the audio track (hardware in use).",
                     "SecurityError": "Media capture disabled — insecure context or CSP." };
    if (direct[n]) return { code: n, msg: direct[n] };
    return { code: n || (e ? String(e) : "unknown"), msg: e && e.message ? String(e.message) : String(e) };
  }

  async function tryGetUserMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return { result: "unavailable", error: "navigator.mediaDevices.getUserMedia missing in this build.", code: "NoMediaAPI" };
    }
    try {
      const res = await navigator.mediaDevices.getUserMedia({ audio: true });
      const stream = findStream(res);
      try { res.getTracks().forEach((t) => t.stop()); } catch (e) {}   // diagnostics only — release it
      if (stream) return { result: "ok-stream", error: "", code: "" };
      return {
        result: "resolved-empty",
        error: "getUserMedia resolved but returned NO audio stream. Usually an OS/site-level mic block (see suggestions).",
        code: "EmptyTracks"
      };
    } catch (e) {
      const c = classify(e);
      return { result: "error", error: c.msg, code: c.code };
    }
  }

  function findStream(res) {
    if (!res) return null;
    if (typeof MediaStream !== "undefined" && res instanceof MediaStream) {
      return res.getAudioTracks().length ? res : null;
    }
    if (typeof res.getAudioTracks === "function") {
      return res.getAudioTracks().length ? res : null;
    }
    const c = Array.from(
      (typeof res.getTracks === "function" ? res.getTracks() : null) ||
      (Array.isArray(res.audioTracks) ? res.audioTracks : null) ||
      (Array.isArray(res) ? res : null) || []
    );
    return c.length ? res : null;
  }
  function suggest(d) {
    const s = [];
    if (d.secureOK !== true) s.push("Serve over https:// or http://localhost (it is not a secure context).");
    if (d.inIframe === true) s.push("Add allow='microphone; *' to the embedding <iframe>.");
    if (!d.hasMedia) s.push("No mic API found — update to latest Chrome/Edge (or Safari).");
    if (d.deviceCount === 0) s.push("No devices enumerated — OS mic may be disabled, no input device, or browser not allowed in OS privacy settings.");
    if (d.audioInputs && d.audioInputs.length === 0 && d.deviceCount > 0) s.push("Found devices but no audio input — check the default input device isn't an offline Bluetooth earbud/virtual cable.");
    if (d.liveResult === "error") s.push("getUserMedia error: " + d.liveErrorCode + " — " + d.liveError);
    if (d.liveResult === "resolved-empty") s.push("Most likely: browser blocked in OS mic privacy settings, or this site's Mic permission is set to Block/Ask.");
    if (d.liveResult === "ok-stream") s.push("Mic stream OK — if it still won't start, the engine backend is the issue.");
    return s.slice(0, 5).map((x, i) => (i + 1) + ". " + x);
  }

  /** Compact multi-line rendering for the error modal / console. */
  function render(d) {
    if (!d) return "(no diagnostics)";
    const L = [];
    const kv = (k, v) => L.push(String(k).padEnd(24) + ": " + v);
    kv("secure context (isSecureContext)", d.isSecureContext);
    kv("protocol", d.protocol + "//" + d.hostname);
    kv("secure OK", d.secureOK);
    kv("iframe", d.iframe);
    kv("mediaDevices.getUserMedia", d.hasMedia);
    kv("AudioContext", d.hasAudioContext);
    kv("  audioWorklet", d.hasWorklet);
    kv("wakeLock", d.hasWakeLock);
    kv("devices enumerated", d.deviceCount);
    kv("audio inputs", d.audioInputs ? d.audioInputs.map(x => x.label).join(", ") : "");
    kv("live getUserMedia", d.liveResult);
    if (d.liveError) kv("live error", d.liveErrorCode + ": " + d.liveError);
    L.push("");
    if (d.suggestions) L.push("Suggestions:");
    L.push.apply(L, (d.suggestions || []));
    return L.join("\n");
  }

  return { run, render };
})();
