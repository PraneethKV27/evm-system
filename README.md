# 🛡️ SecEVM - Biometric EVM Secure Voting System

SecEVM is a secure, web-based Electronic Voting Machine (EVM) simulation built with biometric fingerprint verification, real-time Firebase Firestore integration, STM32 UART hardware support, and a clean dark-mode UI. It covers the full voting lifecycle — from voter registration to ballot casting — with live data dashboards.

---

## ✨ Features

### 📥 Registration
- Voter registration with Aadhaar number validation (exactly 12 digits)
- Collects name, mobile, email, gender, and date of birth
- Auto age calculation with 18+ eligibility check
- Two enrollment modes:
  - **🖐️ Capture Fingerprint** — software simulation, captures 5 samples with visual gallery preview
  - **🔌 Enroll Fingerprint (HW)** — calls Flask/Node bridge to signal STM32 hardware enrollment
- Saves voter record to Firebase Firestore (or localStorage in demo mode)

### 🗳️ Secure Voting
- Aadhaar-based voter lookup with real-time pre-verification card
- Shows voter name, age eligibility, and voting status before fingerprint scan
- Biometric verification with live vs. registered fingerprint comparison panel
- When STM32 bridge is running: polls `/stm32/match-status` every second for up to 10s waiting for `MATCH_OK` from hardware
- Displays **"Fingerprint Verified — Voting Enabled"** on successful match
- Falls back to software template verify if STM32 times out or is offline
- Secure ballot with 5 party options + NOTA
- One-vote-per-voter enforced via Firestore atomic transaction

### 📊 Stats Dashboard
- Real-time vote counts and percentage bars for all parties
- Total votes cast, biometric verification rate, security status

### 👥 Registered Voters
- Live table of all registered voters from Firebase (`onSnapshot` — updates instantly)
- Columns: masked Aadhaar, name, age, gender, mobile, email, DOB, eligibility badge, vote status badge
- Summary bar: total registered, eligible, already voted, pending
- Search by name or Aadhaar, filter by eligible / voted / pending

### ✅ Completed Votes
- Live table of all voters who have completed their vote (`onSnapshot`)
- Columns: masked Aadhaar, name, age, gender, party voted, timestamp
- Summary bar: total votes, leading party, leader vote count, voter turnout %
- Search by name or Aadhaar, filter by party

### 🔌 Developer Hub
- Integration code templates for React, Next.js, Vue, Angular, WordPress, Shopify, Drupal, and more
- AI prompt generator for Claude to scaffold full voting components
- Configurable API URL, tech stack, integration type, and theme

---

## 🖥️ Hardware Badge (Header)

The header shows two real-time status badges that update every 3 seconds:

| Badge | State | Meaning |
|-------|-------|---------|
| 🟢 `Hardware: Live` | Green | STM32 physically connected and detected |
| 🟡 `STM32: Not Connected` | Yellow | Bridge server running but no STM32 plugged in |
| 🔴 `Hardware: Disconnected` | Red | Bridge server (`server.js` or `fp_bridge.py`) not running |
| 🟢 `Firebase Live` | Cyan | Connected to Firebase Firestore |
| 🟡 `Demo Mode` | Purple | Running on localStorage fallback |

> The Node.js server auto-detects STM32 by USB Vendor ID (`0483` = STMicroelectronics) and manufacturer name — no manual COM port config needed.

---

## 🔄 STM32 Verification Workflow

```
Voter enters Aadhaar  →  Frontend calls /fingerprint/capture
                      →  Bridge sends VERIFY:<aadhaar> to STM32 via UART
                      →  STM32 scans finger, sends back:
                              MATCH_OK ID=<aadhaar>    (match)
                              MATCH_FAIL ID=<aadhaar>  (mismatch)
                      →  Bridge stores result in memory + updates Firestore:
                              { fingerprint_status: "verified" }
                      →  Frontend polls /stm32/match-status every 1s (up to 10s)
                      →  On verified: displays "Fingerprint Verified — Voting Enabled ✔"
                      →  Ballot unlocked — voter selects party and casts vote
```

---

## 🗄️ Database Modes

| Mode | Description |
|------|-------------|
| **Firebase Live** | Connects to Firebase Firestore — real-time `onSnapshot` listeners for all tabs |
| **Demo Mode** | Falls back to browser `localStorage` — no setup needed for quick testing |

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) installed
- Git

### 1. Clone the repository

```bash
git clone https://github.com/PraneethKV27/evm-system.git
cd evm-system
```

### 2. Install fingerprint server dependencies

```bash
cd fingerprint-server
npm install
cd ..
```

### 3. Start the fingerprint backend server

```bash
node fingerprint-server/server.js
```

Runs on `http://localhost:5002`. Handles all fingerprint and STM32 endpoints.  
STM32 is **auto-detected** by USB VID — just plug it in and the badge turns green within 3 seconds.

To pin a specific COM port:
```bash
# Windows
set STM32_PORT=COM3 && node fingerprint-server/server.js

# Linux / macOS
STM32_PORT=/dev/ttyUSB0 node fingerprint-server/server.js
```

### 4. Start the web server

```bash
node serve.js
```

Runs on `http://localhost:3000` — serves the frontend over HTTP (required for Firebase module imports and fetch calls to work).

### 5. Open the app

Navigate to **http://localhost:3000** in your browser.

> ⚠️ Do **not** open `index.html` directly via `file://` — browser security blocks fetch calls and ES module imports in that mode.

---

## 📁 Project Structure

```
evm-system/
├── public/
│   ├── index.html              # Main UI — all 6 tabs
│   ├── app.js                  # Firebase logic, tab controllers, live listeners,
│   │                           # STM32 polling, hardware badge
│   ├── style.css               # Dark-mode UI styles
│   └── fingerprint.png         # Fingerprint icon asset
├── fingerprint-server/
│   ├── server.js               # Node.js Express server (port 5002)
│   │                           # Auto-detects STM32 via serialport USB VID
│   │                           # Endpoints: /status, /fingerprint/*, /stm32/*
│   └── package.json
├── fingerprint_bridge/
│   └── fp_bridge.py            # Python bridge (Flask + pyserial) — alternative to Node.js server
│                               # Connects directly to STM32 UART + Firebase Admin SDK
│                               # Endpoints: /fingerprint/*, /stm32/*, /vote, /status
├── functions/
│   └── index.js                # Firebase Cloud Functions (scaffolded)
├── serve.js                    # Simple Node.js HTTP server for the frontend (port 3000)
├── firebase.json               # Firebase hosting + Firestore config
├── firestore.rules             # Firestore security rules
└── firestore.indexes.json
```

---

## 🔌 API Endpoints

### Node.js Fingerprint Server (`fingerprint-server/server.js`, port 5002)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/status` | Hardware badge — returns `{ hardware: "connected" \| "disconnected" }` |
| POST | `/fingerprint/capture` | Returns fingerprint template (hardware or simulated) |
| POST | `/fingerprint/store` | Stores enrolled samples in memory |
| POST | `/fingerprint/verify` | Verifies a scan against stored samples |
| POST | `/stm32/enroll` | Enroll signal `{ voter_id, samples }` → stores STM32 templates |
| POST | `/stm32/verify` | Mark match result `{ voter_id }` → sets `verified` status |
| POST | `/stm32/event` | Push raw UART line `{ line: "MATCH_OK ID=..." }` |
| GET  | `/stm32/match-status?aadhaar=` | Frontend polls this for MATCH_OK result |

---

### Python Bridge (`fingerprint_bridge/fp_bridge.py`, port 5002)
Alternative to Node.js server — use this when you want direct Firebase Admin SDK writes from hardware events.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/status` | Bridge health + hardware connection state |
| POST | `/fingerprint/capture` | Triggers UART capture, falls back to Firestore |
| POST | `/fingerprint/store` | Saves enrolled samples to Firestore |
| POST | `/fingerprint/verify` | Sends `VERIFY:` to STM32, falls back to Firestore match |
| POST | `/vote` | Atomic vote transaction via Firebase Admin |
| POST | `/stm32/enroll` | Direct enroll `{ voter_id, samples }` → Firestore |
| POST | `/stm32/verify` | MATCH_OK signal → sets `fingerprint_status: "verified"` in Firestore |
| POST | `/stm32/event` | Raw UART line push |
| GET  | `/stm32/match-status?aadhaar=` | Poll match result |

#### Running the Python Bridge

```bash
cd fingerprint_bridge

# Install dependencies
pip install flask flask-cors firebase-admin pyserial

# Place serviceAccountKey.json in fingerprint_bridge/
# Set COM port
set STM32_PORT=COM3        # Windows
export STM32_PORT=/dev/ttyUSB0  # Linux/macOS

python fp_bridge.py
```

> Run only one backend at a time (Node.js server OR Python bridge) — both use port 5002.

---

## 📡 STM32 UART Message Format

Both backends understand the same UART messages from STM32:

| UART Message | Action |
|---|---|
| `MATCH_OK ID=<aadhaar>` | `fingerprint_status: "verified"` → unlocks ballot on frontend |
| `MATCH_FAIL ID=<aadhaar>` | `last_verify_status: "mismatch"` → shows error on frontend |
| `ENROLL_OK:ID=<aadhaar>:SAMPLES=<n>` | Saves `fp_samples` + `fingerprint_status: "enrolled"` |
| `VERIFY_OK:ID=<aadhaar>` | Alias for `MATCH_OK` (older firmware) |
| `VERIFY_FAIL:ID=<aadhaar>` | Alias for `MATCH_FAIL` (older firmware) |
| `VOTE_CAST:ID=<aadhaar>:PARTY=<party>` | Atomic vote transaction (Python bridge only) |
| `TEMPLATE:<string>` | Returned by STM32 in response to `CAPTURE:<aadhaar>` command |
| `ERROR:<message>` | Logged to console |

---

## 🔒 Security

- Voters cannot register if under 18
- Voters can only cast one vote (enforced by Firestore atomic transaction)
- Biometric fingerprint match required before ballot is unlocked
- Aadhaar numbers are masked (`XXXX-XXXX-XXXX`) in all data display tables
- Firebase Firestore rules control read/write access
- Hardware verification preferred over software fallback when STM32 is connected

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML, CSS, JavaScript (ES Modules) |
| Database | Firebase Firestore (real-time `onSnapshot`) |
| Fingerprint Server | Node.js + Express + `serialport` (auto USB detection) |
| Python Bridge | Flask + `firebase-admin` + `pyserial` |
| Hardware | STM32 microcontroller (USB CDC / UART @ 115200 baud) |
| Web Server | Node.js HTTP server (`serve.js`) |
| Hosting | Firebase Hosting / local `serve.js` |

---

## 📸 Tabs Overview

| Tab | Description |
|-----|-------------|
| 📥 Registration | Register voters — software or STM32 hardware fingerprint enrollment |
| 🗳️ Secure Voting | Aadhaar + fingerprint verified ballot casting with STM32 MATCH_OK flow |
| 📊 Stats Dashboard | Real-time vote results and party charts |
| 👥 Registered Voters | Live Firebase table of all registered voters with full details |
| ✅ Completed Votes | Live Firebase table of voters who have cast their vote |
| 🔌 Developer Hub | Integration code templates and AI prompt generator |

---

## 🐛 Known Issues Fixed

| File | Issue | Fix Applied |
|------|-------|-------------|
| `app.js` | `orderBy` imported but never used | Removed unused import |
| `app.js` | `registered_at` never saved during registration but shown in Registered Voters table | Now saved as `new Date().toISOString()` in voter payload |
| `app.js` | `mobile`/`email` not included in voter payload saved to Firestore | Added to payload |
| `app.js` | Vote transaction read `snap.data().votes` from VoterDB (wrong collection) | Fixed to read `partySnap.data().votes` from PartyDB |
| `app.js` | `ser_write_cmd:` was an invalid JS labeled block (dead code) | Replaced with clean `try/catch` |
| `app.js` | `dbImg` and `registrationTemplate` declared but never used | Removed |
| `server.js` | UART key=value parser split on all `=` signs, truncating values with `=` | Fixed to split only on first `=` |
| `server.js` | Serial `data` event processed per chunk not per line — multi-byte UART messages split | Added `_uartBuffer` to accumulate and split on `\n` |
| `serve.js` | No path sanitization — path traversal vulnerability (`../../etc/passwd`) | Added `path.resolve` + boundary check |
| `index.html` | Tab comments mislabelled (Stats as TAB 2, Dev Hub as TAB 3) | Corrected to TAB 3 and TAB 6 |
| `fp_bridge.py` | Docstring listed old UART format, missing `MATCH_OK`/`MATCH_FAIL` | Updated to match current implementation |
| `firestore.indexes.json` | JS-style `//` comments invalid in JSON | Removed all comments |



All features work without an STM32 connected:
- Hardware badge shows 🟡 `STM32: Not Connected`
- Fingerprint enrollment uses simulated `FP_XXXXXXXX` templates
- Fingerprint verification auto-succeeds for registered eligible voters
- All Firestore reads/writes work normally
- Switch to Demo Mode (no Firebase config needed) for fully offline testing
