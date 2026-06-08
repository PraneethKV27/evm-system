# 🛡️ SecEVM - Biometric EVM Secure Voting System

SecEVM is a secure, web-based Electronic Voting Machine (EVM) simulation built with biometric fingerprint verification, real-time Firebase Firestore integration, and a clean dark-mode UI. It covers the full voting lifecycle — from voter registration to ballot casting — with live data dashboards.

---

## ✨ Features

### 📥 Registration
- Voter registration with Aadhaar number validation (exactly 12 digits)
- Collects name, mobile, email, gender, and date of birth
- Auto age calculation with 18+ eligibility check
- Biometric fingerprint enrollment — captures 5 samples with visual gallery preview
- Saves voter record to Firebase Firestore (or localStorage in demo mode)

### 🗳️ Secure Voting
- Aadhaar-based voter lookup with real-time pre-verification card
- Shows voter name, age eligibility, and voting status before fingerprint scan
- Biometric verification with live vs. registered fingerprint comparison panel
- Secure ballot with 5 party options + NOTA
- One-vote-per-voter enforced via Firestore transaction

### 📊 Stats Dashboard
- Real-time vote counts and percentage bars for all parties
- Total votes cast, biometric verification rate, security status

### 👥 Registered Voters *(New)*
- Live table of all registered voters from Firebase (updates instantly)
- Columns: masked Aadhaar, name, age, gender, mobile, email, DOB, eligibility, vote status
- Summary bar: total registered, eligible, voted, pending
- Search by name or Aadhaar, filter by eligibility/vote status

### ✅ Completed Votes *(New)*
- Live table of all voters who have completed their vote
- Columns: masked Aadhaar, name, age, gender, party voted, timestamp
- Summary bar: total votes, leading party, leader vote count, voter turnout %
- Search by name or Aadhaar, filter by party

### 🔌 Developer Hub
- Integration code templates for React, Next.js, Vue, Angular, WordPress, Shopify, Drupal, and more
- AI prompt generator for Claude to scaffold full voting components
- Configurable API URL, tech stack, integration type, and theme

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

Runs on `http://localhost:5002` — handles fingerprint capture, store, and verify endpoints.

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
│   ├── index.html          # Main UI — all 6 tabs
│   ├── app.js              # Firebase logic, tab controllers, live listeners
│   ├── style.css           # Dark-mode UI styles
│   └── fingerprint.png     # Fingerprint icon asset
├── fingerprint-server/
│   ├── server.js           # Node.js Express fingerprint API (port 5002)
│   └── package.json
├── fingerprint_bridge/
│   └── fp_bridge.py        # Python bridge (Flask + pyserial) — STM32 UART → Firestore
│                           # Endpoints: /fingerprint/capture|store|verify, /stm32/event|enroll, /vote, /status
├── functions/
│   └── index.js            # Firebase Cloud Functions (scaffolded)
├── serve.js                # Simple Node.js HTTP server for the frontend (port 3000)
├── firebase.json           # Firebase hosting + Firestore config
├── firestore.rules         # Firestore security rules
└── firestore.indexes.json
```

---

## 🔌 API Endpoints

### Fingerprint Server — Node.js (`fingerprint-server/server.js`, port 5002)
Used when no hardware is attached (simulated mode).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/fingerprint/capture` | Returns a simulated fingerprint template |
| POST | `/fingerprint/store` | Stores enrolled samples in memory |
| POST | `/fingerprint/verify` | Verifies a live scan against in-memory samples |

---

### Python Bridge — STM32 UART (`fingerprint_bridge/fp_bridge.py`, port 5002)
Used when the STM32 fingerprint module is physically connected. Replaces the Node.js server.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/fingerprint/capture` | Triggers live scan on STM32 via UART, falls back to Firestore |
| POST | `/fingerprint/store` | Saves enrolled samples to Firestore |
| POST | `/fingerprint/verify` | Sends `VERIFY` command to STM32, falls back to Firestore match |
| POST | `/vote` | Casts a vote via Firestore atomic transaction |
| POST | `/stm32/event` | Accepts raw UART line as JSON `{ "line": "ENROLL_OK:ID=..."}` |
| POST | `/stm32/enroll` | Direct enroll signal from STM32 `{ "voter_id": "...", "samples": 5 }` |
| GET  | `/status` | Returns bridge health, hardware connection state, Firebase status |

#### STM32 UART Message Format

The bridge reads lines from the STM32 over serial and maps them to Firestore actions:

| UART Message | Action |
|---|---|
| `ENROLL_OK:ID=<aadhaar>:SAMPLES=<n>` | Saves `fp_samples` + `fingerprint_status: enrolled` to VoterDB |
| `VERIFY_OK:ID=<aadhaar>` | Updates `last_verify_status: matched` in VoterDB |
| `VERIFY_FAIL:ID=<aadhaar>` | Updates `last_verify_status: mismatch` in VoterDB |
| `VOTE_CAST:ID=<aadhaar>:PARTY=<party>` | Atomic vote transaction — updates VoterDB + PartyDB |
| `TEMPLATE:<template_string>` | Returned by STM32 in response to a `CAPTURE:` command |
| `ERROR:<message>` | Logged to console |

#### Running the Python Bridge

```bash
cd fingerprint_bridge

# Install dependencies
pip install flask flask-cors firebase-admin pyserial

# Set your COM port (or use env variable)
set STM32_PORT=COM3       # Windows
export STM32_PORT=/dev/ttyUSB0  # Linux/macOS

# Place serviceAccountKey.json in fingerprint_bridge/
python fp_bridge.py
```

> The bridge runs on port `5002` by default — same as the Node.js server. Run only one at a time.

---

## 🔒 Security

- Voters cannot register if under 18
- Voters can only cast one vote (enforced by Firestore atomic transaction)
- Biometric fingerprint match required before ballot is unlocked
- Aadhaar numbers are masked (`XXXX-XXXX-XXXX`) in all data display tables
- Firebase Firestore rules control read/write access

---

## 🛠️ Tech Stack

- **Frontend**: Vanilla HTML, CSS, JavaScript (ES Modules)
- **Database**: Firebase Firestore (real-time `onSnapshot`)
- **Fingerprint Server**: Node.js + Express
- **Python Bridge** *(optional)*: Flask + `firebase-admin` for hardware integration
- **Hosting**: Firebase Hosting / local Node.js server

---

## 📸 Tabs Overview

| Tab | Description |
|-----|-------------|
| 📥 Registration | Register voters with biometric enrollment |
| 🗳️ Secure Voting | Aadhaar + fingerprint verified ballot casting |
| 📊 Stats Dashboard | Real-time vote results and party charts |
| 👥 Registered Voters | Live table of all registered voters with full details |
| ✅ Completed Votes | Live table of voters who have cast their vote |
| 🔌 Developer Hub | Integration code and AI prompt generator |
