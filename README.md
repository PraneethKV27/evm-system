# 🛡️ SecEVM - Biometric EVM Secure Voting System

SecEVM is a secure, web-based Electronic Voting Machine (EVM) simulation designed with biometric verification and cryptographic principles. It provides a robust interface for voter registration, biometric authentication, and secure ballot casting.

## ✨ Features

- **🗳️ Voting Terminal**:
  - Voter registration with Aadhaar validation (12-digits).
  - Age eligibility checking (18+).
  - Biometric fingerprint enrollment and live scanning simulation.
  - Secure ballot casting with immediate status updates.
- **📊 Stats Dashboard**:
  - Real-time display of total votes and party-wise vote distribution.
  - Interactive charts for visualization.
- **🔌 Developer Hub**:
  - Integration templates for platforms like React, WordPress, Next.js, Angular, Vue, and Shopify.
  - Readily available code snippets and AI prompts to ease deployment and API connections.
- **🗄️ Flexible Database Modes**:
  - **Firebase Live Mode**: Connects directly to Firebase Firestore for real-time data syncing.
  - **Demo Mode**: Falls back to the browser's `localStorage` for testing without network dependencies.

## 🚀 Getting Started

### Prerequisites

To run this application, you need to serve it over a local HTTP server (running it directly via `file:///` will block module imports due to CORS).

### Running Locally

1. Clone this repository.
2. Navigate to the project root directory.
3. Start a local server. For example, using `npx`:
   ```bash
   npx serve public -p 3000
   ```
4. Open your browser and navigate to `http://localhost:3000`.

## 📁 Project Structure

- `public/`: Contains the frontend assets (`index.html`, `app.js`, `style.css`).
- `firebase.json` / `firestore.rules`: Configuration and security rules for the Firebase backend.
- `functions/`: Serverless functions for Firebase (if any).
- `fingerprint-server/` & `fingerprint_bridge/`: Scripts or services for interfacing with physical fingerprint scanning hardware.

## 🔒 Security

This system enforces strict checks:
- Voters cannot register or vote if they are under 18.
- Voters can only cast their vote once.
- Simulated (or live via bridge) biometric fingerprint matching is required to unlock the voting ballot.
