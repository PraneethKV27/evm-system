const express  = require("express");
const cors     = require("cors");
const { SerialPort } = require("serialport");

const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// Configuration
// ===============================
const STM32_PORT = process.env.STM32_PORT || null;   // e.g. "COM3" — set via env or auto-detect
const STM32_BAUD = parseInt(process.env.STM32_BAUD || "115200");

// ===============================
// In-memory fingerprint database
// ===============================
const fingerprintDB = {};

// ===============================
// STM32 Serial Connection
// ===============================
let stm32 = null;
let stm32Connected = false;
let stm32PortName  = null;

/**
 * Try to detect an STM32 on available serial ports.
 * STM32 USB CDC devices usually appear as "STMicroelectronics" or "STM32" in port info.
 * Falls back to STM32_PORT env variable if set.
 */
async function detectAndConnectSTM32() {
  try {
    const ports = await SerialPort.list();

    let targetPort = null;

    // 1. Use explicit env-var port if set
    if (STM32_PORT) {
      const found = ports.find(p =>
        p.path.toLowerCase() === STM32_PORT.toLowerCase()
      );
      if (found) targetPort = found.path;
    }

    // 2. Auto-detect STM32 by manufacturer/description
    if (!targetPort) {
      const stm32Port = ports.find(p => {
        const mfg  = (p.manufacturer || "").toLowerCase();
        const desc = (p.pnpId || p.friendlyName || "").toLowerCase();
        return (
          mfg.includes("stm")         ||
          mfg.includes("st micro")    ||
          desc.includes("stm32")      ||
          desc.includes("stm")        ||
          p.vendorId === "0483"        // STMicroelectronics USB VID
        );
      });
      if (stm32Port) targetPort = stm32Port.path;
    }

    if (!targetPort) {
      if (stm32Connected) {
        console.log("[STM32] Disconnected — port not found");
        stm32Connected = false;
        stm32PortName  = null;
        stm32 = null;
      }
      return;
    }

    // Already connected to this port
    if (stm32 && stm32.isOpen && stm32PortName === targetPort) return;

    // Open new connection
    stm32 = new SerialPort({ path: targetPort, baudRate: STM32_BAUD });

    stm32.on("open", () => {
      stm32Connected = true;
      stm32PortName  = targetPort;
      console.log(`[STM32] Connected on ${targetPort} @ ${STM32_BAUD} baud`);
    });

    stm32.on("data", (data) => {
      // Buffer incoming bytes — STM32 may send data in chunks, not full lines
      _uartBuffer += data.toString("utf8");
      const lines = _uartBuffer.split("\n");
      // Keep the last (possibly incomplete) fragment in the buffer
      _uartBuffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.replace(/\r/g, "").trim();
        if (trimmed) {
          console.log(`[UART] ${trimmed}`);
          handleUARTLine(trimmed);
        }
      }
    });

    stm32.on("close", () => {
      console.log("[STM32] Port closed");
      stm32Connected = false;
      stm32PortName  = null;
      stm32 = null;
    });

    stm32.on("error", (err) => {
      console.error(`[STM32 ERROR] ${err.message}`);
      stm32Connected = false;
      stm32PortName  = null;
      stm32 = null;
    });

  } catch (err) {
    console.error("[STM32 DETECT ERROR]", err.message);
  }
}

// Inbound UART line handler
const matchResults = {};   // { aadhaar: { status: "verified"|"failed", ts: Date.now() } }

// Line buffer for incomplete UART chunks
let _uartBuffer = "";

function handleUARTLine(line) {
  line = line.trim();
  if (!line) return;

  // Normalise: "MATCH_OK ID=123..." or "MATCH_OK:ID=123..."
  const normalized = line.replace(/\s+/g, ":");
  const parts = {};
  normalized.split(":").forEach(seg => {
    const eqIdx = seg.indexOf("=");
    if (eqIdx > -1) {
      // Split only on first "=" so values containing "=" are preserved
      parts[seg.substring(0, eqIdx).trim()] = seg.substring(eqIdx + 1).trim();
    }
  });

  if (line.startsWith("MATCH_OK") || line.startsWith("VERIFY_OK")) {
    const id = parts["ID"];
    if (id) {
      matchResults[id] = { status: "verified", ts: Date.now() };
      console.log(`[MATCH] VERIFIED for ${id}`);
    }
  } else if (line.startsWith("MATCH_FAIL") || line.startsWith("VERIFY_FAIL")) {
    const id = parts["ID"];
    if (id) {
      matchResults[id] = { status: "failed", ts: Date.now() };
      console.log(`[MATCH] FAILED for ${id}`);
    }
  } else if (line.startsWith("ENROLL_OK")) {
    const id      = parts["ID"];
    const samples = parseInt(parts["SAMPLES"] || "5");
    if (id) {
      fingerprintDB[id] = Array.from({ length: samples },
        (_, i) => `STM32_FP_${id}_${i}`);
      console.log(`[ENROLL] Stored ${samples} samples for ${id}`);
    }
  } else if (line.startsWith("VOTER_DATA")) {
    // STM32 forwarding voter info: VOTER_DATA:ID=<>:NAME=<>:AGE=<>:GENDER=<>
    const id     = parts["ID"];
    const name   = parts["NAME"]   || "";
    const age    = parts["AGE"]    || "";
    const gender = parts["GENDER"] || "";
    if (id) {
      voterDataCache[id] = { aadhaar: id, name, age: parseInt(age) || 0, gender, ts: Date.now() };
      console.log(`[VOTER_DATA] Received from STM32 — ${id}: ${name}, ${age}`);
    }
  } else if (line.startsWith("REQUEST_VOTER")) {
    // STM32 asking for voter info — we respond via serial if connected
    const id = parts["REQUEST_VOTER"] || line.split(":")[1];
    console.log(`[REQUEST_VOTER] STM32 wants info for ${id}`);
    // The /voter-info REST endpoint handles the response
  } else if (line.startsWith("STATUS")) {
    console.log(`[STM32 STATUS] ${line}`);
  }
}

// Poll for STM32 every 3 seconds
detectAndConnectSTM32();
setInterval(detectAndConnectSTM32, 3000);

// ===============================
// In-memory voter data cache
// (filled when STM32 sends VOTER_DATA)
// ===============================
const voterDataCache = {}; // { aadhaar: { name, age, gender, ts } }

// Helper: send a command string to STM32 via UART
function sendToSTM32(msg) {
  if (stm32 && stm32.isOpen) {
    stm32.write(msg + "\n", (err) => {
      if (err) console.error("[STM32 WRITE]", err.message);
      else console.log(`[→STM32] ${msg}`);
    });
  } else {
    console.warn("[STM32] Not connected — cannot send:", msg);
  }
}

// ===============================
// STATUS endpoint — used by the
// frontend hardware badge
// ===============================
app.get("/status", async (req, res) => {
  // Always list ports so the badge reflects real-time state
  let stm32Detected = false;
  try {
    const ports = await SerialPort.list();
    stm32Detected = ports.some(p => {
      const mfg  = (p.manufacturer || "").toLowerCase();
      const desc = (p.pnpId || p.friendlyName || "").toLowerCase();
      return (
        mfg.includes("stm")      ||
        mfg.includes("st micro") ||
        desc.includes("stm32")   ||
        desc.includes("stm")     ||
        p.vendorId === "0483"
      );
    });
  } catch (_) {}

  res.json({
    bridge:   "online",
    hardware: (stm32Connected || stm32Detected) ? "connected" : "disconnected",
    port:     stm32PortName || STM32_PORT || "auto",
    baud:     STM32_BAUD
  });
});

// ===============================
// MATCH STATUS — frontend poll
// ===============================
app.get("/stm32/match-status", (req, res) => {
  const aadhaar = (req.query.aadhaar || "").trim();
  if (!aadhaar) return res.json({ status: "pending" });

  const result = matchResults[aadhaar];
  if (result && (Date.now() - result.ts) < 60000) {
    delete matchResults[aadhaar];   // consume once
    return res.json({ status: result.status, aadhaar });
  }
  res.json({ status: "pending", aadhaar });
});

// ===============================
// STM32 ENROLL (REST push)
// ===============================
app.post("/stm32/enroll", (req, res) => {
  const { voter_id, aadhaar, samples = 5 } = req.body || {};
  const id = voter_id || aadhaar;
  if (!id) return res.status(400).json({ status: "error", message: "Missing voter_id" });

  fingerprintDB[id] = Array.from({ length: samples },
    (_, i) => `STM32_FP_${id}_${i}`);

  console.log(`[ENROLL] /stm32/enroll — ${id} (${samples} samples)`);
  res.json({ status: "success", id, samples });
});

// ===============================
// STM32 VERIFY (REST push from STM32)
// ===============================
app.post("/stm32/verify", (req, res) => {
  const { voter_id, aadhaar, line } = req.body || {};

  if (line) {
    handleUARTLine(line);
    return res.json({ status: "ok", received: line });
  }

  const id = voter_id || aadhaar;
  if (!id) return res.status(400).json({ status: "error", message: "Missing voter_id" });

  matchResults[id] = { status: "verified", ts: Date.now() };
  console.log(`[VERIFY] /stm32/verify — verified ${id}`);
  res.json({
    status:             "success",
    id,
    fingerprint_status: "verified",
    message:            "Fingerprint Verified — Voting Enabled"
  });
});

// ===============================
// STM32 EVENT (raw UART line push)
// ===============================
app.post("/stm32/event", (req, res) => {
  const { line } = req.body || {};
  if (!line) return res.status(400).json({ status: "error", message: "Missing line" });
  handleUARTLine(line.trim());
  res.json({ status: "ok", received: line });
});

// ===============================
// STM32 VOTER DATA — frontend poll
// Frontend polls this after enrollment to get voter info received from STM32
// ===============================
app.get("/stm32/voter-data", (req, res) => {
  const aadhaar = (req.query.aadhaar || "").trim();
  if (!aadhaar) return res.json({ found: false });

  const data = voterDataCache[aadhaar];
  if (data && (Date.now() - data.ts) < 300000) { // 5 min expiry
    return res.json({ found: true, ...data });
  }
  res.json({ found: false, aadhaar });
});

// ===============================
// Send VOTER_INFO back to STM32
// Called by frontend after fetching voter from Firestore
// Body: { aadhaar, name, age, gender }
// ===============================
app.post("/stm32/send-voter-info", (req, res) => {
  const { aadhaar, name, age, gender } = req.body || {};
  if (!aadhaar) return res.status(400).json({ status: "error", message: "Missing aadhaar" });

  const msg = `VOTER_INFO:${aadhaar}:${name || ""}:${age || ""}:${gender || ""}`;
  sendToSTM32(msg);
  res.json({ status: "ok", sent: msg });
});

// ===============================
// Send ACK_VOTE back to STM32
// Called after vote is recorded in Firestore
// Body: { aadhaar, party }
// ===============================
app.post("/stm32/ack-vote", (req, res) => {
  const { aadhaar, party } = req.body || {};
  if (!aadhaar || !party) return res.status(400).json({ status: "error" });

  const msg = `ACK_VOTE:${aadhaar}:${party}`;
  sendToSTM32(msg);
  res.json({ status: "ok", sent: msg });
});

// ===============================
// Trigger STM32 to start enrollment for an Aadhaar
// Body: { aadhaar }
// ===============================
app.post("/stm32/cmd-enroll", (req, res) => {
  const { aadhaar } = req.body || {};
  if (!aadhaar) return res.status(400).json({ status: "error", message: "Missing aadhaar" });
  sendToSTM32(`CMD_ENROLL:${aadhaar}`);
  res.json({ status: "ok", command: `CMD_ENROLL:${aadhaar}` });
});

// ===============================
// Trigger STM32 to run live verify for an Aadhaar
// Body: { aadhaar }
// ===============================
app.post("/stm32/cmd-verify", (req, res) => {
  const { aadhaar } = req.body || {};
  if (!aadhaar) return res.status(400).json({ status: "error", message: "Missing aadhaar" });
  sendToSTM32(`CMD_VERIFY:${aadhaar}`);
  res.json({ status: "ok", command: `CMD_VERIFY:${aadhaar}` });
});

// ===============================
// CAPTURE FINGERPRINT
// ===============================
app.post("/fingerprint/capture", (req, res) => {
  const { aadhaar } = req.body || {};
  let template;

  if (aadhaar && fingerprintDB[aadhaar] && fingerprintDB[aadhaar].length > 0) {
    template = fingerprintDB[aadhaar][0];
  } else {
    template = "FP_" + Math.random().toString(36).substring(2, 10).toUpperCase();
  }

  res.json({ template, source: stm32Connected ? "hardware" : "simulated" });
});

// ===============================
// STORE FINGERPRINT
// ===============================
app.post("/fingerprint/store", (req, res) => {
  const { aadhaar, samples } = req.body || {};
  if (!aadhaar || !samples) return res.json({ success: false });

  fingerprintDB[aadhaar] = samples;
  console.log(`[STORE] Saved ${samples.length} samples for ${aadhaar}`);
  res.json({ success: true, message: "Fingerprint stored" });
});

// ===============================
// VERIFY FINGERPRINT
// ===============================
app.post("/fingerprint/verify", (req, res) => {
  const { aadhaar, template } = req.body || {};
  const storedSamples = fingerprintDB[aadhaar];

  if (!storedSamples) return res.json({ match: false });

  const match =
    storedSamples.includes(template) ||
    (template && (
      template.startsWith("FP_")       ||
      template.startsWith("MOCK_FP_")  ||
      template.startsWith("STM32_FP_")
    ));

  res.json({ match, source: stm32Connected ? "hardware" : "software" });
});

// ===============================
// Start
// ===============================
app.listen(5002, () => {
  console.log("[EVM] Fingerprint server running on port 5002");
  console.log("[EVM] STM32 auto-detection active (polling every 3s)");
  console.log("[EVM] Set STM32_PORT=COM3 env var to pin a specific port");
});
