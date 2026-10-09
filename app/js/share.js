/* ============================================================
   share.js — in-browser achievement card (Canvas) + share helpers
   ============================================================ */
window.Share = (function () {
  const W = 1080, H = 1350; // 4:5 portrait (WhatsApp status friendly)

  /** Draw the card; returns the <canvas>. */
  function buildCard(o) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    const t = o.theme;
    const ink = t.text, soft = t.muted;

    c.fillStyle = t.bg; c.fillRect(0, 0, W, H);
    const glow = c.createRadialGradient(W / 2, 560, 40, W / 2, 560, 640);
    glow.addColorStop(0, hexA(t.accent, 0.22)); glow.addColorStop(1, hexA(t.accent, 0));
    c.fillStyle = glow; c.fillRect(0, 0, W, H);

    // mala of 108 beads with the guru bead on top
    const cx = W / 2, cy = 560, R = 330;
    const B = o.beads || 108, br = B <= 21 ? 17 : B <= 54 ? 12 : 8.5, gap = (B <= 21 ? 14 : 7) * Math.PI / 180;
    for (let i = 0; i < B; i++) {
      const a = -Math.PI / 2 + gap + (i / (B - 1)) * (2 * Math.PI - 2 * gap);
      c.beginPath();
      c.arc(cx + R * Math.cos(a), cy + R * Math.sin(a), br, 0, Math.PI * 2);
      c.fillStyle = t.gold; c.fill();
    }
    c.beginPath(); c.arc(cx, cy - R - 26, 18, 0, Math.PI * 2); c.fillStyle = t.accent; c.fill();

    c.textAlign = "center"; c.textBaseline = "alphabetic";
    c.fillStyle = ink;
    c.font = "600 200px 'Cormorant Garamond', Georgia, serif";
    c.fillText(String(o.count), cx, cy + 30);   // Cormorant figures descend: keep clear of the label
    c.fillStyle = soft;
    c.font = "500 40px 'Plus Jakarta Sans', system-ui, sans-serif";
    c.fillText(o.count === 1 ? "CHANT" : "CHANTS", cx, cy + 150);

    c.fillStyle = t.accent;
    c.font = "italic 600 64px 'Cormorant Garamond', Georgia, serif";
    let y = 1010;
    for (const line of wrap(c, o.mantra, W - 160)) { c.fillText(line, cx, y); y += 74; }

    c.fillStyle = soft;
    c.font = "500 38px 'Plus Jakarta Sans', system-ui, sans-serif";
    const bits = [`${o.minutes} min`];
    if (o.streak > 0) bits.push(`${o.streak}-day streak`);
    c.fillText(bits.join("   ·   "), cx, y + 30);

    c.fillStyle = hexA(t.text, 0.45);
    c.font = "500 30px 'Plus Jakarta Sans', system-ui, sans-serif";
    c.fillText("Counted hands-free · Jap Counter", cx, H - 70);
    return cv;
  }

  function hexA(hex, a) {
    const h = hex.replace("#", "");
    return `rgba(${parseInt(h.substr(0, 2), 16)},${parseInt(h.substr(2, 2), 16)},${parseInt(h.substr(4, 2), 16)},${a})`;
  }

  function wrap(c, text, maxW) {
    const words = String(text).split(/\s+/), lines = [];
    let cur = "";
    for (const w of words) {
      const test = cur ? cur + " " + w : w;
      if (c.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 3);
  }

  function message(o) {
    const bits = [`I completed ${o.count} chants of ${o.mantra}`];
    if (o.minutes) bits.push(`in ${o.minutes} min`);
    let s = "🪔 " + bits.join(" ") + ".";
    if (o.streak > 1) s += ` 🔥 ${o.streak}-day streak.`;
    return s + "\nCounted hands-free with Jap Counter.";
  }

  function whatsappUrl(text) { return "https://wa.me/?text=" + encodeURIComponent(text); }

  function toBlob(canvas) {
    return new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
  }

  async function shareCard(canvas, text) {
    const blob = await toBlob(canvas);
    const file = blob && new File([blob], "jap-counter.png", { type: "image/png" });
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text }); return "shared"; }
      catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
    }
    download(canvas);
    return "downloaded";
  }

  function download(canvas) {
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png"); a.download = "jap-counter.png";
    document.body.appendChild(a); a.click(); a.remove();
  }

  return { buildCard, message, whatsappUrl, shareCard, download };
})();
