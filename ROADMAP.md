# Roadmap

What's planned or known to be missing, roughly in priority order. The counting
design and its limitations are explained in
[`docs/engineering-solution.md`](docs/engineering-solution.md).

## Counting accuracy

- [ ] **Validate on more real voices.** Accuracy has been measured on one person's
      recording. Collect consenting recordings (different voices, mantras, rooms,
      phones) and add them to the real-voice evaluation.
- [ ] **Adapt the template during a session.** Blend in repetitions the app is very
      sure of, so the template follows the room and the chanter's voice as the
      session goes on. Most promising fix for noisy rooms.
- [ ] **Better robustness to steady background noise** (fans, AC). Today a loud fan
      causes missed repetitions (never extra ones).
- [ ] **"Room is noisier than when you taught" hint** when the live noise floor
      rises well above the level measured while teaching.
- [ ] **Fewer misses next to an interrupted (half) mantra.**
- [ ] Use rhythm from the first repetitions (it currently needs 3 counted ones).
- [ ] Profile CPU and battery use on low-end Android phones.

## Features

- [ ] Remove a custom mantra, and forget a learned voice, from the UI.
- [ ] Session history: past malas per mantra and per day.
- [ ] Undo the last voice-counted repetition with one tap (distinct from −1).
- [ ] Hindi (and other languages) for the interface.
- [ ] Optional spoken or chimed milestones (every 27 / 54 beads).
- [ ] Export / import of learned voices and history (backup, new phone).
- [ ] Privacy-respecting, cookie-free usage analytics (e.g. Cloudflare Web
      Analytics), clearly disclosed and optional.

## Engineering

- [ ] Run unit and end-to-end tests in CI (GitHub Actions). The macOS-only `say`
      corpus would need pre-generated audio or a Linux TTS.
- [ ] Self-host the fonts (removes the only third-party request and works fully
      offline from the first visit).
- [ ] Content-hashed asset names, so code files can be cached long-term.
- [ ] Automated accessibility checks (contrast in all themes, screen-reader flow).
