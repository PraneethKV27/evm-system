const express  = require("express");
const cors     = require("cors");
const { SerialPort } = require("serialport");
const fs       = require("fs");
const path     = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// Configuration
// ===============================
const STM32_PORT = process.env.STM32_PORT || null;
const STM32_BAUD = parseInt(process.env.STM32_BAUD || "115200");

// ===============================
// In-memory fingerprint database & state stores
// ===============================
const fingerprintDB = {};
const templateStore = {};
const matchResults   = {};  // { aadhaar: { status, ts } }
const enrollResults  = {};  // { aadhaar: { status:"complete"|"aborted", ts } }
const sampleConsents = {};  // { aadhaar: { n: "pending"|"approved"|"denied" } }
let votingState = { active: false, aadhaar: "", selected_party: "", voted: false, voted_party: "" };
const templateLoadResolvers = {};

const DB_FILE = path.join(__dirname, "fingerprint_db.json");
const TEMPLATE_FILE = path.join(__dirname, "template_store.json");

function loadLocalDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, "utf8").trim();
      if (content) {
        const data = JSON.parse(content);
        Object.assign(fingerprintDB, data);
        console.log(`[DB] Loaded ${Object.keys(fingerprintDB).length} fingerprints from local file.`);
      }
    }
    if (fs.existsSync(TEMPLATE_FILE)) {
      const content = fs.readFileSync(TEMPLATE_FILE, "utf8").trim();
      if (content) {
        const data = JSON.parse(content);
        Object.assign(templateStore, data);
        console.log(`[DB] Loaded ${Object.keys(templateStore).length} template sets from local file.`);
      }
    }
  } catch (err) {
    console.error("[DB ERROR] Failed to load local database files:", err.message);
  }
}

function saveLocalDatabase() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(fingerprintDB, null, 2), "utf8");
    fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(templateStore, null, 2), "utf8");
    console.log("[DB] Saved fingerprint database and template store locally.");
  } catch (err) {
    console.error("[DB ERROR] Failed to write database files:", err.message);
  }
}

// Load database immediately on startup
loadLocalDatabase();

// ===============================
// STM32 Serial Connection
// ===============================
let stm32 = null;
let stm32Connected = false;
let stm32PortName  = null;
let r307SensorStatus = "unknown";

async function detectAndConnectSTM32() {
  try {
    const ports = await SerialPort.list();
    let targetPort = null;

    if (STM32_PORT) {
      const found = ports.find(p =>
        p.path.toLowerCase() === STM32_PORT.toLowerCase()
      );
      if (found) targetPort = found.path;
    }

    if (!targetPort) {
      const stm32Port = ports.find(p => {
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

    if (stm32 && stm32.isOpen && stm32PortName === targetPort) return;

    stm32 = new SerialPort({ path: targetPort, baudRate: STM32_BAUD });

    stm32.on("open", () => {
      stm32Connected = true;
      stm32PortName  = targetPort;
      console.log(`[STM32] Connected on ${targetPort} @ ${STM32_BAUD} baud`);
    });

    stm32.on("data", (data) => {
      _uartBuffer += data.toString("utf8");
      const lines = _uartBuffer.split("\n");
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
      r307SensorStatus = "disconnected";
    });

    stm32.on("error", (err) => {
      console.error(`[STM32 ERROR] ${err.message}`);
      stm32Connected = false;
      stm32PortName  = null;
      stm32 = null;
      r307SensorStatus = "disconnected";
    });

  } catch (err) {
    console.error("[STM32 DETECT ERROR]", err.message);
  }
}

// State stores defined at top of file

let _uartBuffer = "";
const voterDataCache = {};

const REQUIRED_FP_SAMPLES = 5;

function isRealR307Template(tmpl) {
  if (!tmpl || typeof tmpl !== "string") return false;
  if (/^(MOCK_FP_|STM32_FP_|FP_|PLACEHOLDER_)/.test(tmpl)) return false;
  return tmpl.length >= 64 && /^[A-Za-z0-9+/=]+$/.test(tmpl);
}

function getValidTemplates(aadhaar) {
  const stored = templateStore[aadhaar] || {};
  const valid = {};
  Object.entries(stored).forEach(([k, v]) => {
    if (isRealR307Template(v)) valid[k] = v;
  });
  return valid;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function handleUARTLine(line) {
  line = line.trim();
  if (!line) return;

  const normalized = line.replace(/\s+/g, ":");
  const parts = {};
  normalized.split(":").forEach(seg => {
    const eqIdx = seg.indexOf("=");
    if (eqIdx > -1) {
      parts[seg.substring(0, eqIdx).trim()] = seg.substring(eqIdx + 1).trim();
    }
  });

  // ── SAMPLE_READY:ID=<aadhaar>:SAMPLE=<n>  ──────────────────────────
  // STM32 captured a sample and wants consent before proceeding
  if (line.startsWith("SAMPLE_READY")) {
    const id = parts["ID"];
    const n  = parseInt(parts["SAMPLE"] || "0");
    if (id && n) {
      if (!sampleConsents[id]) sampleConsents[id] = {};
      sampleConsents[id][n] = "pending";
      console.log(`[CONSENT] Sample ${n} ready for ${id} — awaiting voter consent`);
    }
    return;
  }

  // ── TEMPLATE_N:ID=<aadhaar>:DATA=<base64>  ─────────────────────────
  // STM32 uploading CharBuffer template for sample N
  if (line.startsWith("TEMPLATE_")) {
    const nMatch = line.match(/^TEMPLATE_(\d+):/);
    if (nMatch) {
      const n  = parseInt(nMatch[1]);
      const id = parts["ID"];
      const b64data = parts["DATA"] || line.split("DATA=")[1] || "";
      if (id && b64data) {
        if (!isRealR307Template(b64data)) {
          console.warn(`[TEMPLATE] Rejected invalid template ${n} for ${id}`);
          return;
        }
        if (!templateStore[id]) templateStore[id] = {};
        templateStore[id][n] = b64data;
        console.log(`[TEMPLATE] Stored R307 template ${n} for ${id} (${b64data.length} chars)`);
        saveLocalDatabase();
      }
    }
    return;
  }

  // ── ENROLL_OK:ID=<aadhaar>:SAMPLES=5  ─────────────────────────────
  if (line.startsWith("ENROLL_OK")) {
    const id      = parts["ID"];
    const samples = parseInt(parts["SAMPLES"] || "5");
    if (id) {
      const valid = getValidTemplates(id);
      if (Object.keys(valid).length > 0) {
        fingerprintDB[id] = Object.values(valid);
      }
      enrollResults[id] = { status: "complete", ts: Date.now() };
      console.log(`[ENROLL] Complete for ${id} (${Object.keys(valid).length || samples} R307 templates)`);
      saveLocalDatabase();
    }
    return;
  }

  // ── MATCH_OK / VERIFY_OK  ──────────────────────────────────────────
  if (line.startsWith("MATCH_OK") || line.startsWith("VERIFY_OK")) {
    const id = parts["ID"];
    if (id) {
      matchResults[id] = { status: "verified", ts: Date.now() };
      votingState = { active: true, aadhaar: id, selected_party: "", voted: false, voted_party: "" };
      console.log(`[MATCH] VERIFIED for ${id}`);
    }
    return;
  }

  // ── MATCH_FAIL / VERIFY_FAIL  ─────────────────────────────────────
  if (line.startsWith("MATCH_FAIL") || line.startsWith("VERIFY_FAIL")) {
    const id     = parts["ID"];
    const reason = parts["REASON"] || "MISMATCH";
    if (id) {
      matchResults[id] = { status: "failed", reason, ts: Date.now() };
      console.log(`[MATCH] FAILED for ${id} — reason: ${reason}`);
    }
    return;
  }

  // ── VOTE_CAST  ────────────────────────────────────────────────────
  if (line.startsWith("VOTE_CAST")) {
    const id = parts["ID"];
    const party = parts["PARTY"];
    if (id && party) {
      votingState.voted = true;
      votingState.voted_party = party;
      votingState.active = false;
      console.log(`[VOTE] Vote received from STM32: ${id} -> ${party}`);
    }
    return;
  }

  // ── VOTER_DATA  ───────────────────────────────────────────────────
  if (line.startsWith("VOTER_DATA")) {
    const id     = parts["ID"];
    const name   = parts["NAME"]   || "";
    const age    = parts["AGE"]    || "";
    const gender = parts["GENDER"] || "";
    if (id) {
      voterDataCache[id] = { aadhaar: id, name, age: parseInt(age) || 0, gender, ts: Date.now() };
      console.log(`[VOTER_DATA] ${id}: ${name}, ${age}`);
    }
    return;
  }

  if (line.includes("Loaded template")) {
    const match = line.match(/Loaded template (\d+)/i);
    if (match) {
      const page = parseInt(match[1]);
      if (templateLoadResolvers[page]) {
        console.log(`[HANDSHAKE] Resolved template load for page ${page}`);
        templateLoadResolvers[page]();
      }
    }
  }

  if (line.startsWith("STATUS")) {
    console.log(`[STM32 STATUS] ${line}`);
    if (line.startsWith("STATUS:SENSOR_CONNECTED")) {
      r307SensorStatus = "connected";
    } else if (line.startsWith("STATUS:SENSOR_DISCONNECTED")) {
      r307SensorStatus = "disconnected";
    } else if (line.includes("VOTING_MODE_ACTIVE")) {
      votingState.active = true;
    }
  }
}

detectAndConnectSTM32();
setInterval(detectAndConnectSTM32, 3000);

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
// STATUS
// ===============================
app.get("/status", async (req, res) => {
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
    sensor:   (stm32Connected || stm32Detected) ? r307SensorStatus : "disconnected",
    sensorDetail: (stm32Connected || stm32Detected)
      ? (r307SensorStatus === "connected" ? "R307 sensor operational" : "R307 fingerprint sensor not connected — check wiring")
      : "STM32 not connected",
    port:     stm32PortName || STM32_PORT || "auto",
    baud:     STM32_BAUD
  });
});

// ===============================
// MATCH STATUS
// ===============================
app.get("/stm32/match-status", (req, res) => {
  const aadhaar = (req.query.aadhaar || "").trim();
  if (!aadhaar) return res.json({ status: "pending" });

  const result = matchResults[aadhaar];
  if (result && (Date.now() - result.ts) < 60000) {
    delete matchResults[aadhaar];
    return res.json({ status: result.status, reason: result.reason || null, aadhaar });
  }
  res.json({ status: "pending", aadhaar });
});

// ===============================
// ENROLL STATUS — frontend polls after CMD_ENROLL
// Returns "complete" | "aborted" | "pending"
// ===============================
app.get("/stm32/enroll-status", (req, res) => {
  const aadhaar = (req.query.aadhaar || "").trim();
  if (!aadhaar) return res.json({ status: "pending" });

  const result = enrollResults[aadhaar];
  if (result && (Date.now() - result.ts) < 120000) {
    delete enrollResults[aadhaar];
    return res.json({ status: result.status, aadhaar });
  }
  res.json({ status: "pending", aadhaar });
});

// ===============================
// SAMPLE CONSENT STATUS — frontend polls for each sample
// GET /stm32/sample-consent?aadhaar=<id>&sample=<n>
// Returns "pending" | "approved" | "denied"
// ===============================
app.get("/stm32/sample-consent", (req, res) => {
  const aadhaar = (req.query.aadhaar || "").trim();
  const n = parseInt(req.query.sample || "0");
  if (!aadhaar || !n) return res.json({ status: "pending" });

  const state = (sampleConsents[aadhaar] || {})[n] || "not_ready";
  res.json({ status: state, aadhaar, sample: n });
});

// ===============================
// ACK SAMPLE — voter approved a sample
// POST /stm32/ack-sample  body: { aadhaar, sample }
// ===============================
app.post("/stm32/ack-sample", (req, res) => {
  const { aadhaar, sample } = req.body || {};
  if (!aadhaar || !sample) return res.status(400).json({ status: "error", message: "Missing aadhaar or sample" });

  // Record approved
  if (!sampleConsents[aadhaar]) sampleConsents[aadhaar] = {};
  sampleConsents[aadhaar][sample] = "approved";

  // Tell STM32 to proceed to next sample
  sendToSTM32(`ACK_SAMPLE:${aadhaar}:${sample}`);
  console.log(`[CONSENT] Sample ${sample} approved for ${aadhaar}`);
  res.json({ status: "ok", sent: `ACK_SAMPLE:${aadhaar}:${sample}` });
});

// ===============================
// DENY SAMPLE — voter denied a sample → abort enrollment
// POST /stm32/deny-sample  body: { aadhaar, sample }
// ===============================
app.post("/stm32/deny-sample", (req, res) => {
  const { aadhaar, sample } = req.body || {};
  if (!aadhaar) return res.status(400).json({ status: "error", message: "Missing aadhaar" });

  if (!sampleConsents[aadhaar]) sampleConsents[aadhaar] = {};
  sampleConsents[aadhaar][sample] = "denied";
  enrollResults[aadhaar] = { status: "aborted", ts: Date.now() };

  // Tell STM32 to abort enrollment
  sendToSTM32(`ABORT_ENROLL:${aadhaar}`);
  console.log(`[CONSENT] Sample ${sample} denied for ${aadhaar} — enrollment aborted`);
  res.json({ status: "ok", sent: `ABORT_ENROLL:${aadhaar}` });
});

// ===============================
// STORE TEMPLATES — backend saves all 5 CharBuffer templates from STM32
// POST /stm32/store-templates  body: { aadhaar, templates: { "1": base64, ... } }
// ===============================
app.post("/stm32/store-templates", (req, res) => {
  const { aadhaar, templates } = req.body || {};
  if (!aadhaar || !templates) return res.status(400).json({ status: "error", message: "Missing aadhaar or templates" });

  const valid = {};
  Object.entries(templates).forEach(([k, v]) => {
    if (isRealR307Template(v)) valid[k] = v;
  });
  if (Object.keys(valid).length < REQUIRED_FP_SAMPLES) {
    return res.status(400).json({
      status:  "error",
      message: `Need ${REQUIRED_FP_SAMPLES} real R307 templates, got ${Object.keys(valid).length}`
    });
  }

  templateStore[aadhaar] = valid;
  fingerprintDB[aadhaar] = Object.values(valid);
  console.log(`[TEMPLATES] Stored ${Object.keys(valid).length} R307 templates for ${aadhaar}`);
  saveLocalDatabase();
  res.json({ status: "ok", count: Object.keys(valid).length });
});

// ===============================
// GET TEMPLATES — retrieve stored templates for a voter
// GET /stm32/templates?aadhaar=<id>
// ===============================
app.get("/stm32/templates", (req, res) => {
  const aadhaar = (req.query.aadhaar || "").trim();
  if (!aadhaar) return res.status(400).json({ status: "error", message: "Missing aadhaar" });

  const templates = templateStore[aadhaar];
  if (!templates) return res.json({ found: false, aadhaar });
  res.json({ found: true, aadhaar, templates });
});

// ===============================
// ENROLL (REST push from STM32 or admin)
// ===============================
app.post("/stm32/enroll", (req, res) => {
  const { voter_id, aadhaar } = req.body || {};
  const id = voter_id || aadhaar;
  if (!id) return res.status(400).json({ status: "error", message: "Missing voter_id" });

  return res.status(400).json({
    status:  "error",
    message: "Mock enroll disabled. Use POST /stm32/cmd-enroll for real R307 5-sample enrollment."
  });
});

// ===============================
// VERIFY (REST push)
// ===============================
app.post("/stm32/verify", (req, res) => {
  const { voter_id, aadhaar, line } = req.body || {};

  if (line) {
    handleUARTLine(line);
    return res.json({ status: "ok", received: line });
  }

  return res.status(400).json({
    status:  "error",
    message: "Auto-verify disabled. Use CMD_VERIFY + R307 Search (≥80% score) via /stm32/cmd-verify."
  });
});

// ===============================
// EVENT (raw UART line push)
// ===============================
app.post("/stm32/event", (req, res) => {
  const { line } = req.body || {};
  if (!line) return res.status(400).json({ status: "error", message: "Missing line" });
  handleUARTLine(line.trim());
  res.json({ status: "ok", received: line });
});

// ===============================
// VOTER DATA poll
// ===============================
app.get("/stm32/voter-data", (req, res) => {
  const aadhaar = (req.query.aadhaar || "").trim();
  if (!aadhaar) return res.json({ found: false });

  const data = voterDataCache[aadhaar];
  if (data && (Date.now() - data.ts) < 300000) {
    return res.json({ found: true, ...data });
  }
  res.json({ found: false, aadhaar });
});

// ===============================
// Send VOTER_INFO to STM32
// ===============================
app.post("/stm32/send-voter-info", (req, res) => {
  const { aadhaar, name, age, gender } = req.body || {};
  if (!aadhaar) return res.status(400).json({ status: "error", message: "Missing aadhaar" });

  const msg = `VOTER_INFO:${aadhaar}:${name || ""}:${age || ""}:${gender || ""}`;
  sendToSTM32(msg);
  res.json({ status: "ok", sent: msg });
});

// ===============================
// ACK_VOTE to STM32
// ===============================
app.post("/stm32/ack-vote", (req, res) => {
  const { aadhaar, party } = req.body || {};
  if (!aadhaar || !party) return res.status(400).json({ status: "error" });

  const msg = `ACK_VOTE:${aadhaar}:${party}`;
  sendToSTM32(msg);
  res.json({ status: "ok", sent: msg });
});

// ===============================
// CMD_ENROLL
// ===============================
app.post("/stm32/cmd-enroll", (req, res) => {
  const { aadhaar } = req.body || {};
  if (!aadhaar) return res.status(400).json({ status: "error", message: "Missing aadhaar" });

  // Block enrollment if STM32 is connected but R307 sensor is not
  if (stm32Connected && r307SensorStatus !== "connected") {
    return res.status(400).json({
      status: "error",
      message: "R307 fingerprint sensor is not connected. Check sensor wiring and power before enrolling."
    });
  }

  // Clear previous consent/template state for this voter
  delete sampleConsents[aadhaar];
  delete templateStore[aadhaar];
  delete enrollResults[aadhaar];
  saveLocalDatabase();

  sendToSTM32(`CMD_ENROLL:${aadhaar}`);
  res.json({ status: "ok", command: `CMD_ENROLL:${aadhaar}` });
});

// ===============================
// CMD_VERIFY — load all 5 templates then trigger live verify
// POST /stm32/cmd-verify  body: { aadhaar }
// ===============================
app.post("/stm32/cmd-verify", async (req, res) => {
  const { aadhaar, templates: bodyTemplates } = req.body || {};
  if (!aadhaar) return res.status(400).json({ status: "error", message: "Missing aadhaar" });

  // Block verification if STM32 is connected but R307 sensor is not
  if (stm32Connected && r307SensorStatus !== "connected") {
    return res.status(400).json({
      status: "error",
      message: "R307 fingerprint sensor is not connected. Check sensor wiring and power before verifying."
    });
  }

  if (bodyTemplates && typeof bodyTemplates === "object") {
    Object.entries(bodyTemplates).forEach(([k, v]) => {
      if (isRealR307Template(v)) {
        if (!templateStore[aadhaar]) templateStore[aadhaar] = {};
        templateStore[aadhaar][k] = v;
      }
    });
  }

  const valid = getValidTemplates(aadhaar);
  const loaded = Object.keys(valid).length;
  if (loaded < REQUIRED_FP_SAMPLES) {
    return res.status(400).json({
      status:  "error",
      message: `Need ${REQUIRED_FP_SAMPLES} enrolled R307 templates, found ${loaded}`
    });
  }

  for (let n = 1; n <= REQUIRED_FP_SAMPLES; n++) {
    const b64 = valid[String(n)] || valid[n];
    if (!b64) {
      return res.status(400).json({ status: "error", message: `Missing template ${n}` });
    }
    const ackPromise = new Promise((resolve) => {
      templateLoadResolvers[n] = resolve;
      setTimeout(() => {
        console.log(`[VERIFY] Handshake timeout for template ${n} — continuing`);
        resolve();
      }, 500);
    });
    sendToSTM32(`LOAD_TEMPLATE:${n}:${b64}`);
    await ackPromise;
    delete templateLoadResolvers[n];
  }
  console.log(`[VERIFY] Loaded ${REQUIRED_FP_SAMPLES} R307 templates for ${aadhaar}`);
  await delay(150);

  sendToSTM32(`CMD_VERIFY:${aadhaar}`);
  res.json({
    status:          "ok",
    command:         `CMD_VERIFY:${aadhaar}`,
    templatesLoaded: REQUIRED_FP_SAMPLES,
    thresholdPct:    80
  });
});

// ===============================
// CAPTURE FINGERPRINT
// ===============================
app.post("/fingerprint/capture", (req, res) => {
  const { aadhaar } = req.body || {};

  // Block capture if STM32 connected but R307 sensor is not
  if (stm32Connected && r307SensorStatus !== "connected") {
    return res.status(400).json({
      template: null,
      source: "error",
      message: "R307 fingerprint sensor is not connected. Cannot capture fingerprint data."
    });
  }

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

  // Enforce real R307 data — reject mock/placeholder templates
  if (stm32Connected) {
    const invalidSamples = samples.filter(s => !isRealR307Template(s));
    if (invalidSamples.length > 0) {
      console.warn(`[STORE] Rejected ${invalidSamples.length} non-R307 samples for ${aadhaar}`);
      return res.status(400).json({
        success: false,
        message: `Cannot save: ${invalidSamples.length} of ${samples.length} samples are not real R307 sensor data. Connect the fingerprint sensor and capture real biometric data.`
      });
    }
  }

  fingerprintDB[aadhaar] = samples;
  console.log(`[STORE] Saved ${samples.length} samples for ${aadhaar}`);
  saveLocalDatabase();
  res.json({ success: true, message: "Fingerprint stored" });
});

// ===============================
// VERIFY FINGERPRINT — multi-template fused matching
// POST /fingerprint/verify  body: { aadhaar, template? }
// ===============================
app.post("/fingerprint/verify", (req, res) => {
  const { aadhaar } = req.body || {};
  if (!aadhaar) return res.json({ match: false, reason: "missing aadhaar" });

  if (stm32Connected) {
    return res.json({
      match:  false,
      reason: "hardware_required",
      message: "Use /stm32/cmd-verify for R307 verification with 80% threshold"
    });
  }

  const storedTemplates = getValidTemplates(aadhaar);
  const mockSamples = (fingerprintDB[aadhaar] || []).filter(
    (s) => typeof s === "string" && s.startsWith("MOCK_FP_")
  );
  const match = mockSamples.length >= REQUIRED_FP_SAMPLES;

  res.json({
    match,
    source:           "demo",
    templatesChecked: Object.keys(storedTemplates).length || mockSamples.length
  });
});

// ===============================
// VOTING STATE POLL ENDPOINTS
// ===============================
app.get("/stm32/voting-state", (req, res) => {
  res.json(votingState);
});

app.post("/stm32/clear-voting-state", (req, res) => {
  votingState = { active: false, aadhaar: "", selected_party: "", voted: false, voted_party: "" };
  res.json({ status: "ok" });
});

// ===============================
// Start — supports both direct run and require()
// ===============================
const API_PORT = 5002;
const apiServer = app.listen(API_PORT, "127.0.0.1", () => {
  if (require.main === module) {
    console.log("[EVM] Fingerprint server running on port " + API_PORT);
    console.log("[EVM] STM32 auto-detection active (polling every 3s)");
    console.log("[EVM] Multi-template fusion enrollment enabled (5 samples)");
    console.log("[EVM] Per-sample consent endpoints: /stm32/sample-consent, /stm32/ack-sample, /stm32/deny-sample");
  } else {
    console.log("[EVM] Fingerprint backend running on port " + API_PORT);
  }
});

apiServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("[EVM] Port " + API_PORT + " is already in use. Close the other SecEVM window and run SecEVM.bat again.");
    if (require.main === module) process.exit(1);
    return;
  }
  console.error("[EVM] Fingerprint server error:", err.message);
  if (require.main === module) process.exit(1);
});

module.exports = app;
