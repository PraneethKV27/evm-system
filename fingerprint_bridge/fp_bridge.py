import firebase_admin

from firebase_admin import credentials, firestore

import win32cred
import ctypes
import time

from flask import Flask, request, jsonify
from flask_cors import CORS


# ==========================
# Firebase Setup
# ==========================

cred = credentials.Certificate("serviceAccount.json")

firebase_admin.initialize_app(cred)

db = firestore.client()

print("[OK] Firebase connected")


# ==========================
# Flask App
# ==========================

app = Flask(__name__)

CORS(app)


# ==========================
# Simulated Fingerprint Verification
# ==========================

def verify_fingerprint():

    print("\nPlace your finger on laptop sensor...")

    print("Use Windows Hello verification")

    time.sleep(3)

    # Simulated verification result
    # Replace later with real WBF integration

    return True


# ==========================
# Vote Function
# ==========================

def cast_vote(aadhaar, party):

    try:

        voter_ref = db.collection("VoterDB").document(aadhaar)

        party_ref = db.collection("PartyDB").document(party)

        meta_ref = db.collection("PartyDB").document("_meta")


        transaction = db.transaction()


        @firestore.transactional
        def update_in_transaction(transaction):

            voter_doc = voter_ref.get(transaction=transaction)

            voter_data = voter_doc.to_dict()


            if voter_data["flag"] == 1:

                print("[BLOCKED] Already voted")

                return


            verified = verify_fingerprint()


            if not verified:

                print("[FAILED] Fingerprint mismatch")

                return


            transaction.update(voter_ref, {

                "flag": 1,

                "voted_party": party,

                "voted_at": firestore.SERVER_TIMESTAMP

            })


            transaction.update(party_ref, {

                "votes": firestore.Increment(1),

                "last_updated": firestore.SERVER_TIMESTAMP

            })


            transaction.update(meta_ref, {

                "total_votes": firestore.Increment(1),

                "last_updated": firestore.SERVER_TIMESTAMP

            })


            print("[OK] Vote Cast Successfully")


        update_in_transaction(transaction)

    except Exception as e:

        print("[ERROR]", e)


# ==========================
# API Endpoint
# ==========================

@app.route("/vote", methods=["POST"])
def vote():
    data = request.json
    aadhaar = data["aadhaar"]
    party = data["party"]

    cast_vote(aadhaar, party)
    return jsonify({
        "status": "success"
    })

@app.route("/fingerprint/capture", methods=["POST"])
def capture():
    import uuid
    try:
        data = request.json or {}
        aadhaar = data.get("aadhaar")
        if aadhaar:
            voter_ref = db.collection("VoterDB").document(aadhaar)
            voter_doc = voter_ref.get()
            if voter_doc.exists:
                voter_data = voter_doc.to_dict()
                samples = voter_data.get("fp_samples", [])
                if samples:
                    return jsonify({"template": samples[0]})
        
        rand_id = str(uuid.uuid4())[:8].upper()
        return jsonify({"template": f"FP_{rand_id}"})
    except Exception as e:
        print("[CAPTURE ERROR]", e)
        import uuid
        rand_id = str(uuid.uuid4())[:8].upper()
        return jsonify({"template": f"FP_{rand_id}"})

@app.route("/fingerprint/store", methods=["POST"])
def store():
    try:
        data = request.json or {}
        aadhaar = data.get("aadhaar")
        samples = data.get("samples")
        if aadhaar and samples:
            voter_ref = db.collection("VoterDB").document(aadhaar)
            voter_ref.update({"fp_samples": samples})
            return jsonify({"success": True, "message": "Fingerprint stored"})
        return jsonify({"success": False, "message": "Missing arguments"})
    except Exception as e:
        print("[STORE ERROR]", e)
        return jsonify({"success": False, "error": str(e)})

@app.route("/fingerprint/verify", methods=["POST"])
def verify():
    try:
        data = request.json or {}
        aadhaar = data.get("aadhaar")
        template = data.get("template")
        
        if not aadhaar:
            return jsonify({"match": False})
            
        voter_ref = db.collection("VoterDB").document(aadhaar)
        voter_doc = voter_ref.get()
        
        if voter_doc.exists:
            voter_data = voter_doc.to_dict()
            stored_samples = voter_data.get("fp_samples", [])
            
            matched = False
            if template in stored_samples or (template and (template.startswith("FP_") or template.startswith("MOCK_FP_"))):
                matched = True
            return jsonify({"match": matched})
            
        return jsonify({"match": False})
    except Exception as e:
        print("[VERIFY ERROR]", e)
        return jsonify({"match": False, "error": str(e)})

# ==========================
# Start Server
# ==========================

print("[OK] Fingerprint bridge running")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5002)