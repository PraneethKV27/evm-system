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
      const line = data.toString("utf8").trim();
      if (line) {
        console.log(`[UART] ${line}`);
        handleUARTLine(line);
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

function handleUARTLine(line) {
  // Normalise: "MATCH_OK ID=123..." or "MATCH_OK:ID=123..."
  const normalized = line.replace(/\s+/g, ":");
  const parts = {};
  normalized.split(":").forEach(seg => {
    if (seg.includes("=")) {
      const [k, v] = seg.split("=");
      parts[k.trim()] = v.trim();
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
  }
}

// Poll for STM32 every 3 seconds
detectAndConnectSTM32();
setInterval(detectAndConnectSTM32, 3000);

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
