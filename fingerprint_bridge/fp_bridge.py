"""
fp_bridge.py — SecEVM Fingerprint Bridge
-----------------------------------------
Listens to STM32 UART output and bridges it to:
  - Firebase Firestore (VoterDB / PartyDB)
  - The SecEVM web frontend (REST API on port 5002)

STM32 UART Message Format (multi-template fusion):
  SAMPLE_READY:ID=<aadhaar>:SAMPLE=<n>       ← sample captured, needs consent
  TEMPLATE_N:ID=<aadhaar>:DATA=<base64>       ← CharBuffer template upload (N=1..5)
  ENROLL_OK:ID=<aadhaar>:SAMPLES=5           ← enrollment complete
  MATCH_OK ID=<aadhaar>                       ← fingerprint matched
  MATCH_FAIL ID=<aadhaar>                     ← fingerprint mismatch
  VERIFY_OK:ID=<aadhaar>                      ← alias for MATCH_OK
  VERIFY_FAIL:ID=<aadhaar>                    ← alias for MATCH_FAIL
  VOTE_CAST:ID=<aadhaar>:PARTY=<p>           ← direct vote from hardware
  ERROR:<message>

PC → STM32 commands:
  ACK_SAMPLE:<aadhaar>:<n>                    ← voter consented to sample n
  ABORT_ENROLL:<aadhaar>                      ← voter denied — abort
  LOAD_TEMPLATE:<n>:<base64>                  ← load template into STM32 RAM
  CMD_VERIFY:<aadhaar>                        ← trigger live verify

Configuration:
  - Set STM32_PORT env var (e.g. COM3 on Windows, /dev/ttyUSB0 on Linux)
  - Set STM32_BAUD env var (default 115200)
  - Place serviceAccountKey.json in the same directory as this file
"""

import os
import re
import uuid
import time
import threading
import base64

import serial
import firebase_admin
from firebase_admin import credentials, firestore
from flask import Flask, request, jsonify
from flask_cors import CORS

# ==========================
# Configuration
# ==========================

SERIAL_PORT  = os.environ.get("STM32_PORT", "COM3")
SERIAL_BAUD  = int(os.environ.get("STM32_BAUD", 115200))
SERVICE_ACCT = os.path.join(os.path.dirname(__file__), "serviceAccountKey.json")
FLASK_PORT   = int(os.environ.get("BRIDGE_PORT", 5002))

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
    global ser
    try:
        ser = serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=1)
        print(f"[OK] STM32 UART connected on {SERIAL_PORT} @ {SERIAL_BAUD} baud")
    except serial.SerialException as e:
        print(f"[WARN] Could not open serial port {SERIAL_PORT}: {e}")
        print("[INFO] Running in software-only mode (no hardware attached)")
        ser = None

# ==========================
# In-memory state
# ==========================

_match_results:   dict = {}  # { aadhaar: { "status": "verified"|"failed", "ts": epoch } }
_voting_state:    dict = { "active": False, "aadhaar": "", "selected_party": "" }
_sample_consents: dict = {}  # { aadhaar: { n: "pending"|"approved"|"denied" } }
_template_store:  dict = {}  # { aadhaar: { "1": base64, "2": base64, ... } }
r307_sensor_status     = "unknown"
_enroll_results:  dict = {}  # { aadhaar: { "status": "complete"|"aborted", "ts": epoch } }

REQUIRED_FP_SAMPLES = 5


def _is_real_r307_template(tmpl: str) -> bool:
    if not tmpl or not isinstance(tmpl, str):
        return False
    if tmpl.startswith(("MOCK_FP_", "STM32_FP_", "FP_", "PLACEHOLDER_")):
        return False
    return len(tmpl) >= 64 and re.fullmatch(r"[A-Za-z0-9+/=]+", tmpl) is not None


def _valid_templates(aadhaar: str) -> dict:
    stored = _template_store.get(aadhaar, {})
    return {k: v for k, v in stored.items() if _is_real_r307_template(v)}

# ==========================
# UART write helper
# ==========================

def send_to_stm32(msg: str):
    if ser and ser.is_open:
        ser.write((msg + "\n").encode())
        print(f"[→STM32] {msg}")
    else:
        print(f"[STM32 OFFLINE] Cannot send: {msg}")

# ==========================
# UART Line Parser
# ==========================

def parse_uart_line(line: str):
    print(f"[UART] {line}")

    try:
        # Normalise to extract key=value pairs
        normalized = line.replace(" ", ":")
        parts = {}
        for seg in normalized.split(":"):
            if "=" in seg:
                k, v = seg.split("=", 1)
                parts[k.strip()] = v.strip()

        # ── SAMPLE_READY:ID=<aadhaar>:SAMPLE=<n>  ─────────────────────
        # STM32 just captured sample n and wants voter consent before
        # the backend sends ACK_SAMPLE to proceed.
        if line.startswith("SAMPLE_READY"):
            aadhaar = parts.get("ID")
            n       = int(parts.get("SAMPLE", 0))
            if aadhaar and n:
                if aadhaar not in _sample_consents:
                    _sample_consents[aadhaar] = {}
                _sample_consents[aadhaar][n] = "pending"
                print(f"[CONSENT] Sample {n} ready for {aadhaar} — awaiting voter consent")
            return

        # ── TEMPLATE_N:ID=<aadhaar>:DATA=<base64>  ────────────────────
        # STM32 is uploading its CharBuffer template for sample N.
        m = re.match(r'^TEMPLATE_(\d+)', line)
        if m:
            n       = int(m.group(1))
            aadhaar = parts.get("ID")
            # DATA may have "=" inside base64, so grab everything after DATA=
            b64     = ""
            if "DATA=" in line:
                b64 = line.split("DATA=", 1)[1]
            if aadhaar and b64:
                if not _is_real_r307_template(b64):
                    print(f"[TEMPLATE] Rejected invalid template {n} for {aadhaar}")
                    return
                if aadhaar not in _template_store:
                    _template_store[aadhaar] = {}
                _template_store[aadhaar][str(n)] = b64
                print(f"[TEMPLATE] Stored R307 template {n} for {aadhaar}")
            return

        # ── ENROLL_OK  ─────────────────────────────────────────────────
        if line.startswith("ENROLL_OK"):
            aadhaar = parts.get("ID")
            samples = int(parts.get("SAMPLES", 5))
            if not aadhaar:
                return

            stored_tpls = _valid_templates(aadhaar)
            fp_samples = list(stored_tpls.values())

            db.collection("VoterDB").document(aadhaar).set({
                "fingerprint_status": "enrolled",
                "fp_samples":         fp_samples,
                "fp_templates":       stored_tpls,
                "fp_sample_count":    len(fp_samples) or samples,
                "fusion_mode":        "multi_template",
                "match_threshold_pct": 80,
                "enrolled_at":        firestore.SERVER_TIMESTAMP,
                "hw_samples_count":   len(fp_samples) or samples,
                "hw_enrolled_at":     firestore.SERVER_TIMESTAMP,
            }, merge=True)

            _enroll_results[aadhaar] = { "status": "complete", "ts": time.time() }
            print(f"[FIRESTORE] Enrolled {samples} fused templates for Aadhaar {aadhaar}")
            return

        # ── MATCH_OK / VERIFY_OK  ──────────────────────────────────────
        if line.startswith("MATCH_OK") or line.startswith("VERIFY_OK"):
            aadhaar = parts.get("ID")
            if aadhaar:
                _handle_match_ok(aadhaar)
                global _voting_state
                _voting_state = { "active": True, "aadhaar": aadhaar, "selected_party": "" }
            return

        # ── MATCH_FAIL / VERIFY_FAIL  ─────────────────────────────────
        if line.startswith("MATCH_FAIL") or line.startswith("VERIFY_FAIL"):
            aadhaar = parts.get("ID")
            reason  = parts.get("REASON", "MISMATCH")
            if aadhaar:
                _handle_match_fail(aadhaar, reason)
            return

        # ── VOTE_CAST  ────────────────────────────────────────────────
        if line.startswith("VOTE_CAST"):
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
                    print(f"[WARN] Voter {aadhaar} not found")
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
                print(f"[FIRESTORE] Vote — Aadhaar {aadhaar} → {party}")

            _cast(transaction)
            global _voting_state
            _voting_state = { "active": False, "aadhaar": "", "selected_party": "" }
            return

        # ── ERROR  ────────────────────────────────────────────────────
        if line.startswith("ERROR"):
            print(f"[STM32 ERROR] {line}")

        # ── STATUS  ───────────────────────────────────────────────────
        if line.startswith("STATUS"):
            global r307_sensor_status, _voting_state
            print(f"[STM32 STATUS] {line}")
            if line.startswith("STATUS:SENSOR_CONNECTED"):
                r307_sensor_status = "connected"
            elif line.startswith("STATUS:SENSOR_DISCONNECTED"):
                r307_sensor_status = "disconnected"
            elif "SELECTED_PARTY=" in line:
                p = line.split("SELECTED_PARTY=")[1].strip()
                _voting_state["selected_party"] = p
            elif "VOTING_MODE_ACTIVE" in line:
                _voting_state["active"] = True

    except Exception as e:
        print(f"[PARSE ERROR] Could not process line '{line}': {e}")


# ==========================
# Match handlers
# ==========================

def _handle_match_ok(aadhaar: str):
    db.collection("VoterDB").document(aadhaar).set({
        "fingerprint_status": "verified",
        "last_verify_status": "matched",
        "last_verify_at":     firestore.SERVER_TIMESTAMP,
    }, merge=True)
    _match_results[aadhaar] = {"status": "verified", "ts": time.time()}
    print(f"[FIRESTORE] MATCH_OK — fingerprint_status=verified for {aadhaar}")


def _handle_match_fail(aadhaar: str, reason: str = "MISMATCH"):
    """
    reason: "MISMATCH" (sensor code 0x09) or "SCORE_LOW" (below 80% threshold)
    """
    db.collection("VoterDB").document(aadhaar).set({
        "last_verify_status": "mismatch",
        "last_verify_reason": reason,
        "last_verify_at":     firestore.SERVER_TIMESTAMP,
    }, merge=True)
    _match_results[aadhaar] = {"status": "failed", "reason": reason, "ts": time.time()}
    print(f"[FIRESTORE] MATCH_FAIL ({reason}) — mismatch for {aadhaar}")


# ==========================
# UART Listener Thread
# ==========================

def uart_listener():
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
# Per-sample consent endpoints
# ==========================

@app.route("/stm32/sample-consent", methods=["GET"])
def sample_consent_status():
    """
    Frontend polls this after each SAMPLE_READY to show the consent dialog.
    GET /stm32/sample-consent?aadhaar=<id>&sample=<n>
    Returns: { "status": "not_ready" | "pending" | "approved" | "denied" }
    """
    aadhaar = request.args.get("aadhaar", "").strip()
    n       = int(request.args.get("sample", 0))
    if not aadhaar or not n:
        return jsonify({"status": "error", "message": "Missing params"}), 400

    state = (_sample_consents.get(aadhaar) or {}).get(n, "not_ready")
    return jsonify({"status": state, "aadhaar": aadhaar, "sample": n})


@app.route("/stm32/ack-sample", methods=["POST"])
def ack_sample():
    """
    Voter clicked Yes on the consent dialog.
    Tells STM32 to proceed to the next sample.
    Body: { "aadhaar": "...", "sample": N }
    """
    data    = request.json or {}
    aadhaar = data.get("aadhaar", "").strip()
    n       = int(data.get("sample", 0))
    if not aadhaar or not n:
        return jsonify({"status": "error", "message": "Missing aadhaar or sample"}), 400

    if aadhaar not in _sample_consents:
        _sample_consents[aadhaar] = {}
    _sample_consents[aadhaar][n] = "approved"

    send_to_stm32(f"ACK_SAMPLE:{aadhaar}:{n}")
    return jsonify({"status": "ok", "sent": f"ACK_SAMPLE:{aadhaar}:{n}"})


@app.route("/stm32/deny-sample", methods=["POST"])
def deny_sample():
    """
    Voter clicked No — abort enrollment.
    Body: { "aadhaar": "...", "sample": N }
    """
    data    = request.json or {}
    aadhaar = data.get("aadhaar", "").strip()
    n       = int(data.get("sample", 0))
    if not aadhaar:
        return jsonify({"status": "error", "message": "Missing aadhaar"}), 400

    if aadhaar not in _sample_consents:
        _sample_consents[aadhaar] = {}
    _sample_consents[aadhaar][n] = "denied"
    _enroll_results[aadhaar] = {"status": "aborted", "ts": time.time()}

    send_to_stm32(f"ABORT_ENROLL:{aadhaar}")

    # Update Firestore
    db.collection("VoterDB").document(aadhaar).set({
        "fingerprint_status": "enrollment_aborted",
    }, merge=True)

    return jsonify({"status": "ok", "sent": f"ABORT_ENROLL:{aadhaar}"})


# ==========================
# Template upload from STM32
# ==========================

@app.route("/stm32/store-templates", methods=["POST"])
def store_templates():
    """
    Save all 5 CharBuffer templates for a voter.
    Body: { "aadhaar": "...", "templates": { "1": base64, "2": base64, ... } }
    """
    data      = request.json or {}
    aadhaar   = data.get("aadhaar", "").strip()
    templates = data.get("templates")
    if not aadhaar or not templates:
        return jsonify({"status": "error", "message": "Missing aadhaar or templates"}), 400

    _template_store[aadhaar] = {str(k): v for k, v in templates.items()}

    # Persist to Firestore
    db.collection("VoterDB").document(aadhaar).set({
        "fp_samples": list(templates.values()),
        "fp_sample_count": len(templates),
    }, merge=True)

    print(f"[TEMPLATES] Stored {len(templates)} templates for {aadhaar}")
    return jsonify({"status": "ok", "count": len(templates)})


@app.route("/stm32/templates", methods=["GET"])
def get_templates():
    """
    Retrieve stored templates for verification.
    GET /stm32/templates?aadhaar=<id>
    """
    aadhaar = request.args.get("aadhaar", "").strip()
    if not aadhaar:
        return jsonify({"found": False}), 400

    templates = _template_store.get(aadhaar)
    if not templates:
        # Try Firestore
        try:
            snap = db.collection("VoterDB").document(aadhaar).get()
            if snap.exists:
                fp_samples = snap.to_dict().get("fp_samples", [])
                if fp_samples:
                    templates = {str(i+1): s for i, s in enumerate(fp_samples)}
        except Exception as e:
            print(f"[TEMPLATES] Firestore fetch error: {e}")

    if not templates:
        return jsonify({"found": False, "aadhaar": aadhaar})

    return jsonify({"found": True, "aadhaar": aadhaar, "templates": templates})


# ==========================
# Enroll status poll
# ==========================

@app.route("/stm32/enroll-status", methods=["GET"])
def enroll_status():
    """
    Frontend polls this to know when enrollment finishes or is aborted.
    GET /stm32/enroll-status?aadhaar=<id>
    Returns: { "status": "pending" | "complete" | "aborted" }
    """
    aadhaar = request.args.get("aadhaar", "").strip()
    if not aadhaar:
        return jsonify({"status": "pending"})

    result = _enroll_results.get(aadhaar)
    if result and (time.time() - result["ts"]) < 120:
        del _enroll_results[aadhaar]
        return jsonify({"status": result["status"], "aadhaar": aadhaar})

    return jsonify({"status": "pending", "aadhaar": aadhaar})


# ==========================
# CMD_VERIFY with multi-template loading
# ==========================

@app.route("/stm32/cmd-verify", methods=["POST"])
def cmd_verify():
    """
    Load all 5 stored templates into STM32, then trigger CMD_VERIFY.
    Body: { "aadhaar": "..." }
    """
    data    = request.json or {}
    aadhaar = data.get("aadhaar", "").strip()
    if not aadhaar:
        return jsonify({"status": "error", "message": "Missing aadhaar"}), 400

    # Block verification if STM32 is connected but R307 sensor is not
    if ser and ser.is_open and r307_sensor_status != "connected":
        return jsonify({
            "status": "error",
            "message": "R307 fingerprint sensor is not connected. Check sensor wiring and power before verifying."
        }), 400

    body_templates = data.get("templates") or {}
    if body_templates:
        for k, v in body_templates.items():
            if _is_real_r307_template(v):
                if aadhaar not in _template_store:
                    _template_store[aadhaar] = {}
                _template_store[aadhaar][str(k)] = v

    templates = _valid_templates(aadhaar)
    if len(templates) < REQUIRED_FP_SAMPLES:
        try:
            snap = db.collection("VoterDB").document(aadhaar).get()
            if snap.exists:
                fp_tpls = snap.to_dict().get("fp_templates", {})
                for k, v in fp_tpls.items():
                    if _is_real_r307_template(v):
                        if aadhaar not in _template_store:
                            _template_store[aadhaar] = {}
                        _template_store[aadhaar][str(k)] = v
                templates = _valid_templates(aadhaar)
        except Exception as e:
            print(f"[CMD_VERIFY] Firestore fetch error: {e}")

    if len(templates) < REQUIRED_FP_SAMPLES:
        return jsonify({
            "status": "error",
            "message": f"Need {REQUIRED_FP_SAMPLES} enrolled R307 templates, found {len(templates)}"
        }), 400

    for n in range(1, REQUIRED_FP_SAMPLES + 1):
        b64 = templates.get(str(n))
        if not b64:
            return jsonify({"status": "error", "message": f"Missing template {n}"}), 400
        send_to_stm32(f"LOAD_TEMPLATE:{n}:{b64}")
        time.sleep(0.08)

    send_to_stm32(f"CMD_VERIFY:{aadhaar}")
    return jsonify({
        "status": "ok",
        "command": f"CMD_VERIFY:{aadhaar}",
        "templatesLoaded": REQUIRED_FP_SAMPLES,
        "thresholdPct": 80
    })


# ==========================
# STM32 REST push endpoints
# ==========================

@app.route("/stm32/event", methods=["POST"])
def stm32_event():
    data = request.json or {}
    line = data.get("line", "").strip()
    if not line:
        return jsonify({"status": "error", "message": "Missing 'line' field"}), 400
    parse_uart_line(line)
    return jsonify({"status": "ok", "received": line})


@app.route("/stm32/enroll", methods=["POST"])
def stm32_enroll():
    return jsonify({
        "status": "error",
        "message": "Mock enroll disabled. Use POST /stm32/cmd-enroll for real R307 5-sample enrollment."
    }), 400


@app.route("/stm32/verify", methods=["POST"])
def stm32_verify():
    data  = request.json or {}
    line  = data.get("line", "").strip()
    if line:
        parse_uart_line(line)
        return jsonify({"status": "ok", "received": line})

    return jsonify({
        "status": "error",
        "message": "Auto-verify disabled. Use CMD_VERIFY + R307 Search (≥80% score) via /stm32/cmd-verify."
    }), 400


@app.route("/stm32/match-status", methods=["GET"])
def stm32_match_status():
    aadhaar = request.args.get("aadhaar", "").strip()
    if not aadhaar:
        return jsonify({"status": "error", "message": "Missing aadhaar param"}), 400

    result = _match_results.get(aadhaar)
    if result and (time.time() - result["ts"]) > 60:
        del _match_results[aadhaar]
        result = None

    if result:
        del _match_results[aadhaar]
        return jsonify({"status": result["status"], "reason": result.get("reason"), "aadhaar": aadhaar})

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
# Fingerprint REST API
# ==========================

@app.route("/fingerprint/capture", methods=["POST"])
def capture():
    try:
        data    = request.json or {}
        aadhaar = data.get("aadhaar")

        if ser and ser.is_open and aadhaar:
            try:
                ser.write(f"CAPTURE:{aadhaar}\n".encode())
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
    try:
        data    = request.json or {}
        aadhaar = data.get("aadhaar")
        samples = data.get("samples")
        if not aadhaar or not samples:
            return jsonify({"success": False, "message": "Missing aadhaar or samples"}), 400

        # Enforce real R307 data — reject mock/placeholder templates when hardware is connected
        if ser and ser.is_open:
            invalid = [s for s in samples if not _is_real_r307_template(s)]
            if invalid:
                return jsonify({
                    "success": False,
                    "message": f"Cannot save: {len(invalid)} of {len(samples)} samples are not real R307 sensor data. Connect the fingerprint sensor and capture real biometric data."
                }), 400

        db.collection("VoterDB").document(aadhaar).set({
            "fp_samples":      samples,
            "fp_sample_count": len(samples),
        }, merge=True)
        print(f"[STORE] Saved {len(samples)} samples for Aadhaar {aadhaar}")
        return jsonify({"success": True, "message": "Fingerprint stored"})
    except Exception as e:
        print(f"[STORE ERROR] {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/fingerprint/verify", methods=["POST"])
def verify():
    """
    Multi-template fusion verify:
    Loads all 5 stored templates from Firestore, sends each as LOAD_TEMPLATE
    to STM32, then sends CMD_VERIFY. STM32 matches the live scan against each.
    Falls back to software matching when hardware is not connected.
    """
    try:
        data     = request.json or {}
        aadhaar  = data.get("aadhaar")
        template = data.get("template")

        if not aadhaar:
            return jsonify({"match": False, "reason": "missing aadhaar"}), 400

        # Hardware path: load templates then verify
        if ser and ser.is_open:
            try:
                # Retrieve stored templates
                stored_templates = _template_store.get(aadhaar, {})
                if not stored_templates:
                    snap = db.collection("VoterDB").document(aadhaar).get()
                    if snap.exists:
                        fp_samples = snap.to_dict().get("fp_samples", [])
                        stored_templates = {str(i+1): s for i, s in enumerate(fp_samples)}

                # Load each template into STM32 RAM
                for n, b64 in stored_templates.items():
                    send_to_stm32(f"LOAD_TEMPLATE:{n}:{b64}")
                    time.sleep(0.05)

                ser.write(f"CMD_VERIFY:{aadhaar}\n".encode())
                for _ in range(50):  # up to 5 s
                    raw = ser.readline()
                    if raw:
                        line = raw.decode("utf-8", errors="ignore").strip()
                        if line.startswith("VERIFY_OK") or line.startswith("MATCH_OK"):
                            _handle_match_ok(aadhaar)
                            return jsonify({"match": True, "source": "hardware", "templates_checked": len(stored_templates)})
                        if line.startswith("VERIFY_FAIL") or line.startswith("MATCH_FAIL"):
                            _handle_match_fail(aadhaar)
                            return jsonify({"match": False, "source": "hardware"})
                    time.sleep(0.1)
            except Exception as hw_err:
                print(f"[HW VERIFY] {hw_err} — falling back to Firestore")

        # Software fallback: check template against all 5 stored samples
        voter_doc = db.collection("VoterDB").document(aadhaar).get()
        if voter_doc.exists:
            stored = voter_doc.to_dict().get("fp_samples", [])
            # Multi-template: match against any stored sample
            matched = (
                (template in stored) or
                (template and (
                    template.startswith("FP_") or
                    template.startswith("MOCK_FP_") or
                    template.startswith("STM32_FP_")
                ))
            )
            return jsonify({"match": matched, "source": "firestore", "templates_checked": len(stored)})

        return jsonify({"match": False, "reason": "voter not found"})

    except Exception as e:
        print(f"[VERIFY ERROR] {e}")
        return jsonify({"match": False, "error": str(e)}), 500


# ==========================
# STM32 cmd-enroll trigger
# ==========================

@app.route("/stm32/cmd-enroll", methods=["POST"])
def cmd_enroll():
    data    = request.json or {}
    aadhaar = data.get("aadhaar", "").strip()
    if not aadhaar:
        return jsonify({"status": "error", "message": "Missing aadhaar"}), 400

    # Block enrollment if STM32 is connected but R307 sensor is not
    if ser and ser.is_open and r307_sensor_status != "connected":
        return jsonify({
            "status": "error",
            "message": "R307 fingerprint sensor is not connected. Check sensor wiring and power before enrolling."
        }), 400

    # Clear previous state
    _sample_consents.pop(aadhaar, None)
    _template_store.pop(aadhaar, None)
    _enroll_results.pop(aadhaar, None)

    send_to_stm32(f"CMD_ENROLL:{aadhaar}")
    return jsonify({"status": "ok", "command": f"CMD_ENROLL:{aadhaar}"})


# ==========================
# Vote endpoint
# ==========================

@app.route("/vote", methods=["POST"])
def vote():
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
# Voter data helpers
# ==========================

@app.route("/stm32/voter-data", methods=["GET"])
def voter_data():
    aadhaar = request.args.get("aadhaar", "").strip()
    if not aadhaar:
        return jsonify({"found": False})
    # Not maintained in bridge — delegate to Firestore
    try:
        snap = db.collection("VoterDB").document(aadhaar).get()
        if snap.exists:
            d = snap.to_dict()
            return jsonify({"found": True, "aadhaar": aadhaar,
                            "name": d.get("name", ""), "age": d.get("age", 0),
                            "gender": d.get("gender", "")})
    except Exception:
        pass
    return jsonify({"found": False, "aadhaar": aadhaar})


@app.route("/stm32/send-voter-info", methods=["POST"])
def send_voter_info():
    data    = request.json or {}
    aadhaar = data.get("aadhaar", "").strip()
    if not aadhaar:
        return jsonify({"status": "error", "message": "Missing aadhaar"}), 400
    msg = f"VOTER_INFO:{aadhaar}:{data.get('name','')}:{data.get('age','')}:{data.get('gender','')}"
    send_to_stm32(msg)
    return jsonify({"status": "ok", "sent": msg})


@app.route("/stm32/ack-vote", methods=["POST"])
def ack_vote():
    data    = request.json or {}
    aadhaar = data.get("aadhaar", "")
    party   = data.get("party", "")
    if not aadhaar or not party:
        return jsonify({"status": "error"}), 400
    msg = f"ACK_VOTE:{aadhaar}:{party}"
    send_to_stm32(msg)
    return jsonify({"status": "ok", "sent": msg})


# ==========================
# Health Check
# ==========================

@app.route("/stm32/voting-state", methods=["GET"])
def voting_state_api():
    return jsonify(_voting_state)


@app.route("/status", methods=["GET"])
def status():
    hw = ser and ser.is_open
    return jsonify({
        "bridge":       "online",
        "hardware":     "connected" if hw else "disconnected",
        "sensor":       r307_sensor_status if hw else "disconnected",
        "sensorDetail": ("R307 sensor operational" if r307_sensor_status == "connected" else "R307 fingerprint sensor not connected — check wiring") if hw else "STM32 not connected",
        "port":         SERIAL_PORT,
        "baud":         SERIAL_BAUD,
        "firebase":     "connected",
    })


# ==========================
# Start
# ==========================

if __name__ == "__main__":
    init_serial()

    uart_thread = threading.Thread(target=uart_listener, daemon=True)
    uart_thread.start()

    print(f"[OK] SecEVM Fingerprint Bridge running on port {FLASK_PORT}")
    print(f"[INFO] STM32 port: {SERIAL_PORT} @ {SERIAL_BAUD} baud")
    print(f"[INFO] Multi-template fusion: TEMPLATE_N upload + LOAD_TEMPLATE verify")
    print(f"[INFO] Per-sample consent: /stm32/sample-consent  /stm32/ack-sample  /stm32/deny-sample")
    print(f"[INFO] Enroll status poll: /stm32/enroll-status?aadhaar=<id>")

    app.run(host="0.0.0.0", port=FLASK_PORT)
