# 🛡️ SecEVM — Biometric EVM Secure Voting System

SecEVM is a secure, web-based Electronic Voting Machine built around an **R307 optical fingerprint sensor** connected to an **STM32 microcontroller**. It enforces biometric identity at every step — enrollment, consent, and voting — backed by Firebase Firestore and a Node.js or Python bridge server.

---

## ✨ What's New (Latest Update)

| Feature | Detail |
|---------|--------|
| **Per-sample consent** | Before saving each of the 5 fingerprint samples the voter sees a confirmation dialog: "Sample N captured — do you consent to saving this sample?" Yes proceeds; No aborts enrollment |
| **Multi-template fusion** | All 5 CharBuffer templates (Tz1–Tz5) are base64-encoded and uploaded from the STM32 to the backend. At verification time all 5 are loaded back and the R307 Search scans all pages in one pass — identical to how phone fingerprint sensors work |
| **80 % match threshold** | The R307 Search response includes a 16-bit confidence score (0–65535). SecEVM only accepts a match when the score is ≥ 52428 (80 % of max). A "found but weak" scan returns `REASON=SCORE_LOW` and is rejected with a clear UI message |
| **Enrollment completion banner** | After all 5 samples are consented and stored, a full-screen banner confirms: "✅ Fingerprint enrollment complete. 5 samples fused into a single biometric identity for XXXX-XXXX-XXXX" |
| **Demo Mode support** | When no hardware is connected the consent dialog auto-approves after 3 seconds, allowing full offline testing |
| **Firestore fields** | `fp_sample_count: 5`, `fingerprint_status: "enrolled"`, `enrolled_at: <timestamp>` written on successful enrollment |

---

## ✨ Core Features

### 📥 Registration
- Voter registration with 12-digit Aadhaar validation
- Collects name, mobile, email, gender, date of birth; auto age calculation with 18+ check
- **5-sample enrollment with per-sample consent** — each sample pauses and waits for the voter to tap Yes or No
- All 5 CharBuffer templates base64-uploaded and fused into a single biometric identity
- Saves voter record to Firebase Firestore (or `localStorage` in Demo Mode)

### 🗳️ Secure Voting
- Aadhaar-based voter lookup with real-time pre-verification card
- Biometric verification: all 5 stored templates loaded into STM32 via `LOAD_TEMPLATE`, then a single `CMD_VERIFY` triggers `Search` across all pages
- **80 % confidence threshold enforced in firmware** — partial, rotated, or low-pressure scans below the threshold are rejected
- Ballot unlocked only on `MATCH_OK` (score ≥ 80 %)
- One-vote-per-voter enforced via Firestore atomic transaction

### 📊 Stats Dashboard
- Real-time vote counts and percentage bars for all parties

### 👥 Registered Voters & ✅ Completed Votes
- Live Firebase `onSnapshot` tables with search, filter, and summary stats

### 🔌 Developer Hub
- Integration code templates for React, Next.js, Vue, Angular, WordPress, Shopify, and more

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

## 🔄 Enrollment Protocol (Per-Sample Consent + Template Upload)

```
PC sends CMD_ENROLL:<aadhaar>
  For each sample n = 1..5:
    STM32: GenImg → Img2Tz(slot1)
    STM32 → PC:  SAMPLE_READY:ID=<aadhaar>:SAMPLE=<n>
    PC pauses enrollment; frontend shows consent dialog
      Voter clicks YES  → PC sends ACK_SAMPLE:<aadhaar>:<n>
      Voter clicks NO   → PC sends ABORT_ENROLL:<aadhaar>  → stop
    STM32: UpChar(slot1) → base64 encode
    STM32 → PC:  TEMPLATE_<n>:ID=<aadhaar>:DATA=<base64>
    PC stores template in memory + Firestore

  After 5 ACKs:
    STM32: capture pair → RegModel → Store(page 1)
    STM32 → PC:  ENROLL_OK:ID=<aadhaar>:SAMPLES=5
    PC writes Firestore: { fp_samples:[...], fp_sample_count:5,
                           fingerprint_status:"enrolled", enrolled_at:<ts> }
    Frontend: shows ✅ enrollment completion banner
```

---

## 🔄 Verification Protocol (Multi-Template Fusion)

```
PC: fetch all 5 templates from Firestore for <aadhaar>
PC → STM32:  LOAD_TEMPLATE:1:<base64>
             LOAD_TEMPLATE:2:<base64>
             ...
             LOAD_TEMPLATE:5:<base64>
  (Each: STM32 decodes base64 → DnChar into slot1 → Store at page n)
PC → STM32:  CMD_VERIFY:<aadhaar>
  STM32: GenImg → Img2Tz(slot1) → Search(pages 0..9)
  STM32 reads 16-byte Search response:
    score ≥ 80% → MATCH_OK ID=<aadhaar>
    score <  80% → MATCH_FAIL ID=<aadhaar>:REASON=SCORE_LOW
    not found    → MATCH_FAIL ID=<aadhaar>:REASON=MISMATCH
PC/frontend: polls /stm32/match-status → updates ballot lock
```

---

## 🖥️ Hardware Badge

| Badge | Meaning |
|-------|---------|
| 🟢 `Hardware: Live` | STM32 + bridge online |
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

### 1. Clone

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

### 3. Start the backend (Node.js)

```bash
node fingerprint-server/server.js
```

Runs on `http://localhost:5002`. STM32 auto-detected by USB VID `0483` (STMicroelectronics).

Pin a specific port:
```bash
# Windows
set STM32_PORT=COM3 && node fingerprint-server/server.js

# Linux / macOS
STM32_PORT=/dev/ttyUSB0 node fingerprint-server/server.js
```

### 4. Start the frontend

```bash
node serve.js
```

Runs on `http://localhost:3000`.

> ⚠️ Open via `http://localhost:3000` — not `file://`. ES module imports and fetch calls require HTTP.

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
│   └── fingerprint.png     # Fingerprint icon
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
├── serve.js                # Static HTTP server for frontend (port 3000)
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
| Green LED | PA5 | Output |
| Red LED   | PA6 | Output |
| Buzzer    | PB0 | Output |
| BTN_CONFIRM (Blue button) | PC13 | Input, active-low |
| BTN_NEXT (digit cycle)    | PB1  | Input, active-low, pull-up |

USART1 (R307): 57600 baud — USART2 (PC bridge): 115200 baud

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

- Voters under 18 cannot register
- One vote per voter enforced via Firestore atomic transaction
- Biometric ballot lock: ballot only unlocks on `MATCH_OK` with score ≥ 80 %
- Per-sample consent: voter explicitly approves each of the 5 samples
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
| Web Server | Node.js HTTP (`serve.js`, port 3000) |

---

## 🐛 Known Issues Fixed

| File | Issue | Fix |
|------|-------|-----|
| `main.c` | R307 Search response read from wrong UART (`huart2`) | Fixed to `huart1` |
| `main.c` | No confidence threshold — any `0x00` confirmation accepted | 80% score gate added |
| `server.js` | UART key=value parser split on all `=`, broke base64 values | Split only on first `=` |
| `server.js` | Serial `data` event processed per chunk not per line | `_uartBuffer` accumulator added |
| `app.js` | Enrollment used `setInterval` — no pause between samples | Replaced with `async for` loop + consent dialog |
| `fp_bridge.py` | `MATCH_FAIL` reason not stored in Firestore | `last_verify_reason` field added |
| `serve.js` | No path sanitization | `path.resolve` + boundary check added |

---

## 📸 Tabs Overview

| Tab | Description |
|-----|-------------|
| 📥 Registration | Register voters with 5-sample consent enrollment |
| 🗳️ Secure Voting | Aadhaar + multi-template fingerprint verify (80 % threshold) |
| 📊 Stats Dashboard | Real-time vote results |
| 👥 Registered Voters | Live Firebase table |
| ✅ Completed Votes | Live Firebase table |
| 🔌 Developer Hub | Integration code + AI prompt generator |

---

## Demo Mode

All features work without an STM32 connected:
- Consent dialogs auto-approve after 3 seconds
- Templates stored as `MOCK_FP_<aadhaar>_<n>_<random>` placeholders
- Verification auto-succeeds for registered eligible voters
- Hardware badge shows 🟡 `STM32: Not Connected`
