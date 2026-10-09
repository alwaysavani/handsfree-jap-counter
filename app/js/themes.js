/* ============================================================
   themes.js — 5 curated palettes, applied as CSS custom properties
   ============================================================ */
window.Themes = (function () {
  const THEMES = [
    { id: "sattvic",   name: "Sattvic Creme",    dark: false,
      bg: "#FBF7F0", surface: "#FFFFFF", accent: "#C8540A", gold: "#C9A13B", text: "#2A1E14", muted: "#7C6D5F" },
    { id: "utsav",     name: "Utsav Kumkum",     dark: true,
      bg: "#3A070D", surface: "#4C0D15", accent: "#FFC23D", gold: "#E9B44C", text: "#FFF6EA", muted: "#D9A3A9" },
    { id: "obsidian",  name: "Temple Obsidian",  dark: true,
      bg: "#0A0908", surface: "#16130F", accent: "#FF8A1F", gold: "#E8B65A", text: "#F3ECE1", muted: "#9E9388" },
    { id: "vrindavan", name: "Vrindavan Garden", dark: true,
      bg: "#0D1E16", surface: "#142B20", accent: "#F2829A", gold: "#D2BE7C", text: "#F2EEE4", muted: "#A6B79C" },
    { id: "vedic",     name: "Vedic Cosmos",     dark: true,
      bg: "#0A1229", surface: "#121D3D", accent: "#E8B06F", gold: "#F0D39E", text: "#F1EEE6", muted: "#9AADC9" }
  ];

  function rgba(hex, a) {
    const h = hex.replace("#", "");
    return `rgba(${parseInt(h.substr(0, 2), 16)},${parseInt(h.substr(2, 2), 16)},${parseInt(h.substr(4, 2), 16)},${a})`;
  }

  function apply(t) {
    if (!t) return;
    const root = document.documentElement;
    const set = (k, v) => root.style.setProperty(k, v);
    set("--bg", t.bg);
    set("--surface", t.surface);
    set("--accent", t.accent);
    set("--accent-soft", rgba(t.accent, t.dark ? 0.16 : 0.10));
    set("--accent-glow", rgba(t.accent, t.dark ? 0.38 : 0.28));
    set("--gold", t.gold);
    set("--text", t.text);
    set("--muted", t.muted);
    set("--line", rgba(t.text, t.dark ? 0.14 : 0.11));
    set("--bead-off", rgba(t.text, t.dark ? 0.16 : 0.13));
    set("--on-accent", t.dark ? t.bg : "#FFFFFF");
    set("--scrim", t.dark ? "rgba(0,0,0,.6)" : "rgba(42,30,20,.38)");
    root.dataset.theme = t.id;
    root.style.colorScheme = t.dark ? "dark" : "light";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t.bg);
  }

  function byId(id) { return THEMES.find((t) => t.id === id) || THEMES[0]; }

  return { list: THEMES, apply, byId };
})();
