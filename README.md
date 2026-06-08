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
│   └── fp_bridge.py        # Python bridge (Flask) — connects to real hardware + Firebase
├── functions/
│   └── index.js            # Firebase Cloud Functions (scaffolded)
├── serve.js                # Simple Node.js HTTP server for the frontend (port 3000)
├── firebase.json           # Firebase hosting + Firestore config
├── firestore.rules         # Firestore security rules
└── firestore.indexes.json
```

---

## 🔌 API Endpoints (Fingerprint Server — port 5002)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/fingerprint/capture` | Captures a fingerprint sample (real or simulated) |
| POST | `/fingerprint/store` | Stores enrolled fingerprint samples for an Aadhaar |
| POST | `/fingerprint/verify` | Verifies a live scan against stored samples |

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
