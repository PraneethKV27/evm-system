# 🛡️ SecEVM — Biometric EVM Secure Voting System

SecEVM is a secure, web-based Electronic Voting Machine built around an **R307 optical fingerprint sensor** connected to an **STM32 microcontroller**. It enforces biometric identity at every step — enrollment, consent, and voting — backed by Firebase Firestore and a Node.js or Python bridge server.

---

## ✨ What's New (Latest Update)

| Feature | Detail |
|---------|--------|
| **Obsolete PC13 & Manual Aadhaar Entry Removed** | Manual Aadhaar entry via STM32 buttons has been removed. Aadhaar numbers are now inputted directly on the PC web UI. `PC13` confirm button logic is fully deprecated |
| **Direct Button Voting** | Cast votes instantly using 5 dedicated push buttons on the STM32 board (`PB1` to `PB5` for parties/NOTA) without needing a confirm button cycle |
| **Indefinite Scan Wait & Warnings** | The scanner waits indefinitely for a finger scan (no auto-timeout). It warns the PC every 1.5s with `STATUS:PLEASE_PLACE_FINGER` to show an on-screen placement prompt |
| **Scan Success Buzzer Feedback** | A confirmation beep plays on the buzzer for each successfully captured sample during enrollment |
| **No Auto-Approve Consent** | The 3-second auto-approval countdown has been removed; consent dialogs wait indefinitely for manual "Yes" or "No" clicks |
| **10-Minute Polling Gaskets** | The frontend waits up to 10 minutes during scans to accommodate slow physical finger placement |
| **Phone-style biometric fusion** | Registration collects **5 real R307 scans** (different angles/pressures). All 5 CharBuffer templates are stored and treated as **one fused identity** — verification succeeds if **any** template matches at **≥ 80%** confidence |
| **Real-hardware-only enrollment** | Mock `/stm32/enroll` bypass removed. Hardware path waits for UART `TEMPLATE_N` base64 uploads from the sensor, polls `enroll-status` until `ENROLL_OK`, then saves all 5 templates to Firestore as `fp_templates` |
| **80% verify gate enforced** | Voting unlocks only on STM32 `MATCH_OK` (R307 Search score ≥ 52428 / 80%). Scores below threshold return `REASON=SCORE_LOW` and keep the ballot locked |
| **R307 sensor disconnection detection** | When STM32 is connected but the R307 fingerprint sensor is not, the system shows **"⚠️ Fingerprint Sensor Not Connected"** and **blocks enrollment, verification, and capture**. After reconnecting the sensor, operations resume automatically |
| **Real data enforcement** | Enrollment and storage are blocked unless **all 5 fingerprint templates are genuine R307 base64 data**. Mock/placeholder templates are rejected when hardware is connected |
| **Strict hardware verification** | Fully blocks biometric verification if the STM32 hardware is disconnected, refusing to proceed with mock simulations in live deployments |
| **Anti-autofill protection** | Added `autocomplete="off"` to all Aadhaar and voter input fields, blocking browsers from caching and suggesting sensitive voter details |


---

## ✨ Core Features

### 📥 Registration
- Voter registration with 12-digit Aadhaar validation
- Collects name, mobile, email, gender, date of birth; auto age calculation
- **5 real R307 scans with per-sample consent** — STM32 captures each sample, uploads base64 CharBuffer via UART (`TEMPLATE_1`…`TEMPLATE_5`), voter approves each before proceeding
- **Phone-style fusion** — all 5 templates stored as `fp_templates` and searched as one identity at verify time (not 5 separate voters)
- Saves voter record to Firebase Firestore (or `localStorage` in Demo Mode)

### 🗳️ Secure Voting
- Aadhaar-based voter lookup with real-time pre-verification card
- Requires **5 enrolled R307 templates** (`fp_templates`) before verify can start
- Biometric verification: all 5 stored templates loaded into STM32 via `LOAD_TEMPLATE` (with inter-command delay), then `CMD_VERIFY` triggers R307 `Search` across all pages
- **80% confidence threshold enforced in firmware** — match score must be ≥ 52428 (80% of 65535). Below that → `MATCH_FAIL:REASON=SCORE_LOW` and ballot stays locked
- **Direct Hardware Button Voting** — once the ballot is unlocked, voting must be cast using one of the **5 dedicated physical push buttons** on the STM32 board (PORTB `PB1` to `PB5` representing the parties and NOTA). On-screen clicking is disabled to enforce physical vote integrity.
- One-vote-per-voter enforced via Firestore atomic transaction

### 📊 Stats Dashboard
- Real-time vote counts and percentage bars for all parties

### 👥 Registered Voters & ✅ Completed Votes
- Live Firebase `onSnapshot` tables with search, filter, and summary stats

---

## 🔬 Fingerprint Match Threshold

```
R307 Search response byte layout (16 bytes):
  [0..5]   header   EF 01 FF FF FF FF
  [6]      package id
  [7..8]   length
  [9]      confirmation code  (0x00 = found, 0x09 = not found)
  [10..11] matched page number (big-endian)
  [12..13] match score / confidence (big-endian, 0x0000..0xFFFF)
  [14..15] checksum

Threshold:  52428  (= 80% × 65535)
Decision:
  code == 0x09                 → MATCH_FAIL  (REASON=MISMATCH)
  code == 0x00 & score < 52428 → MATCH_FAIL  (REASON=SCORE_LOW)
  code == 0x00 & score ≥ 52428 → MATCH_OK
```

The firmware logs the exact score on every scan:
```
Search: code=0x00 score=54210 (threshold=52428)
MATCH accepted: score=54210 (82.7%)
```

---

## 🔄 Enrollment Protocol (5 Real R307 Scans → Phone-Style Fusion)

```
Frontend: POST /stm32/cmd-enroll  { aadhaar }

For each sample n = 1..5:
  STM32 (R307): GenImg → Img2Tz → SAMPLE_READY:ID=<aadhaar>:SAMPLE=<n>
  Frontend polls /stm32/sample-consent → shows consent dialog
    YES → POST /stm32/ack-sample  { aadhaar, sample: n }
    NO  → POST /stm32/deny-sample → ABORT_ENROLL → stop
  STM32: UpChar → base64 → TEMPLATE_<n>:ID=<aadhaar>:DATA=<base64>
  Frontend polls /stm32/templates until real base64 for sample n arrives
  (Placeholders and mock templates are rejected by the bridge)

After all 5 samples consented:
  STM32: final RegModel fuse → ENROLL_OK:ID=<aadhaar>:SAMPLES=5
  Frontend polls /stm32/enroll-status until "complete"
  Frontend: POST /stm32/store-templates  { aadhaar, templates: {1..5} }
  Firestore: { fp_templates:{1..5}, fp_sample_count:5, fusion_mode:"multi_template",
               match_threshold_pct:80, fingerprint_status:"enrolled" }
  Frontend: shows ✅ enrollment completion banner
```

---

## 🔄 Verification Protocol (Multi-Template Fusion + 80% Gate)

```
Frontend: voter must have fp_templates with 5 real R307 base64 blobs

Frontend: POST /stm32/cmd-verify  { aadhaar, templates: fp_templates }
Bridge validates 5 real templates, then:
  PC → STM32:  LOAD_TEMPLATE:1:<base64>  (80ms delay between each)
               LOAD_TEMPLATE:2:<base64>
               ...
               LOAD_TEMPLATE:5:<base64>
  PC → STM32:  CMD_VERIFY:<aadhaar>

Voter places finger on R307:
  STM32: GenImg → Img2Tz → Search(pages 0..9)
  R307 Search score (0..65535):
    score ≥ 52428 (80%) → MATCH_OK ID=<aadhaar>  → ballot UNLOCKED
    score <  52428       → MATCH_FAIL:REASON=SCORE_LOW  → ballot LOCKED
    not found            → MATCH_FAIL:REASON=MISMATCH   → ballot LOCKED

Frontend polls /stm32/match-status?aadhaar=  (up to 15s)
  "verified" → enable EVM ballot buttons
  "failed"   → show score-low or mismatch message
```

---

## 🖥️ Hardware Badge

| Badge | Meaning |
|-------|---------|
| 🟢 `Hardware: Live` | STM32 + R307 sensor both online |
| 🟠 `R307 Sensor: Disconnected ⚠️` | STM32 connected but R307 fingerprint sensor not responding — check wiring |
| 🟡 `STM32: Not Connected` | Bridge running, no STM32 plugged in |
| 🔴 `Hardware: Disconnected` | Bridge server not running |
| 🟢 `Firebase Live` | Firestore connected |
| 🟡 `Demo Mode` | localStorage fallback |

---

## 🚀 Getting Started

### Prerequisites
- Node.js ≥ 18
- Git
- (Optional) Python 3.9+ for the Python bridge

### One-command start ← recommended (Desktop folder)

**Double-click `START SecEVM.bat`** or **`SecEVM.bat`** in the project folder on your Desktop.

> ⚠️ **Do NOT double-click `index.html`** — that opens the UI without the backend. The hardware badge will show "Disconnected" and fingerprint features will not work.

`SecEVM.bat` automatically:
1. Frees ports 3010 / 5002 from any previous SecEVM session
2. Installs `fingerprint-server` dependencies on first run
3. Starts the fingerprint backend on `http://127.0.0.1:5002`
4. Starts the frontend on `http://localhost:3010`
5. Opens the browser automatically

See also **`START HERE.txt`** in the project folder.

Or from any terminal:
```bash
cd evm-system
node start.js
```

> 💡 **Backend offline in the UI?** Make sure the `SecEVM.bat` window is still open. Close it and double-click `START SecEVM.bat` again.

---

### 1. Clone

```bash
git clone https://github.com/PraneethKV27/evm-system.git
cd evm-system
```

### 2. Install dependencies

```bash
cd fingerprint-server
npm install
cd ..
```

### 3. Start everything

```bash
node start.js
# or double-click SecEVM.bat
```

Both servers launch in one process — no need for two terminals.

### 4. (Optional) Pin a specific COM port for STM32

```bash
# Windows
set STM32_PORT=COM3 && node start.js

# Linux / macOS
STM32_PORT=/dev/ttyUSB0 node start.js
```

### 5. (Optional) Python bridge with Firebase Admin

```bash
cd fingerprint_bridge
pip install flask flask-cors firebase-admin pyserial
# Place serviceAccountKey.json in fingerprint_bridge/
set STM32_PORT=COM3   # Windows
python fp_bridge.py
```

> Run only one backend at a time (Node.js OR Python) — both use port 5002.

---

## 📁 Project Structure

```
evm-system/
├── public/
│   ├── index.html          # Main UI — all 6 tabs
│   ├── app.js              # Firebase logic, enrollment with per-sample consent,
│   │                       # multi-template fusion verify, 80% threshold UI
│   ├── style.css           # Dark-mode styles
│   └── fingerprint.svg     # Fingerprint icon (used in enrollment gallery & verify panel)
├── fingerprint-server/
│   ├── server.js           # Node.js Express (port 5002)
│   │                       # Endpoints: /stm32/sample-consent, /stm32/ack-sample,
│   │                       # /stm32/deny-sample, /stm32/store-templates,
│   │                       # /stm32/enroll-status, /stm32/cmd-verify,
│   │                       # /fingerprint/verify (multi-template fusion)
│   └── package.json
├── fingerprint_bridge/
│   └── fp_bridge.py        # Python bridge (Flask + pyserial + Firebase Admin)
│                           # Same endpoints as server.js
├── stm32/
│   └── main.c              # STM32 firmware
│                           # Per-sample consent: SAMPLE_READY → wait ACK/ABORT
│                           # Template upload:    UpChar → base64 → TEMPLATE_N
│                           # Template load:      LOAD_TEMPLATE → DnChar → Store
│                           # 80% threshold:      Search score ≥ 52428 required
│                           # Base64 encoder/decoder (no stdlib dependency)
├── functions/
│   └── index.js            # Firebase Cloud Functions (scaffold)
├── start.js                # ← Unified launcher: starts both servers + opens browser
├── SecEVM.bat              # ← Windows launcher (auto-install deps, free ports)
├── START SecEVM.bat        # ← Desktop shortcut — double-click this to start
├── START HERE.txt          # ← Quick instructions when opening the folder
├── serve.js                # Static HTTP server for frontend (port 3010)
├── package.json            # Root package — "npm start" runs start.js
├── firebase.json           # Firebase hosting + Firestore config
├── firestore.rules
└── firestore.indexes.json
```

---

## 🔌 STM32 Hardware Connections

| Component | Pin | Direction |
|-----------|-----|-----------|
| R307 Fingerprint TX | USART1 RX (PA10) | Input |
| R307 Fingerprint RX | USART1 TX (PA9)  | Output |
| PC / Bridge TX | USART2 RX (PA3)  | Input |
| PC / Bridge RX | USART2 TX (PA2)  | Output |
| Green LED | PA6 | Output |
| Red LED   | None (Removed) | - |
| Buzzer    | PB6 | Output |
| Party AB Button | PC7 | Input, active-high, pull-down |
| Party CD Button | PB10 | Input, active-high, pull-down |
| Party EF Button | PB3 | Input, active-high, pull-down |
| Party GH Button | PB5 | Input, active-high, pull-down |
| Party NOTA Button | PB0 | Input, active-high, pull-down |

USART1 (R307): 9600 baud — USART2 (PC bridge): 115200 baud

---

## 📡 Full UART Command Reference

### STM32 → PC

| Message | Trigger |
|---------|---------|
| `STATUS:STM32 Ready` | Boot |
| `REQUEST_VOTER:<aadhaar>` | After Aadhaar entered via buttons |
| `VOTER_DATA:ID=<>:NAME=<>:AGE=<>:GENDER=<>` | Echo back voter info to Firestore |
| `SAMPLE_READY:ID=<aadhaar>:SAMPLE=<n>` | Sample n captured, waiting for consent |
| `TEMPLATE_<n>:ID=<aadhaar>:DATA=<base64>` | CharBuffer upload after ACK |
| `ENROLL_OK:ID=<aadhaar>:SAMPLES=5` | All 5 samples enrolled |
| `MATCH_OK ID=<aadhaar>` | Score ≥ 80 % — ballot unlocked |
| `MATCH_FAIL ID=<aadhaar>` | Not found in sensor |
| `MATCH_FAIL ID=<aadhaar>:REASON=SCORE_LOW` | Found but score < 80 % |

### PC → STM32

| Message | Action |
|---------|--------|
| `VOTER_INFO:<aadhaar>:<name>:<age>:<gender>` | Voter info for display |
| `CMD_ENROLL:<aadhaar>` | Start 5-sample enrollment |
| `ACK_SAMPLE:<aadhaar>:<n>` | Consent granted for sample n → proceed |
| `ABORT_ENROLL:<aadhaar>` | Voter denied — stop immediately |
| `LOAD_TEMPLATE:<n>:<base64>` | Load template n into sensor flash page n |
| `CMD_VERIFY:<aadhaar>` | Start live scan + Search |
| `ACK_VOTE:<aadhaar>:<party>` | Vote confirmed — green LED + beep |

---

## 📋 API Endpoints

### Node.js server (`fingerprint-server/server.js`, port 5002)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/status` | Hardware badge |
| GET  | `/stm32/sample-consent?aadhaar=&sample=` | Poll consent state for sample n |
| POST | `/stm32/ack-sample` | Voter approved sample `{ aadhaar, sample }` |
| POST | `/stm32/deny-sample` | Voter denied — abort `{ aadhaar, sample }` |
| GET  | `/stm32/enroll-status?aadhaar=` | Poll enrollment completion |
| POST | `/stm32/store-templates` | Save all 5 templates `{ aadhaar, templates }` |
| GET  | `/stm32/templates?aadhaar=` | Retrieve stored templates |
| POST | `/stm32/cmd-enroll` | Trigger STM32 enrollment |
| POST | `/stm32/cmd-verify` | Load templates + trigger verify |
| GET  | `/stm32/match-status?aadhaar=` | Poll MATCH_OK / MATCH_FAIL result |
| POST | `/fingerprint/capture` | Capture template (HW or simulated) |
| POST | `/fingerprint/store` | Store enrolled samples |
| POST | `/fingerprint/verify` | Multi-template fusion software verify |
| POST | `/stm32/verify` | Mark match result |
| POST | `/stm32/event` | Push raw UART line `{ line }` |
| POST | `/stm32/send-voter-info` | Send VOTER_INFO to STM32 |
| POST | `/stm32/ack-vote` | Send ACK_VOTE to STM32 |

---

## 🔒 Security

- Voters under 18 cannot vote (age check is enforced during secure voting verification, though registration allows any age)
- One vote per voter enforced via Firestore atomic transaction
- Biometric ballot lock: ballot only unlocks on `MATCH_OK` with score ≥ 80 %
- Per-sample consent: voter explicitly approves each of the 5 samples
- **Real-time R307 sensor detection** — STM32 pings the R307 every 3 s; if the sensor is disconnected, the UI shows a ⚠️ warning banner and the hardware badge turns amber. Reconnecting the sensor auto-clears the warning
- **R307 disconnection blocks all biometric operations** — enrollment, verification, and capture are blocked at both frontend and backend when the STM32 is connected but the R307 sensor is not responding. Clear error messages guide the user to check wiring and power
- **Real data enforcement** — when hardware is connected, all 5 fingerprint templates must pass `isRealR307Template()` validation (genuine base64 ≥ 64 chars, no mock prefixes). Mock/placeholder data is rejected at both the frontend save and backend `/fingerprint/store` endpoint
- Aadhaar masked as `XXXX-XXXX-XXXX` in all display tables
- Path traversal protection in `serve.js`

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/CSS/JS (ES Modules) |
| Database | Firebase Firestore (real-time `onSnapshot`) |
| Fingerprint Server | Node.js + Express + `serialport` |
| Python Bridge | Flask + `firebase-admin` + `pyserial` |
| Hardware | STM32 + R307 optical fingerprint sensor |
| Protocol | UART 115200 baud (PC↔STM32), 57600 baud (STM32↔R307) |
| Web Server | Node.js HTTP (`serve.js`, port 3010) |

---

## 🐛 Known Issues Fixed

| File | Issue | Fix |
|------|-------|-----|
| `main.c` | `%.1f` float format in `snprintf` — unsupported by newlib-nano on ARM without linker flags | Replaced with integer arithmetic: `(score × 1000) / 65535` → `int.frac%` |
| `main.c` | `Debug_Printf` (varargs) left in firmware, triggering unused-function warning and pulling in `stdarg.h` / `vsnprintf` | Removed implementation and `#include <stdarg.h>` |
| `main.c` | R307 Search response read from wrong UART (`huart2`) | Fixed to `huart1` |
| `main.c` | No confidence threshold — any `0x00` confirmation accepted | 80% score gate added |
| `main.c` | Infinite capture retry loop — could hang MCU | Max 3 retries per sample |
| `main.c` | `voterParty` static buffer unused after write | Removed, replaced with inline log |
| `main.c` | Duplicate `logMsg` declarations in same scope in `ProcessRxLine` | Renamed to `loadLogMsg`, `storeErrMsg`, `loadDoneMsg` |
| `server.js` | UART key=value parser split on all `=`, broke base64 values | Split only on first `=` |
| `server.js` | Serial `data` event processed per chunk not per line | `_uartBuffer` accumulator added |
| `app.js` | Enrollment used `setInterval` — no pause between samples | Replaced with `async for` loop + consent dialog |
| `app.js` | `vote()` checked `verifiedVoterData.aadhaar` — field absent when doc ID is the aadhaar | Falls back to `.id` |
| `app.js` | `filterRegisteredTable` updated summary counts to reflect search results | Summary always reflects full dataset |
| `app.js` | Demo Mode verification was hard-blocked by STM32 required check | Demo path added: 2s simulated scan, passes if voter has `fp_samples` |
| `fp_bridge.py` | `MATCH_FAIL` reason not stored in Firestore | `last_verify_reason` field added |
| `fp_bridge.py` | Unused `import base64` | Removed |
| `serve.js` | No path sanitization | `path.resolve` + boundary check added |
| `functions/index.js` | Unused imports caused ESLint failures | Removed unused `onRequest` / `logger` imports |
| `server.js` | `voterDataCache` referenced before declaration | Moved cache declaration above `handleUARTLine` |
| `server.js` | Unhandled `EADDRINUSE` crash when port 5002 busy | Added `apiServer.on("error")` with clear message |
| `app.js` | Vote transaction crashed if `PartyDB` doc missing | Creates party doc on first vote if absent |
| `app.js` | `fingerprint.png` referenced but file missing | Replaced with bundled `fingerprint.svg` |
| `app.js` | Null dereference in Aadhaar pre-verify reset | Added null checks for `verifyFpSensor` / `fpLiveStatus` |
| `app.js` | Enrollment used `/fingerprint/capture` mock instead of UART `TEMPLATE_N` | Waits for real R307 base64 per sample + `enroll-status` poll |
| `app.js` | HW enroll button called mock `/stm32/enroll` | Redirected to real `cmd-enroll` flow via `startEnrollment()` |
| `app.js` | Vote verify called `/stm32/verify` auto-pass after match | Removed — only UART `MATCH_OK` unlocks ballot |
| `server.js` | Mock `/stm32/enroll` and `/stm32/verify` bypassed real R307 | Disabled — hardware path required |
| `server.js` | `cmd-verify` sent templates without validation or delay | Requires 5 real templates, 80ms delay between `LOAD_TEMPLATE` |
| `main.c` | CharBuffer upload failure sent `PLACEHOLDER_*` templates | Enrollment aborts on upload failure |
| `main.c` | `LOAD_TEMPLATE` accepted placeholder strings | Rejects invalid/placeholder base64 |

---

## 📸 Tabs Overview

| Tab | Description |
|-----|-------------|
| 📥 Registration | Register voters with 5-sample consent enrollment |
| 🗳️ Secure Voting | Aadhaar + multi-template fingerprint verify (80 % threshold) |
| 📊 Stats Dashboard | Real-time vote results |
| 👥 Registered Voters | Live Firebase table |
| ✅ Completed Votes | Live Firebase table |

## 💾 Permanent Backend Storage

To ensure that fingerprint templates are not lost when the backend server restarts, the system utilizes permanent JSON database storage:
- **Fingerprint Database**: Saved in `fingerprint-server/fingerprint_db.json`.
- **Template Store**: Saved in `fingerprint-server/template_store.json`.
- **Automatic Sync**: The databases are loaded automatically on server startup. Any biometric updates (from new registrations, enrollments, or updates) are written back immediately to these files.

---

## Demo Mode

When no STM32 hardware is connected, the system automatically falls back to **Demo Mode**:
- **Simulated Biometric Enrollment**: Automatically simulates the collection of 5 fingerprint samples with per-sample voter consent dialogs.
- **Simulated Biometric Verification**: Simulates a 2-second fingerprint scan, validating the voter against their registered fingerprint templates.
- **Hardware Badge**: Displays 🟡 `STM32: Not Connected` to indicate simulation mode.
- Allows testing of all registration, consent, secure voting, and real-time dashboard updates without needing a physical microcontroller connected.

> **Production voting requires STM32 + R307 hardware.** When the board is connected, the system transitions to real hardware UART communication automatically.
