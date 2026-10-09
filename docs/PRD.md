# Product Requirements Document (PRD)

> **Note:** this is the original product brief, kept for context. Several
> technical choices described here were superseded during development — most
> importantly, counting does **not** use the Web Speech API or an RMS/amplitude
> burst detector. See [`engineering-solution.md`](engineering-solution.md) for
> how the app actually works, and [`../ROADMAP.md`](../ROADMAP.md) for what's
> built and what's next.

## Handsfree Jap Counter

| Field | Value |
| --- | --- |
| **Document Owner** | Product / Engineering |
| **Status** | Draft v1.0 |
| **Primary Launch Window** | Navratri · Durga Puja · Diwali |
| **Distribution** | Frictionless web-first (no app store, no sign-up) + WhatsApp viral loops |
| **Key Architecture Decision** | 100% on-device audio processing · **$0.00** cloud AI infra · absolute privacy |

---

## 1. Product Vision

**Handsfree Jap Counter** is an ultra-minimalist, zero-friction Progressive Web App
(PWA) for hands-free mantra chanting during prayers, pooja, and meditation.

During rituals a user's hands are occupied with diya lamps, flowers, or water
offerings, so physical mala beads or manual screen tapping are impractical. The app
tracks completed chant iterations automatically, entirely on-device, so hands stay
free and the experience stays private.

**Core Product Philosophy:** Elevated sacred aesthetics, ultra-high legibility from
3–4 feet away, and zero cognitive bloat.

---

## 2. Personas

| Persona | Environment & Behavior | Core Needs & Pain Points |
| --- | --- | --- |
| **A — Morning Practitioner** *(e.g., Sunita, 52)* | Daily pooja at home altar; hands wet or holding offerings; phone table-rested ~3 ft away | Hands-free counting, large distance-readable numbers, screen stays awake, soft temple bell on completion |
| **B — Festival & Circle Chanter** *(e.g., Rohan, 29)* | 108 / 1,008 chant pledges during Navratri or Shivratri; competes in family/society WhatsApp groups | Fast onboarding, streak tracking, high-aesthetic shareable achievement graphics for WhatsApp status |

---

## 3. Functional Requirements

### 3.1 Onboarding & Zero Friction

| ID | Requirement |
| --- | --- |
| **F-01** | Landing on the URL opens the counter interface directly — no promo landers, no sign-up roadblocks. |
| **F-02** | Mic access requested only on **"Start Chanting"** tap, with trust banner: *"Audio is processed 100% locally on your phone and is never recorded or sent to any server."* |
| **F-03** | Settings, active counts, and daily streaks persist across sessions via `localStorage`. |

### 3.2 Mantra Selection & Calibration

| ID | Requirement |
| --- | --- |
| **F-04** | 1-tap presets: *Om Namah Shivaya · Gayatri Mantra · Mahamrityunjaya Mantra · Hare Krishna · Ganesh Atharvashirsha*, plus **Custom Chant** text entry. |
| **F-05** | Target presets: **108**, **21**, **54**, **1008**, or **Free Count** (unlimited). |
| **F-06** | **3-second voice calibration**: user speaks one full repetition; app locks tempo & volume profile before the session starts. |

### 3.3 Active Chanting UX & Safeguards

| ID | Requirement |
| --- | --- |
| **F-07** | Web Wake Lock API prevents screen dim/lock during an active session. |
| **F-08** | Ambient audio visualizer: a glowing ring pulses in direct response to input audio. |
| **F-09** | Extra-large `+1` / `-1` touch zones for manual tally correction. |
| **F-10** | Auto-pause noise gate: if audio stays below the calibrated voice threshold for **>2 min**, pause to conserve battery. |

### 3.4 Completion & Viral Engine

| ID | Requirement |
| --- | --- |
| **F-11** | On target: soft temple bell chime (configurable ON/OFF) + brief device haptic vibration. |
| **F-12** | Dynamic WhatsApp share card (name, mantra, completion time, streak badge) + one-tap WhatsApp deep-link. |

---
## 4. Design System

### 4.1 Curated Theme Palettes

| # | Theme | Background | Accent | Use Case |
| --- | --- | --- | --- | --- |
| 1 | **Sattvic Creme** *(default)* | `#FDFBF7` Cream | `#FF6B00` Saffron | Morning prayer / daylight altars |
| 2 | **Utsav Kumkum** | `#4A0A10` Deep Crimson | `#FFD700` Turmeric Gold | Evening poojas / Navratri |
| 3 | **Temple Obsidian** | `#000000` OLED Black | `#FF9E2C` Amber Flame | Brahma Muhurta (4 AM) dark rooms |
| 4 | **Vrindavan Garden** | `#10221A` Deep Sage | `#FF85A2` Lotus Pink | Tranquil devotion |
| 5 | **Vedic Cosmos** | `#0B132B` Midnight Indigo | `#E0A96D` Radiant Gold | Deep meditation |

Typography is a humanist serif for the mantra label + a massive slab (>=72 pt) numeral.

### 4.2 Wireframes (Key Screens)

**Screen A - Active Chanting**

```
+-------------------------------------------------------------+
| [Palette]                            [Streak: FIRE 4 Days]   |
|                       OM NAMAH SHIVAYA                      |
|                              43 / 108                       |
|                       (( PULSING RING ))                    |
|                          [Listening]                         |
|      [Pause]        [+1]        [-1]             [Reset]    |
+-------------------------------------------------------------+
```

**Screen B - WhatsApp Share Modal**

```
        DEEPA MALA COMPLETE! DEEPA
  "I completed 108 Chants of Om Namah Shivaya"
   CLOCK 11 Mins  |  FIRE 4-Day Streak
      [ WHATSAPP Share Progress on WhatsApp ]
   Joined the Collective Festival Yajna
```

---

## 5. Technical Architecture

```
+-----------------------------------------------------------------------+
|                       CLIENT BROWSER (PWA)                            |
|                                                                       |
|  [ Mic ] --> [ Web Speech API ] --> [ On-Device Math ] --> [ Tally ]  |
|                 +  AnalyserNode (RMS)                  |              |
|                                                     [ Canvas Card ]   |
|  [ localState / localStorage ] <------------- [ WhatsApp Deep-Link ]  |
+-----------------------------------------------------------------------+
```

1. **Audio Recognition (client-side)**
   - **Primary:** Web Speech API (`SpeechRecognition`) streaming keyword phrase match.
   - **Fallback:** Web Audio `AnalyserNode` - **RMS envelope** detection of voiced bursts
     matched against the tempo/volume profile captured during calibration.
2. **Offline-First Persistence:** `localStorage` for settings, custom mantras, session, streaks.
3. **Dynamic Share Image:** rendered in-browser with **HTML5 Canvas** (no cloud rendering).

### Voice-Detection Engine Design (envelope / tempo)

- **Calibration (F-06):** analyze ~1 repetition - derive (`noiseFloor`, `voicePeak`) ->
  `voiceThreshold = noiseFloor + (voicePeak - noiseFloor) * 0.35`.
- **Burst detect:** a frame where RMS >= `voiceThreshold` for >= `MIN_SPEECH_MS` starts a
  burst; a burst ends after a calibrated pause. Each completed voiced burst -> `+1`.
- **Double-count guard:** reject a new burst until `interval * 0.6` ms has elapsed since
  the previous accepted burst.
- **Auto-pause (F-10):** no accepted burst for `120_000` ms -> `pause()`.
- **Speech-API booster:** when enabled, an interim/final `SpeechRecognitionResult` whose
  text fuzzy-matches the mantra keywords increments confidently; the envelope engine
  remains the resilient cross-dialect base.

---

## 6. Acceptance Criteria

- [ ] Cold load on 3G <= ~2 s to an interactive counter (tiny dependency-free footprint).
- [ ] All 5 themes apply correctly (survive reload).
- [ ] Calibration -> live counting -> completion flow works end-to-end.
- [ ] +1 / -1 / reset / pause produce correct counts.
- [ ] Auto-pause fires after 2 min of silence; resumes without losing count.
- [ ] Screen stays awake during active sessions where Wake Lock is available.
- [ ] Completion triggers bell + haptic; share modal renders a Canvas card and
      opens a WhatsApp deep-link.
- [ ] Streaks persist across days and sessions.

---

## 7. Pre-Festival Sprint Roadmap

| Phase | Scope |
| --- | --- |
| **1 Week 1** | Core PWA layout, 5 themes, speech-matching algorithm, manual counter controls. |
| **2 Week 2** | Calibration mode, amplitude fallback engine, Wake Lock, haptic feedback. |
| **3 Week 3** | Canvas WhatsApp card, streak tracking, 3G performance tuning. |
| **4 Week 4** | Cross-browser QA (iOS Safari / Android Chrome), edge-CDN load test, regional WhatsApp seeding. |

---

## 8. Out of Scope (v1)

- Accounts, logins, server-side sync / leaderboards.
- Any server-side audio processing or upload.
- General-purpose speech-to-text transcription of arbitrary speech.
