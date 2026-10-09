/* ============================================================
   storage.js — offline-first persistence via localStorage
   Keys:
     jap.settings        preferences
     jap.customMantras   user-added mantras
     jap.profiles        learned voice template per mantra (numbers only)
     jap.daily           { "YYYY-MM-DD": chants }  (streaks)
     jap.session         current count (resume across reloads)
   ============================================================ */
window.Store = (function () {
  const SET_KEY  = "jap.settings";
  const CUST_KEY = "jap.customMantras";
  const PROF_KEY = "jap.profiles";
  const DAY_KEY  = "jap.daily";
  const SESSION  = "jap.session";

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; /* storage full / unavailable */ }
  }

  const Settings = {
    defaults: {
      theme: "sattvic",
      mantra: "Om Namah Shivaya",
      target: 108,
      sensitivity: 1,        // 0.92 strict · 1 balanced · 1.15 lenient
      tickOn: true,          // soft bead click on every count
      soundOn: true,         // bell when the mala completes
      vibrateOn: true,
      showDetails: false
    },
    load() {
      const s = Object.assign({}, this.defaults, read(SET_KEY, {}));
      delete s.calibrate;    // legacy (pre-v4 engine) profile — no longer used
      if (s.sensitivity === 0.85) s.sensitivity = 0.92;   // Strict was retuned on a real voice
      return s;
    },
    save(s) { write(SET_KEY, s); }
  };

  const CustomMantras = {
    load() { return read(CUST_KEY, []); },
    add(m) {
      const list = this.load();
      m = m.trim();
      if (!m || list.includes(m)) return list;
      list.unshift(m);
      write(CUST_KEY, list.slice(0, 20));
      return list;
    }
  };

  /* ---- learned voice profiles, one per mantra ---- */
  const Profiles = {
    all() { return read(PROF_KEY, {}); },
    get(mantra) { return this.all()[mantra] || null; },
    set(mantra, profile) {
      const all = this.all();
      all[mantra] = Object.assign({}, profile, { savedAt: Date.now() });
      return write(PROF_KEY, all);
    }
  };

  /* ---- daily streak (local calendar days) ---- */
  function dayKey(d) {
    const x = new Date(d);
    return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
  }
  function shiftDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

  const Streak = {
    /** Add chants to a day's tally (negative = correction). */
    add(n, when) {
      const day = dayKey(when || Date.now());
      const daily = read(DAY_KEY, {});
      daily[day] = Math.max(0, (daily[day] || 0) + n);
      if (!daily[day]) delete daily[day];
      write(DAY_KEY, daily);
      return this.stats();
    },
    stats() {
      const daily = read(DAY_KEY, {});
      const now = new Date();
      let cur = daily[dayKey(now)] ? now : shiftDays(now, -1);
      let streak = 0;
      while (daily[dayKey(cur)]) { streak++; cur = shiftDays(cur, -1); }
      return { streak, today: daily[dayKey(now)] || 0 };
    }
  };

  /* ---- session (counter resume across reloads) ---- */
  const Session = {
    load() { return read(SESSION, null); },
    save(s) { write(SESSION, s); },
    clear() { try { localStorage.removeItem(SESSION); } catch (e) {} }
  };

  return { Settings, CustomMantras, Profiles, Streak, Session };
})();
