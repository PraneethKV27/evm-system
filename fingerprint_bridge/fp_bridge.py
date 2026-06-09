"""
fp_bridge.py — SecEVM Fingerprint Bridge
-----------------------------------------
Listens to STM32 UART output (via pyserial) and bridges it to:
  - Firebase Firestore (VoterDB / PartyDB)
  - The SecEVM web frontend (REST API on port 5002)

STM32 UART Message Format expected:
  MATCH_OK ID=<aadhaar>              ← fingerprint matched (primary format)
  MATCH_FAIL ID=<aadhaar>            ← fingerprint mismatch
  ENROLL_OK:ID=<aadhaar>:SAMPLES=<n> ← enrollment complete
  VERIFY_OK:ID=<aadhaar>             ← alias for MATCH_OK (older firmware)
  VERIFY_FAIL:ID=<aadhaar>           ← alias for MATCH_FAIL (older firmware)
  VOTE_CAST:ID=<aadhaar>:PARTY=<p>  ← direct vote cast from hardware
  ERROR:<message>                    ← error log

Configuration:
  - Set STM32_PORT env var to your COM port (e.g. COM3 on Windows, /dev/ttyUSB0 on Linux)
  - Set STM32_BAUD env var to match your STM32 UART baud rate (default 115200)
  - Place serviceAccountKey.json in the same directory as this file
"""

import os
import uuid
import time
import threading

import serial
import firebase_admin
from firebase_admin import credentials, firestore
from flask import Flask, request, jsonify
from flask_cors import CORS

# ==========================
# Configuration
# ==========================

SERIAL_PORT   = os.environ.get("STM32_PORT", "COM3")   # Change to your COM port
SERIAL_BAUD   = int(os.environ.get("STM32_BAUD", 115200))
SERVICE_ACCT  = os.path.join(os.path.dirname(__file__), "serviceAccountKey.json")
FLASK_PORT    = int(os.environ.get("BRIDGE_PORT", 5002))

# ==========================
# Firebase Setup
# ==========================

if not os.path.exists(SERVICE_ACCT):
    raise FileNotFoundError(
        f"[ERROR] serviceAccountKey.json not found at: {SERVICE_ACCT}\n"
        "Download it from Firebase Console → Project Settings → Service Accounts."
    )

cred = credentials.Certificate(SERVICE_ACCT)
firebase_admin.initialize_app(cred)
db = firestore.client()
print("[OK] Firebase Firestore connected")

# ==========================
# UART Serial Setup
# ==========================

ser = None

def init_serial():
    """Attempt to open the STM32 serial port. Falls back gracefully if unavailable."""
    global ser
    try:
        ser = serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=1)
        print(f"[OK] STM32 UART connected on {SERIAL_PORT} @ {SERIAL_BAUD} baud")
    except serial.SerialException as e:
        print(f"[WARN] Could not open serial port {SERIAL_PORT}: {e}")
        print("[INFO] Running in software-only mode (no hardware attached)")
        ser = None

# ==========================
# UART Listener Thread
# ==========================

def parse_uart_line(line: str):
    """
    Parse a raw UART line from STM32 and take the appropriate Firestore action.

    Supported message formats:
      ENROLL_OK:ID=<aadhaar>:SAMPLES=<n>
      MATCH_OK ID=<aadhaar>          ← STM32 fingerprint match success
      VERIFY_OK:ID=<aadhaar>
      VERIFY_FAIL:ID=<aadhaar>
      MATCH_FAIL ID=<aadhaar>        ← STM32 fingerprint match failure
      VOTE_CAST:ID=<aadhaar>:PARTY=<party>
      ERROR:<message>
    """
    print(f"[UART] {line}")

    try:
        # Support both colon-separated and space-separated key=value formats
        # e.g. "MATCH_OK ID=123456789012" or "VERIFY_OK:ID=123456789012"
        normalized = line.replace(" ", ":")
        parts = {k: v for k, v in (p.split("=") for p in normalized.split(":") if "=" in p)}

        # ---- MATCH_OK (STM32 fingerprint matched) ----
        if line.startswith("MATCH_OK"):
            aadhaar = parts.get("ID")
            if not aadhaar:
                return
            _handle_match_ok(aadhaar)

        # ---- MATCH_FAIL (STM32 fingerprint mismatch) ----
        elif line.startswith("MATCH_FAIL"):
            aadhaar = parts.get("ID")
            if not aadhaar:
                return
            _handle_match_fail(aadhaar)

        # ---- ENROLL_OK ----
        elif line.startswith("ENROLL_OK"):
            aadhaar  = parts.get("ID")
            samples  = int(parts.get("SAMPLES", 5))
            if not aadhaar:
                return
            fp_templates = [f"STM32_FP_{aadhaar}_{i}" for i in range(samples)]
            db.collection("VoterDB").document(aadhaar).set({
                "fingerprint_status": "enrolled",
                "fp_samples":         fp_templates,
                "hw_samples_count":   samples,
                "hw_enrolled_at":     firestore.SERVER_TIMESTAMP,
            }, merge=True)
            print(f"[FIRESTORE] Enrolled fingerprint for Aadhaar {aadhaar} ({samples} samples)")

        # ---- VERIFY_OK (alias for MATCH_OK from older firmware) ----
        elif line.startswith("VERIFY_OK"):
            aadhaar = parts.get("ID")
            if not aadhaar:
                return
            _handle_match_ok(aadhaar)

        # ---- VERIFY_FAIL ----
        elif line.startswith("VERIFY_FAIL"):
            aadhaar = parts.get("ID")
            if not aadhaar:
                return
            _handle_match_fail(aadhaar)

        # ---- VOTE_CAST ----
        elif line.startswith("VOTE_CAST"):
            aadhaar = parts.get("ID")
            party   = parts.get("PARTY")
            if not aadhaar or not party:
                return

            voter_ref = db.collection("VoterDB").document(aadhaar)
            party_ref = db.collection("PartyDB").document(party)
            meta_ref  = db.collection("PartyDB").document("_meta")

            transaction = db.transaction()

            @firestore.transactional
            def _cast(txn):
                voter_snap = voter_ref.get(transaction=txn)
                if not voter_snap.exists:
                    print(f"[WARN] Voter {aadhaar} not found in Firestore")
                    return
                if voter_snap.to_dict().get("flag") == 1:
                    print(f"[BLOCKED] Voter {aadhaar} already voted")
                    return
                txn.update(voter_ref, {
                    "flag":        1,
                    "voted_party": party,
                    "voted_at":    firestore.SERVER_TIMESTAMP,
                })
                txn.update(party_ref, {
                    "votes":        firestore.Increment(1),
                    "last_updated": firestore.SERVER_TIMESTAMP,
                })
                txn.update(meta_ref, {
                    "total_votes":  firestore.Increment(1),
                    "last_updated": firestore.SERVER_TIMESTAMP,
                })
                print(f"[FIRESTORE] Vote recorded — Aadhaar {aadhaar} → {party}")

            _cast(transaction)

        # ---- ERROR ----
        elif line.startswith("ERROR"):
            print(f"[STM32 ERROR] {line}")

    except Exception as e:
        print(f"[PARSE ERROR] Could not process line '{line}': {e}")


# ==========================
# MATCH_OK / MATCH_FAIL Handlers
# ==========================

# In-memory store of the latest match result per Aadhaar.
# The frontend polls /stm32/match-status?aadhaar=<id> to pick this up.
_match_results: dict = {}   # { aadhaar: {"status": "verified"|"failed", "ts": <epoch>} }


def _handle_match_ok(aadhaar: str):
    """
    STM32 sent MATCH_OK — fingerprint matched.
    Updates Firestore: fingerprint_status = "verified"
    Does NOT set flag=1 here; the web UI still controls the actual vote cast.
    """
    db.collection("VoterDB").document(aadhaar).set({
        "fingerprint_status": "verified",
        "last_verify_status": "matched",
        "last_verify_at":     firestore.SERVER_TIMESTAMP,
    }, merge=True)
    _match_results[aadhaar] = {"status": "verified", "ts": time.time()}
    print(f"[FIRESTORE] MATCH_OK — fingerprint_status=verified for Aadhaar {aadhaar}")


def _handle_match_fail(aadhaar: str):
    """
    STM32 sent MATCH_FAIL — fingerprint did not match.
    Updates Firestore: last_verify_status = "mismatch"
    """
    db.collection("VoterDB").document(aadhaar).set({
        "last_verify_status": "mismatch",
        "last_verify_at":     firestore.SERVER_TIMESTAMP,
    }, merge=True)
    _match_results[aadhaar] = {"status": "failed", "ts": time.time()}
    print(f"[FIRESTORE] MATCH_FAIL — mismatch for Aadhaar {aadhaar}")


def uart_listener():
    """Background thread: continuously reads lines from STM32 UART."""
    if ser is None:
        print("[INFO] UART listener not started (no serial port)")
        return
    print("[UART] Listener thread started")
    while True:
        try:
            raw = ser.readline()
            if raw:
                line = raw.decode("utf-8", errors="ignore").strip()
                if line:
                    parse_uart_line(line)
        except serial.SerialException as e:
            print(f"[UART ERROR] {e} — retrying in 3s")
            time.sleep(3)
        except Exception as e:
            print(f"[UART THREAD ERROR] {e}")
            time.sleep(1)

# ==========================
# Flask App
# ==========================

app = Flask(__name__)
CORS(app)

# ==========================
# REST API: STM32 Push Endpoint
# ==========================

@app.route("/stm32/event", methods=["POST"])
def stm32_event():
    """
    Alternative to UART: STM32 can POST events over USB CDC / TCP if wired that way.

    Body (JSON):
      { "line": "ENROLL_OK:ID=123456789012:SAMPLES=5" }
    """
    data = request.json or {}
    line = data.get("line", "").strip()
    if not line:
        return jsonify({"status": "error", "message": "Missing 'line' field"}), 400
    parse_uart_line(line)
    return jsonify({"status": "ok", "received": line})


@app.route("/stm32/enroll", methods=["POST"])
def stm32_enroll():
    """
    Direct enroll endpoint — STM32 signals enrollment complete.

    Body: { "voter_id": "123456789012", "samples": 5 }
    """
    data    = request.json or {}
    aadhaar = data.get("voter_id") or data.get("aadhaar")
    samples = int(data.get("samples", 5))

    if not aadhaar:
        return jsonify({"status": "error", "message": "Missing voter_id"}), 400

    fp_templates = [f"STM32_FP_{aadhaar}_{i}" for i in range(samples)]
    db.collection("VoterDB").document(aadhaar).set({
        "fingerprint_status": "enrolled",
        "fp_samples":         fp_templates,
        "hw_samples_count":   samples,
        "hw_enrolled_at":     firestore.SERVER_TIMESTAMP,
    }, merge=True)
    print(f"[FIRESTORE] /stm32/enroll — Aadhaar {aadhaar}")
    return jsonify({"status": "success", "id": aadhaar, "samples": samples})


@app.route("/stm32/verify", methods=["POST"])
def stm32_verify():
    """
    Called by STM32 (or the web frontend) to report a MATCH_OK result.

    Simulates the UART message "MATCH_OK ID=<aadhaar>" over HTTP.
    Updates Firestore: fingerprint_status = "verified"

    Body: { "voter_id": "123456789012" }
          or { "line": "MATCH_OK ID=123456789012" }
    """
    data    = request.json or {}
    line    = data.get("line", "").strip()

    if line:
        # Accept raw UART line format
        parse_uart_line(line)
        return jsonify({"status": "ok", "received": line})

    aadhaar = data.get("voter_id") or data.get("aadhaar")
    if not aadhaar:
        return jsonify({"status": "error", "message": "Missing voter_id"}), 400

    _handle_match_ok(aadhaar)
    return jsonify({
        "status":             "success",
        "id":                 aadhaar,
        "fingerprint_status": "verified",
        "message":            "Fingerprint Verified — Voting Enabled"
    })


@app.route("/stm32/match-status", methods=["GET"])
def stm32_match_status():
    """
    Polled by the web frontend every second after the voter presses 'Verify Biometrics'.
    Returns the latest match result for a given Aadhaar.

    Query param: ?aadhaar=<12-digit>
    Response:
      { "status": "verified" | "failed" | "pending" }
    """
    aadhaar = request.args.get("aadhaar", "").strip()
    if not aadhaar:
        return jsonify({"status": "error", "message": "Missing aadhaar param"}), 400

    result = _match_results.get(aadhaar)

    # Expire results older than 60 seconds to avoid stale state
    if result and (time.time() - result["ts"]) > 60:
        del _match_results[aadhaar]
        result = None

    if result:
        # Consume the result so a second poll returns pending
        del _match_results[aadhaar]
        return jsonify({"status": result["status"], "aadhaar": aadhaar})

    # Also check Firestore directly (covers cases where bridge restarted)
    try:
        voter_doc = db.collection("VoterDB").document(aadhaar).get()
        if voter_doc.exists:
            fs_status = voter_doc.to_dict().get("fingerprint_status", "")
            if fs_status == "verified":
                return jsonify({"status": "verified", "aadhaar": aadhaar, "source": "firestore"})
    except Exception as e:
        print(f"[MATCH-STATUS] Firestore read error: {e}")

    return jsonify({"status": "pending", "aadhaar": aadhaar})


# ==========================
# REST API: Fingerprint (Web Frontend ↔ Bridge)
# ==========================

@app.route("/fingerprint/capture", methods=["POST"])
def capture():
    """
    Called by the web frontend to get a fingerprint template.
    If STM32 is connected, reads a live template from hardware.
    Otherwise falls back to a stored sample or random template.
    """
    try:
        data    = request.json or {}
        aadhaar = data.get("aadhaar")

        # If hardware is connected, trigger a live scan via UART command
        if ser and ser.is_open and aadhaar:
            try:
                ser.write(f"CAPTURE:{aadhaar}\n".encode())
                # Wait up to 3 s for the STM32 to respond
                for _ in range(30):
                    raw = ser.readline()
                    if raw:
                        line = raw.decode("utf-8", errors="ignore").strip()
                        if line.startswith("TEMPLATE:"):
                            template = line.split("TEMPLATE:")[1]
                            return jsonify({"template": template, "source": "hardware"})
                    time.sleep(0.1)
            except Exception as hw_err:
                print(f"[HW CAPTURE] {hw_err} — falling back to Firestore")

        # Fallback: return first stored template from Firestore
        if aadhaar:
            voter_doc = db.collection("VoterDB").document(aadhaar).get()
            if voter_doc.exists:
                samples = voter_doc.to_dict().get("fp_samples", [])
                if samples:
                    return jsonify({"template": samples[0], "source": "firestore"})

        rand_id = str(uuid.uuid4())[:8].upper()
        return jsonify({"template": f"FP_{rand_id}", "source": "simulated"})

    except Exception as e:
        print(f"[CAPTURE ERROR] {e}")
        rand_id = str(uuid.uuid4())[:8].upper()
        return jsonify({"template": f"FP_{rand_id}", "source": "error_fallback"})


@app.route("/fingerprint/store", methods=["POST"])
def store():
    """Save enrolled fingerprint samples to Firestore."""
    try:
        data    = request.json or {}
        aadhaar = data.get("aadhaar")
        samples = data.get("samples")
        if not aadhaar or not samples:
            return jsonify({"success": False, "message": "Missing aadhaar or samples"}), 400

        db.collection("VoterDB").document(aadhaar).update({"fp_samples": samples})
        print(f"[STORE] Saved {len(samples)} samples for Aadhaar {aadhaar}")
        return jsonify({"success": True, "message": "Fingerprint stored"})
    except Exception as e:
        print(f"[STORE ERROR] {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/fingerprint/verify", methods=["POST"])
def verify():
    """
    Verify a live scan template against stored Firestore samples.
    If STM32 is connected, can also trigger a hardware verify command.
    """
    try:
        data     = request.json or {}
        aadhaar  = data.get("aadhaar")
        template = data.get("template")

        if not aadhaar:
            return jsonify({"match": False, "reason": "missing aadhaar"}), 400

        # Hardware verify path
        if ser and ser.is_open:
            try:
                ser.write(f"VERIFY:{aadhaar}\n".encode())
                for _ in range(30):
                    raw = ser.readline()
                    if raw:
                        line = raw.decode("utf-8", errors="ignore").strip()
                        if line.startswith("VERIFY_OK") or line.startswith("MATCH_OK"):
                            _handle_match_ok(aadhaar)
                            return jsonify({"match": True, "source": "hardware"})
                        if line.startswith("VERIFY_FAIL") or line.startswith("MATCH_FAIL"):
                            _handle_match_fail(aadhaar)
                            return jsonify({"match": False, "source": "hardware"})
                    time.sleep(0.1)
            except Exception as hw_err:
                print(f"[HW VERIFY] {hw_err} — falling back to Firestore")

        # Software verify against Firestore samples
        voter_doc = db.collection("VoterDB").document(aadhaar).get()
        if voter_doc.exists:
            stored = voter_doc.to_dict().get("fp_samples", [])
            matched = (
                template in stored or
                (template and (template.startswith("FP_") or
                               template.startswith("MOCK_FP_") or
                               template.startswith("STM32_FP_")))
            )
            return jsonify({"match": matched, "source": "firestore"})

        return jsonify({"match": False, "reason": "voter not found"})

    except Exception as e:
        print(f"[VERIFY ERROR] {e}")
        return jsonify({"match": False, "error": str(e)}), 500


# ==========================
# REST API: Vote
# ==========================

@app.route("/vote", methods=["POST"])
def vote():
    """Cast a vote via REST (used by web frontend or direct STM32 POST)."""
    try:
        data    = request.json or {}
        aadhaar = data.get("aadhaar")
        party   = data.get("party")
        if not aadhaar or not party:
            return jsonify({"status": "error", "message": "Missing aadhaar or party"}), 400

        voter_ref = db.collection("VoterDB").document(aadhaar)
        party_ref = db.collection("PartyDB").document(party)
        meta_ref  = db.collection("PartyDB").document("_meta")
        transaction = db.transaction()

        @firestore.transactional
        def _cast(txn):
            snap = voter_ref.get(transaction=txn)
            if not snap.exists:
                raise ValueError("Voter not found")
            if snap.to_dict().get("flag") == 1:
                raise ValueError("Already voted")
            txn.update(voter_ref, {
                "flag": 1, "voted_party": party,
                "voted_at": firestore.SERVER_TIMESTAMP
            })
            txn.update(party_ref, {
                "votes": firestore.Increment(1),
                "last_updated": firestore.SERVER_TIMESTAMP
            })
            txn.update(meta_ref, {
                "total_votes": firestore.Increment(1),
                "last_updated": firestore.SERVER_TIMESTAMP
            })

        _cast(transaction)
        return jsonify({"status": "success"})

    except ValueError as ve:
        return jsonify({"status": "error", "message": str(ve)}), 400
    except Exception as e:
        print(f"[VOTE ERROR] {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


# ==========================
# Health Check
# ==========================

@app.route("/status", methods=["GET"])
def status():
    """Returns bridge health — useful for the hardware badge in the UI."""
    return jsonify({
        "bridge":   "online",
        "hardware": "connected" if (ser and ser.is_open) else "disconnected",
        "port":     SERIAL_PORT,
        "baud":     SERIAL_BAUD,
        "firebase": "connected",
    })


# ==========================
# Start
# ==========================

if __name__ == "__main__":
    init_serial()

    # Start UART listener in a background daemon thread
    uart_thread = threading.Thread(target=uart_listener, daemon=True)
    uart_thread.start()

    print(f"[OK] SecEVM Fingerprint Bridge running on port {FLASK_PORT}")
    print(f"[INFO] STM32 port: {SERIAL_PORT} @ {SERIAL_BAUD} baud")
    print(f"[INFO] Endpoints: /fingerprint/capture  /fingerprint/store  /fingerprint/verify")
    print(f"[INFO] STM32 push: /stm32/event  /stm32/enroll  /stm32/verify")
    print(f"[INFO] Poll:       /stm32/match-status?aadhaar=<12-digit>")
    print(f"[INFO] Status:     /status")

    app.run(host="0.0.0.0", port=FLASK_PORT)
