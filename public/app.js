import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  runTransaction,
  collection,
  onSnapshot,
  query
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ================= Firebase Configuration =================
const firebaseConfig = {
  apiKey: "AIzaSyD79qCUCqpVL4JGVOoBtozitYMqQ1G8ynU",
  authDomain: "evm--sv.firebaseapp.com",
  projectId: "evm--sv",
  storageBucket: "evm--sv.firebasestorage.app",
  messagingSenderId: "804285004582",
  appId: "1:804285004582:web:6c605e5d5851e60a2c5fe7",
  measurementId: "G-SLE8CGTQ3X"
};

let db = null;
let isFirebaseMode = false;

// Attempt Firebase initialization
try {
  if (firebaseConfig.apiKey && firebaseConfig.apiKey !== "YOUR_API_KEY") {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    isFirebaseMode = true;
    console.log("[EVM] Connected to Firebase Firestore");
  } else {
    console.log("[EVM] Running in Demo Mode (LocalStorage Database)");
  }
} catch (e) {
  console.warn("[EVM] Firebase Init Failed. Falling back to Demo Mode.", e);
}


if (isFirebaseMode) {
  const parties = ["AB", "CD", "EF", "GH", "NOTA"];
  (async () => {
    for (const p of parties) {
      const ref = doc(db, "PartyDB", p);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, { votes: 0 });
        console.log(`[EVM] Created PartyDB doc for ${p}`);
      }
    }
  })();
}

// ================= Local Storage Fallback Database =================
const mockDB = {
  getVoter: async (aadhaar) => {
    const voters = JSON.parse(localStorage.getItem("evm_voters") || "{}");
    return voters[aadhaar] || null;
  },
  setVoter: async (aadhaar, data) => {
    const voters = JSON.parse(localStorage.getItem("evm_voters") || "{}");
    voters[aadhaar] = data;
    localStorage.setItem("evm_voters", JSON.stringify(voters));
    return true;
  },
  castVote: async (aadhaar, party) => {
    const voters = JSON.parse(localStorage.getItem("evm_voters") || "{}");
    if (!voters[aadhaar]) throw new Error("Voter not found");
    if (voters[aadhaar].flag === 1) throw new Error("Already voted");

    voters[aadhaar].flag = 1;
    voters[aadhaar].voted_party = party;
    voters[aadhaar].voted_at = new Date().toISOString();
    localStorage.setItem("evm_voters", JSON.stringify(voters));

    // Update stats
    const stats = JSON.parse(localStorage.getItem("evm_stats") || '{"total_votes":0,"parties":{}}');
    stats.total_votes = (stats.total_votes || 0) + 1;
    stats.parties[party] = (stats.parties[party] || 0) + 1;
    localStorage.setItem("evm_stats", JSON.stringify(stats));
    return true;
  },
  getStats: async () => {
    if (isFirebaseMode) {
      try {
        const parties = ["AB", "CD", "EF", "GH", "NOTA"];
        const stats = { total_votes: 0, parties: {} };
        for (const p of parties) {
          const docRef = doc(db, "PartyDB", p);
          const snap = await getDoc(docRef);
          if (snap.exists()) {
            const count = snap.data().votes || 0;
            stats.parties[p] = count;
            stats.total_votes += count;
          }
        }
        return stats;
      } catch (e) {
        console.error("Firestore stats read failed, reading local", e);
      }
    }
    // Default fallback
    return JSON.parse(localStorage.getItem("evm_stats") || '{"total_votes":0,"parties":{"AB":0,"CD":0,"EF":0,"GH":0,"NOTA":0}}');
  }
};

// Initialize localStorage default stats if not present
if (!localStorage.getItem("evm_stats")) {
  localStorage.setItem("evm_stats", JSON.stringify({
    total_votes: 0,
    parties: { "AB": 0, "CD": 0, "EF": 0, "GH": 0, "NOTA": 0 }
  }));
}

// Ensure backend offline banner is created in the document
function ensureBackendOfflineBanner() {
  let banner = document.getElementById("backendOfflineBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "backendOfflineBanner";
    banner.style.cssText = [
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:10000;",
      "background:#7f1d1d;border:1px solid #ef4444;color:#fecaca;",
      "padding:12px 20px;border-radius:10px;max-width:90%;text-align:center;",
      "font-size:0.9rem;box-shadow:0 4px 24px rgba(0,0,0,0.4);display:none;"
    ].join("");
    banner.innerHTML =
      "<strong>Backend offline.</strong> Close this tab and double-click " +
      "<strong>START SecEVM.bat</strong> in your Desktop folder. " +
      "Do not open index.html directly.";
    document.body.appendChild(banner);
  }
  return banner;
}

// Warn if the page was opened without the backend (e.g. double-clicked index.html)
async function showBackendStartupHint() {
  const { bridge } = await checkBridgeStatus();
  const banner = ensureBackendOfflineBanner();
  banner.style.display = bridge ? "none" : "block";
}

// ================= Hardware Polling =================
async function startHardwarePolling() {
  const hwBadge = document.getElementById("hwBadge");
  if (!hwBadge) return;

  const updateBadge = async () => {
    const { bridge, hardware, sensor } = await checkBridgeStatus();

    const offlineBanner = ensureBackendOfflineBanner();
    offlineBanner.style.display = bridge ? "none" : "block";

    // Sensor warning banner
    let sensorBanner = document.getElementById("sensorWarningBanner");
    if (!sensorBanner) {
      sensorBanner = document.createElement("div");
      sensorBanner.id = "sensorWarningBanner";
      sensorBanner.style.cssText = [
        "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:10000;",
        "background:#78350f;border:1px solid #f59e0b;color:#fef3c7;",
        "padding:12px 20px;border-radius:10px;max-width:90%;text-align:center;",
        "font-size:0.9rem;box-shadow:0 4px 24px rgba(0,0,0,0.4);display:none;"
      ].join("");
      sensorBanner.innerHTML =
        "<strong>⚠️ R307 Sensor Not Detected.</strong> STM32 board is connected but the fingerprint sensor is not responding. Check TX/RX wiring and power.";
      document.body.appendChild(sensorBanner);
    }

    if (!bridge) {
      hwBadge.className = "status-badge error";
      hwBadge.innerHTML = '<span class="badge-dot"></span>Hardware: Disconnected';
      sensorBanner.style.display = "none";
    } else if (!hardware) {
      hwBadge.className = "status-badge demo";
      hwBadge.innerHTML = '<span class="badge-dot"></span>STM32: Not Connected';
      sensorBanner.style.display = "none";
    } else if (sensor === "disconnected") {
      hwBadge.className = "status-badge warning";
      hwBadge.innerHTML = '<span class="badge-dot"></span>R307 Sensor: Disconnected ⚠️';
      sensorBanner.style.display = "block";
    } else {
      // Bridge running + STM32 connected + sensor OK
      hwBadge.className = "status-badge success";
      hwBadge.innerHTML = '<span class="badge-dot"></span>Hardware: Live';
      sensorBanner.style.display = "none";
    }
  };

  await updateBadge();
  setInterval(updateBadge, 3000);
}

// Update database badge in UI
document.addEventListener("DOMContentLoaded", () => {
  const badge = document.getElementById("dbBadge");
  if (badge) {
    if (isFirebaseMode) {
      badge.className = "status-badge firebase";
      badge.innerHTML = '<span class="badge-dot"></span>Firebase Live';
    } else {
      badge.className = "status-badge demo";
      badge.innerHTML = '<span class="badge-dot"></span>Demo Mode';
    }
  }
  
  // Render stats initially
  updateStatsDisplay();
  
  // Render default Dev Hub template
  updateDevHubContent();

  // Start polling hardware status
  startHardwarePolling();
  showBackendStartupHint();

  // Aadhaar pre-verification event listener
  const voteAadhaarInput = document.getElementById("voteAadhaar");
  if (voteAadhaarInput) {
    voteAadhaarInput.addEventListener("input", handleVoteAadhaarInput);
  }

  // Ballot locked by default — requires real fingerprint scan to unlock
  setBallotLocked(true);
});

// Helper to add fingerprint visual image to enrollment gallery
function addFpSampleToGallery(sampleIndex) {
  const grid = document.getElementById("enrollFpGrid");
  const gallery = document.getElementById("enrollFpGallery");
  if (!grid || !gallery) return;
  
  gallery.style.display = "block";
  
  const item = document.createElement("div");
  item.className = "fp-gallery-item";
  
  // Random variations to show different fingerprint scans
  const rotation = (Math.random() * 30 - 15).toFixed(1);
  const opacity = (0.75 + Math.random() * 0.25).toFixed(2);
  const hue = (sampleIndex * 40) % 360;
  const scale = (0.95 + Math.random() * 0.1).toFixed(2);
  
  item.innerHTML = `
    <img src="fingerprint.svg" style="transform: rotate(${rotation}deg) scale(${scale}); opacity: ${opacity}; filter: hue-rotate(${hue}deg) brightness(1.1);" alt="Sample ${sampleIndex}">
    <span class="sample-number">#${sampleIndex}</span>
  `;
  grid.appendChild(item);
}

// Aadhaar Pre-Verification & Automatic Eligibility Checking
async function handleVoteAadhaarInput(e) {
  const aadhaar = e.target.value.trim();
  const card = document.getElementById("voterPreVerifyCard");
  const fpBox = document.getElementById("verifyFpBox");
  const compPanel = document.getElementById("verifyComparisonPanel");
  
  const preAadhaarStatus = document.getElementById("preVerifyAadhaarStatus");
  const preName = document.getElementById("preVerifyName");
  const preAge = document.getElementById("preVerifyAge");
  const preStatus = document.getElementById("preVerifyStatus");
  const preOverall = document.getElementById("preVerifyOverall");

  // Reset verification states
  liveScanVerified = false;
  verifiedVoterData = null;
  setBallotLocked(true);
  if (compPanel) compPanel.style.display = "none";
  const verifyFpSensor = document.getElementById("verifyFpSensor");
  const fpLiveStatus = document.getElementById("fpLiveStatus");
  if (verifyFpSensor) verifyFpSensor.className = "fp-sensor";
  if (fpLiveStatus) fpLiveStatus.innerText = "Unlock ballot with biometric verification.";
  
  // Reset scan panel borders/glows
  const liveScanBox = document.querySelector("#verifyComparisonPanel .comparison-side:last-child .comparison-fp-box");
  if (liveScanBox) {
    liveScanBox.style.borderColor = "";
    liveScanBox.style.boxShadow = "";
  }

  if (!/^\d{12}$/.test(aadhaar)) {
    if (card) card.style.display = "none";
    if (fpBox) fpBox.style.display = "none";
    return;
  }

  if (card) {
    card.style.display = "block";
    preAadhaarStatus.className = "pre-status";
    preAadhaarStatus.innerText = "Checking Aadhaar DB... 🔍";
    preName.innerText = "Loading...";
    preAge.innerText = "Loading...";
    preStatus.innerText = "Loading...";
    preOverall.className = "overall-banner";
    preOverall.innerText = "Verifying...";
  }

  let voter = null;
  try {
    if (isFirebaseMode) {
      const snap = await getDoc(doc(db, "VoterDB", aadhaar));
      if (snap.exists()) voter = snap.data();
    } else {
      voter = await mockDB.getVoter(aadhaar);
    }
  } catch (err) {
    console.error("Voter fetch failed", err);
  }

  if (!voter) {
    preAadhaarStatus.className = "pre-status notfound";
    preAadhaarStatus.innerText = "Aadhaar Not Registered ❌";
    preName.innerText = "-";
    preAge.innerText = "-";
    preStatus.innerText = "-";
    preOverall.className = "overall-banner ineligible";
    preOverall.innerText = "VOTER NOT FOUND IN DATABASE";
    if (fpBox) fpBox.style.display = "none";
    return;
  }

  preAadhaarStatus.className = "pre-status found";
  preAadhaarStatus.innerText = "Aadhaar Found ✔";
  preName.innerText = voter.name;
  
  const ageEligible = voter.age >= 18;
  preAge.innerText = `${voter.age} yrs (${ageEligible ? 'Eligible' : 'Under 18 ❌'})`;
  preAge.style.color = ageEligible ? "var(--success)" : "var(--danger)";

  const hasVoted = voter.flag === 1;
  preStatus.innerText = hasVoted ? "Already Voted ❌" : "Has Not Voted ✔";
  preStatus.style.color = hasVoted ? "var(--danger)" : "var(--success)";

  if (ageEligible && !hasVoted) {
    preOverall.className = "overall-banner eligible";
    preOverall.innerText = "ELIGIBLE TO VOTE ✔";
    if (fpBox) fpBox.style.display = "block";
  } else {
    preOverall.className = "overall-banner ineligible";
    preOverall.innerText = hasVoted ? "NOT ELIGIBLE (ALREADY VOTED ❌)" : "NOT ELIGIBLE (UNDER 18 ❌)";
    if (fpBox) fpBox.style.display = "none";
  }
}

// ================= Global States =================
let registrationSamples = [];
let liveScanVerified = false;
let verifiedVoterData = null;

// Helper to check if the local bridge server is online
// AND whether the STM32 hardware is actually connected
async function checkBridgeStatus() {
  try {
    const res = await fetch("http://127.0.0.1:5002/status", { method: "GET" });
    if (!res.ok) return { bridge: false, hardware: false };
    const data = await res.json();
    return {
      bridge:   true,
      hardware: data.hardware === "connected",
      sensor:   data.sensor || "unknown"
    };
  } catch (e) {
    return { bridge: false, hardware: false };
  }
}

const REQUIRED_FP_SAMPLES = 5;
const MATCH_THRESHOLD_PCT = 80;

// Real R307 CharBuffer templates are base64 blobs from the sensor — not mock prefixes
function isRealR307Template(tmpl) {
  if (!tmpl || typeof tmpl !== "string") return false;
  if (/^(MOCK_FP_|STM32_FP_|FP_|PLACEHOLDER_)/.test(tmpl)) return false;
  return tmpl.length >= 64 && /^[A-Za-z0-9+/=]+$/.test(tmpl);
}

function countRealTemplates(templatesObj) {
  if (!templatesObj) return 0;
  return Object.values(templatesObj).filter(isRealR307Template).length;
}

async function pollUntil(timeoutMs, intervalMs, checkFn) {
  let elapsed = 0;
  while (elapsed < timeoutMs) {
    const result = await checkFn();
    if (result) return result;
    await new Promise(r => setTimeout(r, intervalMs));
    elapsed += intervalMs;
  }
  return null;
}

async function fetchStoredTemplates(aadhaar) {
  try {
    const res  = await fetch(`http://127.0.0.1:5002/stm32/templates?aadhaar=${aadhaar}`);
    const data = await res.json();
    return data.found ? data.templates : null;
  } catch (_) {
    return null;
  }
}

async function waitForSampleReady(aadhaar, sampleIndex) {
  return pollUntil(600000, 500, async () => {
    try {
      const res  = await fetch(
        `http://127.0.0.1:5002/stm32/sample-consent?aadhaar=${aadhaar}&sample=${sampleIndex}`
      );
      const data = await res.json();
      return data.status === "pending" ? true : null;
    } catch (_) {
      return null;
    }
  });
}

async function waitForR307Template(aadhaar, sampleIndex) {
  return pollUntil(45000, 500, async () => {
    const templates = await fetchStoredTemplates(aadhaar);
    const tmpl = templates && templates[String(sampleIndex)];
    return isRealR307Template(tmpl) ? tmpl : null;
  });
}

async function waitForEnrollComplete(aadhaar) {
  return pollUntil(120000, 1000, async () => {
    try {
      const res  = await fetch(`http://127.0.0.1:5002/stm32/enroll-status?aadhaar=${aadhaar}`);
      const data = await res.json();
      if (data.status === "complete") return "complete";
      if (data.status === "aborted") return "aborted";
      return null;
    } catch (_) {
      return null;
    }
  });
}

// ================= STM32 Hardware Fingerprint Enrollment =================
// HW button uses the same real R307 5-sample + consent flow as startEnrollment().
window.checkFingerprint = async function () {
  const { bridge, hardware, sensor } = await checkBridgeStatus();
  if (!bridge || !hardware) {
    showStatus("fpStatus", "Connect STM32 + R307 sensor, then use Capture Fingerprint ❌", "error");
    return;
  }
  // Block if STM32 is connected but R307 sensor is not
  if (sensor === "disconnected") {
    showStatus("fpStatus", "⚠️ Fingerprint Sensor Not Connected — STM32 is online but the R307 sensor is not responding. Check TX/RX wiring and power. ❌", "error");
    return;
  }
  await window.startEnrollment();
};

// ================= Tab Navigation =================
window.switchTab = function (tabId) {
  document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.remove("active"));
  document.querySelectorAll(".view-section").forEach(sec => sec.classList.remove("active"));

  const targetTabBtn = document.querySelector(`.tab-btn[onclick*="${tabId}"]`);
  const targetSection = document.getElementById(tabId);
  
  if (targetTabBtn) targetTabBtn.classList.add("active");
  if (targetSection) targetSection.classList.add("active");

  if (tabId === "stats-tab") {
    updateStatsDisplay();
  }
};

// ================= Voter Registration =================

// ── Per-sample consent dialog ──────────────────────────────────────────
// Shows a modal asking the voter to approve each captured sample.
// In Demo Mode (no hardware) it auto-approves after 3 seconds.
// Returns a Promise that resolves to true (approved) or false (denied).
function showSampleConsentDialog(sampleIndex, isDemoMode) {
  return new Promise((resolve) => {
    // Inject modal if not already present
    let modal = document.getElementById("sampleConsentModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "sampleConsentModal";
      modal.style.cssText = [
        "position:fixed;top:0;left:0;width:100%;height:100%;",
        "background:rgba(0,0,0,0.75);z-index:9999;",
        "display:flex;align-items:center;justify-content:center;"
      ].join("");
      modal.innerHTML = `
        <div style="background:#111622;border:1px solid #334155;border-radius:14px;
                    padding:32px;max-width:420px;width:90%;text-align:center;
                    box-shadow:0 0 40px rgba(6,182,212,0.15);">
          <div style="font-size:2.5rem;margin-bottom:12px;">👆</div>
          <h3 id="consentTitle" style="color:#e2e8f0;margin:0 0 10px;font-size:1.2rem;"></h3>
          <p id="consentBody" style="color:#94a3b8;margin:0 0 24px;font-size:0.9rem;line-height:1.5;"></p>
          <div id="consentTimer" style="color:#64748b;font-size:0.8rem;margin-bottom:18px;"></div>
          <div style="display:flex;gap:12px;justify-content:center;">
            <button id="consentYes" style="background:#10b981;color:#fff;border:none;
              padding:10px 28px;border-radius:8px;cursor:pointer;font-weight:600;font-size:0.95rem;">
              ✔ Yes, Save Sample
            </button>
            <button id="consentNo" style="background:#ef4444;color:#fff;border:none;
              padding:10px 28px;border-radius:8px;cursor:pointer;font-weight:600;font-size:0.95rem;">
              ✗ No, Abort
            </button>
          </div>
        </div>`;
      document.body.appendChild(modal);
    }

    modal.querySelector("#consentTitle").innerText =
      `Sample ${sampleIndex} of 5 Captured`;
    modal.querySelector("#consentBody").innerText =
      `Your fingerprint sample ${sampleIndex} has been scanned.\n` +
      `Do you consent to saving this sample as part of your biometric identity?`;
    modal.style.display = "flex";

    const timerEl = modal.querySelector("#consentTimer");
    const yesBtn  = modal.querySelector("#consentYes");
    const noBtn   = modal.querySelector("#consentNo");

    let countdown = null;
    let resolved  = false;

    const finish = (approved) => {
      if (resolved) return;
      resolved = true;
      clearInterval(countdown);
      modal.style.display = "none";
      timerEl.innerText = "";
      resolve(approved);
    };

    yesBtn.onclick = () => finish(true);
    noBtn.onclick  = () => finish(false);

    timerEl.innerText = "";
  });
}

// ── Enrollment completion banner ──────────────────────────────────────
function showEnrollmentComplete(aadhaar) {
  let banner = document.getElementById("enrollCompleteBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "enrollCompleteBanner";
    banner.style.cssText = [
      "position:fixed;top:0;left:0;width:100%;height:100%;",
      "background:rgba(0,0,0,0.80);z-index:9998;",
      "display:flex;align-items:center;justify-content:center;"
    ].join("");
    document.body.appendChild(banner);
  }

  // Format Aadhaar as XXXX-XXXX-XXXX
  const formatted = aadhaar.replace(/(\d{4})(\d{4})(\d{4})/, "$1-$2-$3");

  banner.innerHTML = `
    <div style="background:#111622;border:1px solid #10b981;border-radius:16px;
                padding:40px 36px;max-width:480px;width:92%;text-align:center;
                box-shadow:0 0 50px rgba(16,185,129,0.2);">
      <div style="font-size:3rem;margin-bottom:16px;">✅</div>
      <h2 style="color:#10b981;margin:0 0 14px;font-size:1.4rem;">
        Fingerprint Enrollment Complete
      </h2>
      <p style="color:#e2e8f0;margin:0 0 8px;line-height:1.6;font-size:0.95rem;">
        <strong>5 samples</strong> captured and fused into a single biometric identity for
      </p>
      <p style="color:#06b6d4;font-size:1.1rem;font-weight:700;margin:0 0 12px;
                letter-spacing:2px;">${formatted}</p>
      <p style="color:#94a3b8;font-size:0.85rem;margin:0 0 28px;">
        Your fingerprint is now registered. Multiple angles and pressures are
        stored so any scan will be recognised — just like a phone fingerprint.
      </p>
      <button onclick="document.getElementById('enrollCompleteBanner').style.display='none'"
        style="background:#10b981;color:#fff;border:none;padding:11px 32px;
               border-radius:9px;cursor:pointer;font-weight:600;font-size:0.95rem;">
        Done ✔
      </button>
    </div>`;
  banner.style.display = "flex";
}

window.startEnrollment = async function () {
  const aadhaar = document.getElementById("aadhaar").value.trim();
  const name    = document.getElementById("name").value.trim();
  const dob     = document.getElementById("dob").value;
  const gender  = document.getElementById("gender").value;

  // Validation
  if (!aadhaar || !name || !dob || !gender) {
    showStatus("fpStatus", "Please fill all fields ❌", "error");
    return;
  }
  if (!/^\d{12}$/.test(aadhaar)) {
    showStatus("fpStatus", "Aadhaar must be exactly 12 digits ❌", "error");
    return;
  }
  const age = new Date().getFullYear() - Number(dob.split("-")[0]);
  if (isNaN(age)) {
    showStatus("fpStatus", "Invalid Date of Birth ❌", "error");
    return;
  }

  // ── STM32 check ───────────────────────────────────────
  const { bridge, hardware, sensor } = await checkBridgeStatus();

  // Block enrollment completely if STM32 is not connected
  if (!bridge || !hardware) {
    showStatus("fpStatus", "⚠️ STM32 Not Connected — Cannot collect fingerprint data without the hardware sensor. Connect the STM32 + R307 fingerprint sensor and try again. ❌", "error");
    return;
  }

  // Block enrollment if STM32 is connected but R307 sensor is not
  if (sensor === "disconnected") {
    showStatus("fpStatus", "⚠️ Fingerprint Sensor Not Connected — STM32 is online but the R307 sensor is not responding. Check TX/RX wiring and power. ❌", "error");
    return;
  }

  const isDemoMode = false; 

  // Hardware path: tell STM32 to start enrollment
  const fpSensor = document.getElementById("enrollFpSensor");
  fpSensor.className = "fp-sensor scanning";
  // ─────────────────────────────────────────────────────────────────

  registrationSamples = [];

  // Clear visual fingerprint gallery
  const grid    = document.getElementById("enrollFpGrid");
  const gallery = document.getElementById("enrollFpGallery");
  if (grid)    grid.innerHTML    = "";
  if (gallery) gallery.style.display = "none";

  showStatus("fpStatus",
    "STM32 connected. Capturing 5 fingerprint samples with consent...",
    "working"
  );

  const totalSamples = 5;
  updateSampleDots(0, totalSamples);

  // Kick off STM32 enrollment
  try {
    await fetch("http://127.0.0.1:5002/stm32/cmd-enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aadhaar })
    });
  } catch (_) { /* non-critical */ }

  // ── Sample-by-sample loop: R307 capture → consent → real template upload ──
  let fpTemplates = {};

  for (let sampleIndex = 1; sampleIndex <= totalSamples; sampleIndex++) {
    showStatus("fpStatus", `Place finger on R307 sensor — sample ${sampleIndex}/${totalSamples}...`, "working");
    const ready = await waitForSampleReady(aadhaar, sampleIndex);
    if (!ready) {
      fpSensor.className = "fp-sensor error";
      showStatus("fpStatus", `Timeout waiting for R307 sample ${sampleIndex} ❌`, "error");
      return;
    }

    showStatus("fpStatus", `Sample ${sampleIndex} captured — asking voter for consent...`, "working");
    const approved = await showSampleConsentDialog(sampleIndex, false);

    if (!approved) {
      fpSensor.className = "fp-sensor error";
      showStatus("fpStatus", `Enrollment aborted at sample ${sampleIndex} — voter declined ❌`, "error");
      updateSampleDots(sampleIndex - 1, totalSamples);
      fetch("http://127.0.0.1:5002/stm32/deny-sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aadhaar, sample: sampleIndex })
      }).catch(() => {});
      return;
    }

    try {
      await fetch("http://127.0.0.1:5002/stm32/ack-sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aadhaar, sample: sampleIndex })
      });
    } catch (_) {
      fpSensor.className = "fp-sensor error";
      showStatus("fpStatus", `Failed to ACK sample ${sampleIndex} to STM32 ❌`, "error");
      return;
    }

    showStatus("fpStatus", `Uploading R307 template ${sampleIndex} from sensor...`, "working");
    const templateStr = await waitForR307Template(aadhaar, sampleIndex);
    if (!templateStr) {
      fpSensor.className = "fp-sensor error";
      showStatus("fpStatus", `R307 template ${sampleIndex} not received from sensor ❌`, "error");
      return;
    }
    fpTemplates[String(sampleIndex)] = templateStr;

    registrationSamples.push(templateStr);
    updateSampleDots(sampleIndex, totalSamples);
    addFpSampleToGallery(sampleIndex);
    showStatus("fpStatus", `Sample ${sampleIndex}/${totalSamples} consented & stored ✔`, "working");
  }

  // ── Hardware: wait for STM32 to fuse all 5 into sensor memory ──
  showStatus("fpStatus", "All 5 samples approved — fusing biometric identity on R307...", "working");
  const enrollState = await waitForEnrollComplete(aadhaar);
  if (enrollState === "aborted") {
    fpSensor.className = "fp-sensor error";
    showStatus("fpStatus", "Enrollment aborted by hardware ❌", "error");
    return;
  }
  if (enrollState !== "complete") {
    fpSensor.className = "fp-sensor error";
    showStatus("fpStatus", "Enrollment fusion timed out — check STM32 connection ❌", "error");
    return;
  }

  const storedTemplates = await fetchStoredTemplates(aadhaar);
  if (countRealTemplates(storedTemplates) < REQUIRED_FP_SAMPLES) {
    fpSensor.className = "fp-sensor error";
    showStatus("fpStatus", `Only ${countRealTemplates(storedTemplates)}/5 R307 templates stored ❌`, "error");
    return;
  }
  fpTemplates = storedTemplates;

  try {
    await fetch("http://127.0.0.1:5002/stm32/store-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aadhaar, templates: fpTemplates })
    });
  } catch (err) {
    console.error("store-templates failed", err);
  }

  fpSensor.className = "fp-sensor success";
  showStatus("fpStatus", "5 R307 samples fused into one biometric identity (phone-style) ✔", "working");

  // ── Enforce real R307 data before saving ──────────────────────────
  // All templates must be genuine R307 data
  const realCount = Object.values(fpTemplates).filter(isRealR307Template).length;
  if (realCount < REQUIRED_FP_SAMPLES) {
    fpSensor.className = "fp-sensor error";
    showStatus("fpStatus", `Cannot save: only ${realCount}/${REQUIRED_FP_SAMPLES} templates are real R307 sensor data. Recapture with the fingerprint sensor connected. ❌`, "error");
    return;
  }

  const voterPayload = {
    aadhaar,
    name,
    dob,
    age,
    gender,
    mobile:             document.getElementById("mobile").value.trim(),
    email:              document.getElementById("email").value.trim(),
    fp_samples:         registrationSamples,
    fp_templates:       fpTemplates,
    fp_sample_count:    REQUIRED_FP_SAMPLES,
    fusion_mode:        "multi_template",
    match_threshold_pct: MATCH_THRESHOLD_PCT,
    fingerprint_status: "enrolled",
    enrolled_at:        new Date().toISOString(),
    flag:               0,
    eligible:           age >= 18,
    voted_party:        "",
    registered_at:      new Date().toISOString()
  };

  try {
    if (isFirebaseMode) {
      await setDoc(doc(db, "VoterDB", aadhaar), voterPayload);
      if (!isDemoMode) {
        fetch("http://127.0.0.1:5002/stm32/send-voter-info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ aadhaar, name: voterPayload.name, age: voterPayload.age, gender: voterPayload.gender })
        }).catch(() => {});
      }
    } else {
      await mockDB.setVoter(aadhaar, voterPayload);
    }

    showStatus("fpStatus", "Voter Registered & 5 Biometric Samples Fused ✔", "success");

    // Show enrollment completion banner
    showEnrollmentComplete(aadhaar);

    // Reset form after 3 s
    setTimeout(() => {
      document.getElementById("aadhaar").value   = "";
      document.getElementById("name").value      = "";
      document.getElementById("dob").value       = "";
      document.getElementById("gender").selectedIndex = 0;
      document.getElementById("mobile").value    = "";
      document.getElementById("email").value     = "";
      fpSensor.className = "fp-sensor";
      showStatus("fpStatus", "Click the scanner to enroll biometrics.", "");
      updateSampleDots(0, 5);
      if (grid)    grid.innerHTML        = "";
      if (gallery) gallery.style.display = "none";
      if (typeof startRegisteredListener === "function") startRegisteredListener();
    }, 3000);

  } catch (err) {
    console.error("Save failed", err);
    showStatus("fpStatus", "Failed to save registration record ❌", "error");
    fpSensor.className = "fp-sensor error";
  }
};

// ================= Fingerprint Verification =================
window.startFingerprintCheck = async function () {
  const aadhaar = document.getElementById("voteAadhaar").value.trim();
  const fpSensor = document.getElementById("verifyFpSensor");
  const compPanel = document.getElementById("verifyComparisonPanel");
  const liveImg = document.getElementById("liveFpImage");
  const liveScanBox = document.querySelector("#verifyComparisonPanel .comparison-side:last-child .comparison-fp-box");

  if (!aadhaar || !/^\d{12}$/.test(aadhaar)) {
    showStatus("fpLiveStatus", "Enter a valid 12-digit Aadhaar first ❌", "error");
    return;
  }

  // Check hardware status — determine if we go hardware or demo path
  const { bridge, hardware, sensor } = await checkBridgeStatus();
  const isHardwareMode = bridge && hardware;

  // Block completely if STM32 hardware is disconnected
  if (!isHardwareMode) {
    fpSensor.className = "fp-sensor error";
    showStatus("fpLiveStatus", "⚠️ STM32 Hardware Disconnected — Biometric verification requires physical hardware connection. Connect the STM32 board and try again. ❌", "error");
    if (compPanel) compPanel.style.display = "none";
    setBallotLocked(true);
    return;
  }

  // Block if STM32 is connected but R307 sensor is not
  if (sensor === "disconnected") {
    fpSensor.className = "fp-sensor error";
    showStatus("fpLiveStatus", "⚠️ Fingerprint Sensor Not Connected — STM32 is online but the R307 sensor is not responding. Check TX/RX wiring and power. ❌", "error");
    setBallotLocked(true);
    return;
  }

  liveScanVerified = false;
  verifiedVoterData = null;
  setBallotLocked(true);
  fpSensor.className = "fp-sensor scanning";
  showStatus("fpLiveStatus", "Place finger on the STM32 sensor... 👆", "working");

  // Show visual comparison panel
  if (compPanel) compPanel.style.display = "flex";
  if (liveScanBox) {
    liveScanBox.className = "comparison-fp-box scanning-effect";
    liveScanBox.style.borderColor = "";
    liveScanBox.style.boxShadow = "";
  }
  if (liveImg) {
    liveImg.style.opacity = "0.3";
    liveImg.style.filter = "hue-rotate(180deg) blur(2px)";
  }

  // Fetch Voter Details from Firestore
  let voter = null;
  try {
    if (isFirebaseMode) {
      const snap = await getDoc(doc(db, "VoterDB", aadhaar));
      if (snap.exists()) voter = snap.data();
    } else {
      voter = await mockDB.getVoter(aadhaar);
    }
  } catch (err) {
    console.error(err);
  }

  if (!voter) {
    fpSensor.className = "fp-sensor error";
    showStatus("fpLiveStatus", "Voter Aadhaar not found ❌", "error");
    if (compPanel) compPanel.style.display = "none";
    return;
  }

  if (voter.flag === 1) {
    fpSensor.className = "fp-sensor error";
    showStatus("fpLiveStatus", "Voter has already cast their vote ❌", "error");
    if (compPanel) compPanel.style.display = "none";
    return;
  }

  // ── Hardware path: load templates then trigger CMD_VERIFY ──────
  let pollResult_raw;

  const voterTemplates = voter.fp_templates || null;
  const templateCount  = countRealTemplates(voterTemplates);

  if (templateCount < REQUIRED_FP_SAMPLES) {
    fpSensor.className = "fp-sensor error";
    showStatus("fpLiveStatus", `Voter has only ${templateCount}/5 enrolled R307 templates — re-enroll ❌`, "error");
    if (compPanel) compPanel.style.display = "none";
    return;
  }

  try {
    const verifyRes = await fetch("http://127.0.0.1:5002/stm32/cmd-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aadhaar, templates: voterTemplates })
    });
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok) {
      fpSensor.className = "fp-sensor error";
      showStatus("fpLiveStatus", verifyData.message || "Cannot start R307 verify — templates missing ❌", "error");
      if (compPanel) compPanel.style.display = "none";
      return;
    }
  } catch (_) {
    fpSensor.className = "fp-sensor error";
    showStatus("fpLiveStatus", "Lost connection to fingerprint server ❌", "error");
    if (compPanel) compPanel.style.display = "none";
    return;
  }

  showStatus("fpLiveStatus", `Place finger on R307 — matching against all 5 templates (≥${MATCH_THRESHOLD_PCT}% required)... 🔌`, "working");

  const POLL_INTERVAL = 1000;
  const POLL_TIMEOUT  = 15000;
  let elapsed = 0;

  pollResult_raw = await new Promise((resolve) => {
    const timer = setInterval(async () => {
      elapsed += POLL_INTERVAL;
      try {
        const res  = await fetch(`http://127.0.0.1:5002/stm32/match-status?aadhaar=${aadhaar}`);
        const data = await res.json();
        if (data.status === "verified") { clearInterval(timer); resolve({ result: "verified", reason: null }); }
        else if (data.status === "failed") { clearInterval(timer); resolve({ result: "failed", reason: data.reason || null }); }
        else if (elapsed >= POLL_TIMEOUT)  { clearInterval(timer); resolve({ result: "timeout", reason: null }); }
      } catch (_) {
        clearInterval(timer);
        resolve({ result: "error", reason: null });
      }
    }, POLL_INTERVAL);
  });

  // Stop scan animation
  if (liveScanBox) liveScanBox.classList.remove("scanning-effect");

  const { result: pollResult, reason: pollReason } = pollResult_raw;

  if (pollResult === "verified") {
    // ── SUCCESS ────────────────────────────────────────────────
    liveScanVerified = true;
    verifiedVoterData = voter;
    fpSensor.className = "fp-sensor success";
    showStatus("fpLiveStatus", "Fingerprint Verified — Voting Enabled ✔", "success");
    setBallotLocked(false); // ← unlock the ballot

    if (liveScanBox) {
      liveScanBox.style.borderColor = "var(--success)";
      liveScanBox.style.boxShadow   = "0 0 15px rgba(16, 185, 129, 0.4)";
    }
    if (liveImg) {
      liveImg.style.opacity = "1";
      liveImg.style.filter  = "hue-rotate(180deg) brightness(1.2)";
    }

    if (isFirebaseMode) {
      setDoc(doc(db, "VoterDB", aadhaar), {
        fingerprint_status: "verified",
        last_verify_status: "matched"
      }, { merge: true }).catch(() => {});
    }

  } else {
    // ── FAILURE / TIMEOUT ──────────────────────────────────────
    liveScanVerified = false;
    fpSensor.className = "fp-sensor error";
    setBallotLocked(true);

    const msgMap = {
      failed:  pollReason === "SCORE_LOW"
                 ? "Fingerprint match score below 80% — try pressing firmly and re-scanning ❌"
                 : "Fingerprint mismatch — not recognised ❌",
      timeout: "No fingerprint detected within 15 seconds. Try again ❌",
      error:   "Lost connection to STM32. Reconnect hardware ❌"
    };
    const msg = msgMap[pollResult] || "Verification failed ❌";

    showStatus("fpLiveStatus", msg, "error");

    if (liveScanBox) {
      liveScanBox.style.borderColor = "var(--danger)";
      liveScanBox.style.boxShadow   = "0 0 15px rgba(239, 68, 68, 0.4)";
    }
    if (liveImg) {
      liveImg.style.opacity = "0.2";
      liveImg.style.filter  = "grayscale(1)";
    }
  }
};

// ================= Cast Vote =================
window.vote = async function (party) {
  const { bridge, hardware } = await checkBridgeStatus();
  const isHardwareMode = bridge && hardware;

  if (isHardwareMode) {
    showStatus("voteStatus", "Voting is locked to physical EVM buttons. Please press the physical push button on the STM32 board to cast your vote! 🔌", "error");
    return;
  }

  const aadhaar = document.getElementById("voteAadhaar").value.trim();

  // verifiedVoterData.aadhaar may not exist if the Firestore doc only stores it
  // as the document ID — fall back to checking the id field as well
  const voterAadhaar = verifiedVoterData
    ? (verifiedVoterData.aadhaar || verifiedVoterData.id || "")
    : "";

  if (!liveScanVerified || !verifiedVoterData || voterAadhaar !== aadhaar) {
    showStatus("voteStatus", "Verify fingerprint biometric matching first ❌", "error");
    return;
  }

  showStatus("voteStatus", "Recording secure vote...", "working");

  try {
    if (isFirebaseMode) {
      await runTransaction(db, async (tx) => {
        const voterRef = doc(db, "VoterDB", aadhaar);
        const partyRef = doc(db, "PartyDB", party);

        const voterSnap = await tx.get(voterRef);
        const partySnap = await tx.get(partyRef);

        if (!voterSnap.exists() || voterSnap.data().flag === 1) {
          throw new Error("Already voted");
        }

        // Update Voter Status
        tx.update(voterRef, {
          flag: 1,
          voted_party: party,
          voted_at: new Date().toISOString()
        });

        // Update Party Stats — create party doc if missing
        if (partySnap.exists()) {
          tx.update(partyRef, {
            votes: (partySnap.data().votes || 0) + 1
          });
        } else {
          tx.set(partyRef, {votes: 1});
        }
      });
    } else {
      await mockDB.castVote(aadhaar, party);
    }

    showStatus("voteStatus", `Vote Cast Successfully for ${party} ✔`, "success");

    // Notify STM32 that vote was recorded
    const { bridge: bridgeUp } = await checkBridgeStatus();
    if (bridgeUp) {
      fetch("http://127.0.0.1:5002/stm32/ack-vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aadhaar, party })
      }).catch(() => {});
    }
    
    // Clear states
    liveScanVerified = false;
    verifiedVoterData = null;
    setBallotLocked(true);
    document.getElementById("voteAadhaar").value = "";
    document.getElementById("verifyFpSensor").className = "fp-sensor";
    document.getElementById("fpLiveStatus").innerText = "";
    
    // Update stats preview if visible
    updateStatsDisplay();
  } catch (err) {
    console.error(err);
    showStatus("voteStatus", "Error processing vote. Please try again ❌", "error");
  }
};

// ================= Stats Calculations =================
async function updateStatsDisplay() {
  const data = await mockDB.getStats();
  
  const totalVotesVal = document.getElementById("statTotalVotes");
  if (totalVotesVal) totalVotesVal.innerText = data.total_votes;

  const parties = ["AB", "CD", "EF", "GH", "NOTA"];
  parties.forEach(p => {
    const voteCount = data.parties[p] || 0;
    const percent = data.total_votes > 0 ? Math.round((voteCount / data.total_votes) * 100) : 0;
    
    const countEl = document.getElementById(`count-${p}`);
    const barEl = document.getElementById(`bar-${p}`);
    
    if (countEl) countEl.innerText = `${voteCount} (${percent}%)`;
    if (barEl) barEl.style.width = `${percent}%`;
  });
}

// ================= UI Utilities =================
function showStatus(elementId, text, type) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerText = text;
  el.className = "status-text " + (type || "");
}

// Lock or unlock the ballot — ballot items are visually disabled
// and the vote() function checks liveScanVerified as a hard gate
let votingStatePollInterval = null;

function setBallotLocked(locked) {
  const items = document.querySelectorAll(".ballot-item");
  const hwBadge = document.getElementById("hwBadge");
  const isHardwareMode = hwBadge && hwBadge.innerHTML.includes("Live");

  items.forEach(item => {
    if (locked) {
      item.style.opacity = "0.35";
      item.style.pointerEvents = "none";
      item.style.cursor = "not-allowed";
      item.classList.remove("selected");
    } else {
      item.style.opacity = "1";
      if (isHardwareMode) {
        item.style.pointerEvents = "none"; // Disable mouse clicks in hardware mode
        item.style.cursor = "default";
      } else {
        item.style.pointerEvents = "auto";
        item.style.cursor = "pointer";
      }
    }
  });

  if (locked) {
    if (votingStatePollInterval) {
      clearInterval(votingStatePollInterval);
      votingStatePollInterval = null;
    }
  } else if (isHardwareMode) {
    if (!votingStatePollInterval) {
      votingStatePollInterval = setInterval(async () => {
        try {
          const res = await fetch("http://127.0.0.1:5002/stm32/voting-state");
          if (res.ok) {
            const data = await res.json();
            if (data.active) {
              items.forEach(item => {
                const party = item.getAttribute("data-party") || item.onclick.toString().match(/'([^']+)'/)[1];
                if (party === data.selected_party) {
                  item.classList.add("selected");
                } else {
                  item.classList.remove("selected");
                }
              });
              if (data.selected_party) {
                showStatus("voteStatus", `Active voting mode. Selected Party: ${data.selected_party}. Press CONFIRM on STM32 to cast vote. 🔌`, "working");
              }
            }
          }
        } catch (e) {
          console.warn("[EVM] Error polling hardware voting-state:", e);
        }
      }, 500);
    }
  }
}

function updateSampleDots(count, total) {
  const container = document.getElementById("enrollProgressDots");
  if (!container) return;
  container.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const dot = document.createElement("div");
    dot.className = "sample-dot" + (i < count ? " filled" : "");
    container.appendChild(dot);
  }
}

// ================= Developer Hub Logic =================
let activePlatform = "react";

const platformPrompts = {
  wordpress: `I have a WordPress website. Add biometric EVM voting functionality.

Requirements:
- Add voting button to WordPress theme
- Create modal popup for voting
- Include voter registration form (Aadhaar 12 digits, name, email, gender dropdown, DOB with age calc, mobile)
- Include fingerprint enrollment (5 samples, live preview)
- Include voting screen (party selection, vote confirmation)
- Connect to EVM API at [YOUR-API-URL]
- Style to match WordPress theme
- Mobile responsive
- Add error handling and loading indicators

Output:
- PHP plugin code ready to paste
- HTML code for voting button
- CSS styling code
- JavaScript integration code
- Setup instructions (steps only, no explanations)
- Exact file paths where to place code

No explanations. Only code blocks with location markers.`,

  react: `I have a React website. Add biometric EVM voting as components.

Requirements:
- Create EVMVoting component
- Create EVMModal component for modal popup
- Create voting form component (registration, enrollment, voting screens)
- Include Aadhaar input validation (12 digits)
- Include gender dropdown
- Include DOB with automatic age calculation
- Include fingerprint capture simulation
- Include party selection and voting
- Connect to EVM API at [YOUR-API-URL]
- Add loading states and error handling
- Responsive design
- Match React project structure

Output:
- Component files ready to copy-paste
- CSS module for styling
- API hook/service for backend calls
- Parent component integration code
- Import statements
- Installation command if needed
- File paths and locations

No explanations. Only code and file paths.`,

  nextjs: `I have a Next.js website. Add biometric EVM voting functionality.

Requirements:
- Create API route for EVM endpoints
- Create voting page component
- Include voter registration flow
- Include fingerprint enrollment flow
- Include voting flow with party selection
- Forms with Aadhaar (12 digits), gender (dropdown), DOB (auto age calc)
- Modal or page layout
- Connect to EVM backend at [YOUR-API-URL]
- Add loading states
- Mobile responsive
- Error handling

Output:
- API route code (pages/api/evm/[...path].js)
- Page component code (pages/voting.js or pages/vote/index.js)
- Layout modifications if needed
- CSS or Tailwind styling
- Environment variables needed
- Setup instructions

No explanations. Only code blocks.`,

  vue: `I have a Vue.js website. Add biometric EVM voting using Vue components.

Requirements:
- Create EVMVoting.vue component
- Create EVMModal.vue component
- Include registration, enrollment, voting forms
- Aadhaar input (12 digits validation)
- Gender selection dropdown
- DOB with age calculation display
- Fingerprint capture simulation
- Party selection for voting
- Connect to API at [YOUR-API-URL]
- Responsive design
- Loading indicators and error handling

Output:
- Vue component files (ready to copy-paste)
- Scoped CSS styles
- API service code
- Router configuration if needed
- Parent component integration
- File locations
- Setup steps

No explanations. Only code.`,

  angular: `I have an Angular website. Add biometric EVM voting functionality.

Requirements:
- Create EVM voting component with TypeScript
- Create HTML template for forms
- Include registration form (Aadhaar, name, email, gender dropdown, DOB)
- Include enrollment form (fingerprint simulation, 5 samples)
- Include voting form (party selection)
- Aadhaar validation (12 digits)
- Gender dropdown selection
- Age auto-calculation from DOB
- Connect to API at [YOUR-API-URL]
- Add services for API calls
- Add loading states and error handling
- Responsive design

Output:
- Component TypeScript file
- Component HTML template
- Component CSS
- Service file for API
- Module configuration
- Routing setup if needed
- File paths
- Setup instructions

No explanations. Only code blocks.`,

  shopify: `I have a Shopify store. Add biometric EVM voting feature.

Requirements:
- Add voting button to store
- Create modal or page for voting
- Include registration form (Aadhaar, name, email, gender dropdown, DOB)
- Include enrollment flow (fingerprint, samples)
- Include voting interface (party selection)
- Connect to API at [YOUR-API-URL]
- Match Shopify theme styling
- Mobile responsive
- Add loading and error states

Output:
- Liquid template code
- JavaScript code for functionality
- CSS styling
- Exact locations in theme where to add
- Configuration steps
- How to add to navigation

No explanations. Only code ready to paste.`,

  html: `I have a static HTML website. Add biometric EVM voting modal.

Requirements:
- Create voting button
- Create modal popup
- Include all forms: registration, enrollment, voting
- Aadhaar validation (12 digits)
- Gender dropdown
- DOB with age calculation
- Fingerprint capture simulation
- Party selection voting
- Connect to API at [YOUR-API-URL]
- All in vanilla HTML, CSS, JavaScript
- Mobile responsive
- Error handling and loading indicators

Output:
- HTML code for button (copy-paste)
- HTML code for modal (copy-paste)
- CSS code in style tags (copy-paste)
- JavaScript code in script tags (copy-paste)
- Exact locations in HTML file where to place
- External CDN links if any

No explanations. Only code blocks with location markers.`,

  drupal: `I have a Drupal website. Add biometric EVM voting.

Requirements:
- Create Drupal module for voting
- Add voting button to theme
- Create registration form (Aadhaar, name, email, gender dropdown, DOB)
- Create enrollment form (fingerprint)
- Create voting interface (party selection)
- Aadhaar validation (12 digits)
- Gender dropdown
- Auto age calculation from DOB
- Connect to API at [YOUR-API-URL]
- Styling to match Drupal theme
- Mobile responsive

Output:
- Module PHP code
- Theme template files
- CSS code
- JavaScript code
- Hook implementations
- Installation steps

No explanations. Only code.`,

  general: `I have a [YOUR-TECH-STACK] website. Add biometric EVM voting.

Tech: [YOUR-TECH-STACK]
API URL: [YOUR-API-URL]
Integration type: [INTEGRATION-TYPE]

Requirements:
- Add voting button to site
- Create registration form (Aadhaar 12 digits, name, email, gender dropdown, DOB auto age calc, mobile)
- Create enrollment form (fingerprint 5 samples, live preview)
- Create voting interface (party selection, confirmation)
- Connect to EVM API
- Responsive design
- Error handling and loading states
- Match site design

Output:
- All code ready to copy-paste
- File paths and locations
- Setup instructions
- No explanations

Just code. Locations. Setup steps.`,

  modal: `I have a website built with [YOUR-TECH-STACK]. Add EVM voting as a modal popup.

Requirements:
- Add voting button anywhere on site
- Create modal overlay
- Modal includes: registration, enrollment, voting
- Aadhaar input (12 digits validation)
- Gender dropdown selection
- DOB with age calculation
- Fingerprint capture (simulation, 5 samples with preview)
- Party selection for voting
- Vote confirmation
- Connect to API at [YOUR-API-URL]
- Style modal professionally
- Mobile responsive
- Overlay closes on X button or outside click

Output:
- HTML button code
- HTML modal container code
- CSS for modal and styling
- JavaScript for functionality
- Exact HTML locations for each piece
- No explanations

Only code. Location markers. Done.`,

  api: `I have a custom website. I want to use only EVM API endpoints with my own UI.

API URL: [YOUR-API-URL]

Requirements:
- Provide API client code (JavaScript fetch or axios)
- Registration API call code
- Fingerprint enrollment API call code
- Fingerprint verification API call code
- Vote casting API call code
- Statistics retrieval code
- HTML forms (registration, voting)
- JavaScript for form handling
- CSS for forms
- Error handling

Output:
- API client code (ready to paste)
- Form HTML code
- Form handling JavaScript
- API call examples
- Error handling code
- CSS styling

No explanations. Only code blocks.`,

  woocommerce: `I have WooCommerce store. Add voting button on product pages.

Requirements:
- Add voting button to product pages
- Create voting modal
- Include registration form
- Include enrollment (fingerprint simulation)
- Include voting
- Connect to API at [YOUR-API-URL]
- Match WooCommerce styling
- Mobile responsive

Output:
- PHP hook code for functions.php
- Modal HTML/CSS/JS
- Styling to match WooCommerce
- Setup steps

No explanations.`,

  shortcode: `I have WordPress. Add voting using shortcode [evm_voting].

Requirements:
- Create complete plugin
- Add shortcode [evm_voting]
- Plugin includes: registration form, enrollment, voting
- Aadhaar validation (12 digits)
- Gender dropdown
- Age calculation from DOB
- Fingerprint simulation (5 samples)
- Party voting
- Connect to API at [YOUR-API-URL]
- Match WordPress theme
- Responsive

Output:
- Complete plugin code
- File path: wp-content/plugins/evm-voting/evm-voting.php
- Activation instructions
- Shortcode usage: [evm_voting]
- Setup steps

No explanations. Only code.`,

  custom: `I use [YOUR-TECH-STACK]. Add EVM voting integration.

Describe:
- Framework name and version
- Current tech stack
- How your routing works
- How you handle API calls
- Frontend structure

Requirements:
- Voting button integration
- Registration form component
- Fingerprint enrollment component
- Voting component
- All required fields: Aadhaar (12 digits), name, email, gender (dropdown), DOB (auto age), mobile
- Connect to API at [YOUR-API-URL]
- Error handling
- Loading states
- Responsive

Output:
- Integration code in your framework
- Components/modules needed
- API integration code
- Form handling code
- Styling code
- File paths
- Setup instructions

No explanations. Only code for your framework.`
};

const platformCodes = {
  react: `// file: src/components/EVMVoting.jsx
import React, { useState, useEffect } from 'react';
import styles from './EVMVoting.module.css';

export default function EVMVoting({ apiUrl = "[YOUR-API-URL]" }) {
  const [step, setStep] = useState('register'); // register, enroll, vote, success
  const [formData, setFormData] = useState({ name: '', email: '', aadhaar: '', gender: 'Male', dob: '', mobile: '' });
  const [age, setAge] = useState(null);
  const [samples, setSamples] = useState([]);
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (formData.dob) {
      const calculatedAge = new Date().getFullYear() - new Date(formData.dob).getFullYear();
      setAge(calculatedAge);
    }
  }, [formData.dob]);

  const handleInputChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const startEnrollment = async (e) => {
    e.preventDefault();
    setError('');
    if (!/^\\d{12}$/.test(formData.aadhaar)) {
      setError('Aadhaar must be exactly 12 digits');
      return;
    }
    if (age < 18) {
      setError('Voter must be 18 years or older');
      return;
    }
    setStep('enroll');
    captureSamples();
  };

  const captureSamples = async () => {
    setLoading(true);
    let captured = [];
    for (let i = 1; i <= 5; i++) {
      await new Promise(r => setTimeout(r, 800)); // Simulating scan
      captured.push(\`SAMPLE_FP_\${Math.random().toString(36).substr(2, 5)}\`);
      setSamples([...captured]);
    }
    
    try {
      const res = await fetch(\`\${apiUrl}/fingerprint/store\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aadhaar: formData.aadhaar, samples: captured })
      });
      if (res.ok) setStep('vote');
      else setError('Biometric store failed. Try again.');
    } catch {
      // Fallback local registration
      setStep('vote');
    }
    setLoading(false);
  };

  const castVote = async (party) => {
    setLoading(true);
    try {
      const res = await fetch(\`\${apiUrl}/vote\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aadhaar: formData.aadhaar, party })
      });
      if (res.ok) setStep('success');
      else setError('Casting vote failed.');
    } catch {
      setStep('success');
    }
    setLoading(false);
  };

  return (
    <div className={styles.votingContainer}>
      <h2>Biometric EVM Console</h2>
      {error && <div className={styles.error}>{error}</div>}
      
      {step === 'register' && (
        <form onSubmit={startEnrollment}>
          <input type="text" name="name" placeholder="Full Name" onChange={handleInputChange} required />
          <input type="email" name="email" placeholder="Email Address" onChange={handleInputChange} required />
          <input type="text" name="aadhaar" placeholder="12-digit Aadhaar Number" onChange={handleInputChange} required />
          <select name="gender" onChange={handleInputChange} value={formData.gender}>
            <option>Male</option><option>Female</option><option>Other</option>
          </select>
          <input type="date" name="dob" onChange={handleInputChange} required />
          {age !== null && <p>Calculated Age: {age} {age < 18 ? '(Ineligible)' : '(Eligible)'}</p>}
          <button type="submit" className={styles.btn}>Register Voter</button>
        </form>
      )}

      {step === 'enroll' && (
        <div className={styles.biometrics}>
          <h3>Fingerprint Scanner</h3>
          <div className={loading ? styles.scannerPulse : styles.scanner}>👆</div>
          <p>Captured Samples: {samples.length}/5</p>
        </div>
      )}

      {step === 'vote' && (
        <div className={styles.ballot}>
          <h3>Cast Your Vote</h3>
          <button onClick={() => castVote('AB')}>Vote AB Party</button>
          <button onClick={() => castVote('CD')}>Vote CD Party</button>
          <button onClick={() => castVote('NOTA')}>Vote NOTA</button>
        </div>
      )}

      {step === 'success' && (
        <div className={styles.success}>
          <h3>Vote Cast Successfully! ✔</h3>
          <p>Thank you for participating in the secure EVM voting process.</p>
        </div>
      )}
    </div>
  );
}`,

  wordpress: `<?php
/*
Plugin Name: Biometric EVM Voting
Description: WP integration for EVM biometrics
Version: 1.0
Author: SecureEVM
*/

if ( ! defined( 'ABSPATH' ) ) exit;

// Register Shortcode [evm_voting]
add_shortcode('evm_voting', 'evm_voting_handler');

function evm_voting_handler() {
    wp_enqueue_style('evm-style', plugin_dir_url(__FILE__) . 'css/evm.css');
    wp_enqueue_script('evm-script', plugin_dir_url(__FILE__) . 'js/evm.js', array(), '1.0', true);
    wp_localize_script('evm-script', 'evm_config', array(
        'api_url' => '[YOUR-API-URL]'
    ));

    ob_start();
    ?>
    <div id="evm-voting-modal" class="evm-modal">
        <div class="evm-modal-content">
            <span class="evm-close">&times;</span>
            <div id="evm-app">
                <h2>WordPress Biometric EVM</h2>
                <div id="evm-body">
                    <!-- Dynamic rendering in JS -->
                </div>
            </div>
        </div>
    </div>
    <button id="evm-trigger-btn" class="wp-block-button__link">Vote Biometrically</button>
    <?php
    return ob_get_clean();
}`,

  nextjs: `// file: pages/api/evm/vote.js
import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { aadhaar, party } = req.body;
  const API_URL = process.env.EVM_API_URL || '[YOUR-API-URL]';

  try {
    const response = await axios.post(\`\${API_URL}/vote\`, { aadhaar, party });
    return res.status(200).json(response.data);
  } catch (error) {
    return res.status(500).json({ error: 'Voting server unavailable' });
  }
}`,

  vue: `<template>
  <div class="evm-vue-container">
    <h2>Vue Biometric Voting (API: {{ apiUrl }})</h2>
    <div v-if="step === 'register'">
      <input v-model="form.name" placeholder="Name" />
      <input v-model="form.aadhaar" placeholder="12-Digit Aadhaar" />
      <input type="date" v-model="form.dob" />
      <button @click="startEnrollment">Enroll Biometrics</button>
    </div>
    <div v-if="step === 'enroll'" class="enroll-status">
      <p>Enrollment: Scanning Fingerprint...</p>
      <div class="progress">Captured: {{ samples.length }}/5 samples</div>
    </div>
    <div v-if="step === 'ballot'" class="ballot-box">
      <button @click="castVote('AB')">Vote AB</button>
      <button @click="castVote('CD')">Vote CD</button>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    apiUrl: { type: String, default: '[YOUR-API-URL]' }
  },
  data() {
    return {
      step: 'register',
      form: { name: '', aadhaar: '', dob: '' },
      samples: []
    }
  },
  methods: {
    async startEnrollment() {
      this.step = 'enroll';
      for(let i=0; i<5; i++) {
        await new Promise(r => setTimeout(r, 700));
        this.samples.push('SAMPLE_' + i);
      }
      this.step = 'ballot';
    },
    castVote(party) {
      alert('Vote cast successfully to ' + party);
      this.step = 'register';
    }
  }
}
</script>`,

  html: `<!-- Put this in <body> of your index.html -->
<button id="evmOpenBtn" class="evm-btn-trigger">Vote Biometrically</button>

<div id="evmModal" class="evm-modal-overlay" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:9999;">
  <div class="evm-modal-card" style="background:#111622; color:#fff; max-width:500px; margin:10% auto; padding:25px; border-radius:12px; position:relative; border:1px solid #333;">
    <span id="evmClose" style="position:absolute; right:15px; top:10px; cursor:pointer; font-size:24px;">&times;</span>
    <div id="evmModalContent">
      <h3>Secure EVM Terminal</h3>
      <input type="text" id="evmModalAadhaar" placeholder="Enter Aadhaar" style="width:100%; padding:10px; margin:10px 0; background:#222; border:1px solid #444; color:#fff;" />
      <button id="evmScanBtn" style="width:100%; padding:12px; background:#06b6d4; border:none; color:white; font-weight:bold; cursor:pointer;">Scan Fingerprint</button>
      <p id="evmModalStatus" style="margin-top:10px; text-align:center;"></p>
    </div>
  </div>
</div>

<script>
document.getElementById('evmOpenBtn').onclick = () => document.getElementById('evmModal').style.display='block';
document.getElementById('evmClose').onclick = () => document.getElementById('evmModal').style.display='none';

document.getElementById('evmScanBtn').onclick = async () => {
  const status = document.getElementById('evmModalStatus');
  const aadhaar = document.getElementById('evmModalAadhaar').value;
  if (!aadhaar) return alert('Enter Aadhaar');
  
  status.innerText = "Scanning fingerprint...";
  setTimeout(() => {
    status.innerText = "Fingerprint Matched! Vote Cast.";
    status.style.color = "#10b981";
  }, 1500);
};
</script>`
};

// Update the configuration input box changes
window.updateDevHubContent = function () {
  const apiUrlInput = document.getElementById("devApiUrl");
  const techStackInput = document.getElementById("devTechStack");
  const integrationTypeInput = document.getElementById("devIntegrationType");
  const themeInput = document.getElementById("devTheme");

  const apiUrl = apiUrlInput ? apiUrlInput.value.trim() : "http://127.0.0.1:5002";
  const techStack = techStackInput ? techStackInput.value.trim() : "React";
  const integrationType = integrationTypeInput ? integrationTypeInput.value : "Modal";
  const theme = themeInput ? themeInput.value : "Dark";

  // Generate Prompt
  let rawPrompt = platformPrompts[activePlatform] || platformPrompts["react"];
  
  // Substitute tokens
  let processedPrompt = rawPrompt
    .replaceAll("[YOUR-API-URL]", apiUrl)
    .replaceAll("[YOUR-TECH-STACK]", techStack)
    .replaceAll("[INTEGRATION-TYPE]", integrationType)
    .replaceAll("[ANY TECH]", techStack)
    .replaceAll("[DESCRIBE YOUR CUSTOM FRAMEWORK]", techStack);

  const promptBlock = document.getElementById("promptBlock");
  if (promptBlock) promptBlock.textContent = processedPrompt;

  // Generate Code Snippet
  let rawCode = platformCodes[activePlatform] || platformCodes["react"];
  let processedCode = rawCode.replaceAll("[YOUR-API-URL]", apiUrl);

  const codeBlock = document.getElementById("codeBlock");
  if (codeBlock) codeBlock.textContent = processedCode;
};

// Select Platform from Sidebar
window.selectPlatform = function (platformId) {
  activePlatform = platformId;
  document.querySelectorAll(".platform-btn").forEach(btn => btn.classList.remove("active"));
  
  const targetBtn = document.querySelector(`.platform-btn[onclick*="${platformId}"]`);
  if (targetBtn) targetBtn.classList.add("active");

  const techStackInput = document.getElementById("devTechStack");
  if (techStackInput) {
    // autofill default name based on platform
    techStackInput.value = platformId.charAt(0).toUpperCase() + platformId.slice(1);
  }

  updateDevHubContent();
};

// Copy helper
window.copyToClipboard = function (elementId) {
  const element = document.getElementById(elementId);
  if (!element) return;

  const textToCopy = element.textContent;
  navigator.clipboard.writeText(textToCopy).then(() => {
    alert("Copied to clipboard successfully! ✔");
  }).catch(err => {
    console.error("Copy failed", err);
  });
};


// ===============================================================
//  REGISTERED VOTERS TAB — Live Firebase listener
// ===============================================================

let allRegisteredVoters = [];   // full list, used for client-side filtering
let registeredUnsubscribe = null;

function startRegisteredListener() {
  if (!isFirebaseMode) {
    renderRegisteredFromLocal();
    return;
  }
  if (registeredUnsubscribe) return; // already listening live

  const q = query(collection(db, "VoterDB"));
  registeredUnsubscribe = onSnapshot(q, (snapshot) => {
    allRegisteredVoters = [];
    snapshot.forEach(docSnap => {
      allRegisteredVoters.push({ id: docSnap.id, ...docSnap.data() });
    });
    // Sort by registration (use aadhaar id as fallback)
    allRegisteredVoters.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    renderRegisteredTable(allRegisteredVoters);
    updateRegisteredSummary(allRegisteredVoters);

    // Check if the currently verifying voter has voted (e.g. via hardware buttons)
    if (liveScanVerified && verifiedVoterData) {
      const activeAadhaar = verifiedVoterData.id || verifiedVoterData.aadhaar || "";
      const updatedDoc = allRegisteredVoters.find(v => v.id === activeAadhaar);
      if (updatedDoc && updatedDoc.flag === 1) {
        const party = updatedDoc.voted_party || "Unknown";
        showStatus("voteStatus", `Vote Cast Successfully for ${party} (via EVM Button) ✔`, "success");
        
        // Clear states
        liveScanVerified = false;
        verifiedVoterData = null;
        setBallotLocked(true);
        const inputEl = document.getElementById("voteAadhaar");
        if (inputEl) inputEl.value = "";
        const sensorEl = document.getElementById("verifyFpSensor");
        if (sensorEl) sensorEl.className = "fp-sensor";
        const statusEl = document.getElementById("fpLiveStatus");
        if (statusEl) statusEl.innerText = "";
        
        updateStatsDisplay();
      }
    }
  }, (err) => {
    console.error("[EVM] Registered listener error:", err);
    renderRegisteredFromLocal();
  });
}

function renderRegisteredFromLocal() {
  const voters = JSON.parse(localStorage.getItem("evm_voters") || "{}");
  allRegisteredVoters = Object.values(voters);
  renderRegisteredTable(allRegisteredVoters);
  updateRegisteredSummary(allRegisteredVoters);
}

function updateRegisteredSummary(voters) {
  const total    = voters.length;
  const eligible = voters.filter(v => v.age >= 18).length;
  const voted    = voters.filter(v => v.flag === 1).length;
  const pending  = eligible - voted;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
  set("regTotalCount",   total);
  set("regEligibleCount", eligible);
  set("regVotedCount",   voted);
  set("regPendingCount", pending < 0 ? 0 : pending);
}

function maskAadhaar(a) {
  if (!a) return "—";
  const s = String(a);
  return "XXXX-XXXX-" + s.slice(-4);
}

function formatDate(val) {
  if (!val) return "—";
  if (val.toDate) val = val.toDate(); // Firestore Timestamp
  const d = new Date(val);
  if (isNaN(d)) return String(val);
  return d.toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" });
}

function partyBadge(party) {
  if (!party) return `<span class="badge badge-muted">—</span>`;
  const colors = { AB:"badge-primary", CD:"badge-accent", EF:"badge-success", GH:"badge-primary", NOTA:"badge-danger" };
  const cls = colors[party] || "badge-muted";
  return `<span class="badge ${cls}">${party}</span>`;
}

function renderRegisteredTable(voters) {
  const tbody = document.getElementById("registeredTbody");
  if (!tbody) return;

  if (!voters || voters.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="table-empty">No registered voters found.</td></tr>`;
    return;
  }

  tbody.innerHTML = voters.map((v, i) => {
    const eligible = (v.age >= 18);
    const hasVoted = (v.flag === 1);
    return `
      <tr class="new-row">
        <td style="color:var(--text-muted)">${i + 1}</td>
        <td><span class="aadhaar-mask">${maskAadhaar(v.aadhaar || v.id)}</span></td>
        <td><strong>${v.name || "—"}</strong></td>
        <td>${v.age || "—"}</td>
        <td>${v.gender || "—"}</td>
        <td>${v.mobile || "—"}</td>
        <td style="max-width:160px; overflow:hidden; text-overflow:ellipsis;">${v.email || "—"}</td>
        <td>${v.dob || "—"}</td>
        <td>${eligible
          ? `<span class="badge badge-success">✔ Eligible</span>`
          : `<span class="badge badge-danger">✗ Under 18</span>`}</td>
        <td>${hasVoted
          ? `<span class="badge badge-primary">✔ Voted (${v.voted_party || "?"})</span>`
          : `<span class="badge badge-accent">⏳ Pending</span>`}</td>
        <td style="color:var(--text-muted); font-size:0.8rem;">${formatDate(v.registered_at) !== "—" ? formatDate(v.registered_at) : "—"}</td>
      </tr>`;
  }).join("");
}

window.filterRegisteredTable = function () {
  const search = (document.getElementById("regSearch")?.value || "").toLowerCase();
  const filter = document.getElementById("regFilter")?.value || "all";

  let filtered = allRegisteredVoters.filter(v => {
    const matchSearch = !search ||
      (v.name || "").toLowerCase().includes(search) ||
      String(v.aadhaar || v.id || "").includes(search);

    let matchFilter = true;
    if (filter === "eligible") matchFilter = v.age >= 18;
    if (filter === "voted")    matchFilter = v.flag === 1;
    if (filter === "pending")  matchFilter = v.age >= 18 && v.flag !== 1;

    return matchSearch && matchFilter;
  });

  renderRegisteredTable(filtered);
  // Summary always reflects full dataset, not the filtered view
  updateRegisteredSummary(allRegisteredVoters);
};


// ===============================================================
//  COMPLETED VOTES TAB — Live Firebase listener
// ===============================================================

let allVotedVoters = [];
let votedUnsubscribe = null;

function startVotedListener() {
  if (!isFirebaseMode) {
    renderVotedFromLocal();
    return;
  }
  if (votedUnsubscribe) return;

  const q = query(collection(db, "VoterDB"));
  votedUnsubscribe = onSnapshot(q, (snapshot) => {
    allVotedVoters = [];
    snapshot.forEach(docSnap => {
      const d = { id: docSnap.id, ...docSnap.data() };
      if (d.flag === 1) allVotedVoters.push(d);
    });
    // Sort newest first by voted_at
    allVotedVoters.sort((a, b) => {
      const ta = a.voted_at ? new Date(a.voted_at.toDate ? a.voted_at.toDate() : a.voted_at) : 0;
      const tb = b.voted_at ? new Date(b.voted_at.toDate ? b.voted_at.toDate() : b.voted_at) : 0;
      return tb - ta;
    });
    renderVotedTable(allVotedVoters);
    updateVotedSummary(allVotedVoters);
  }, (err) => {
    console.error("[EVM] Voted listener error:", err);
    renderVotedFromLocal();
  });
}

function renderVotedFromLocal() {
  const voters = JSON.parse(localStorage.getItem("evm_voters") || "{}");
  allVotedVoters = Object.values(voters).filter(v => v.flag === 1);
  renderVotedTable(allVotedVoters);
  updateVotedSummary(allVotedVoters);
}

function updateVotedSummary(voters) {
  const total = voters.length;

  // Leading party
  const tally = {};
  voters.forEach(v => { tally[v.voted_party] = (tally[v.voted_party] || 0) + 1; });
  let leader = "—", leaderCount = 0;
  Object.entries(tally).forEach(([p, c]) => { if (c > leaderCount) { leader = p; leaderCount = c; } });

  // Turnout = voted / total registered
  const totalReg = allRegisteredVoters.length || total;
  const turnout = totalReg > 0 ? Math.round((total / totalReg) * 100) : 0;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
  set("votedTotalCount",   total);
  set("votedLeaderParty",  leader);
  set("votedLeaderCount",  leaderCount);
  set("votedTurnout",      turnout + "%");
}

function formatDateTime(val) {
  if (!val) return "—";
  if (val.toDate) val = val.toDate();
  const d = new Date(val);
  if (isNaN(d)) return String(val);
  return d.toLocaleString("en-IN", {
    day:"2-digit", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit", hour12:true
  });
}

function renderVotedTable(voters) {
  const tbody = document.getElementById("votedTbody");
  if (!tbody) return;

  if (!voters || voters.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty">No votes recorded yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = voters.map((v, i) => `
    <tr class="new-row">
      <td style="color:var(--text-muted)">${i + 1}</td>
      <td><span class="aadhaar-mask">${maskAadhaar(v.aadhaar || v.id)}</span></td>
      <td><strong>${v.name || "—"}</strong></td>
      <td>${v.age || "—"}</td>
      <td>${v.gender || "—"}</td>
      <td>${partyBadge(v.voted_party)}</td>
      <td style="color:var(--text-muted); font-size:0.8rem;">${formatDateTime(v.voted_at)}</td>
    </tr>
  `).join("");
}

window.filterVotedTable = function () {
  const search = (document.getElementById("votedSearch")?.value || "").toLowerCase();
  const party  = document.getElementById("votedPartyFilter")?.value || "all";

  let filtered = allVotedVoters.filter(v => {
    const matchSearch = !search ||
      (v.name || "").toLowerCase().includes(search) ||
      String(v.aadhaar || v.id || "").includes(search);
    const matchParty = party === "all" || v.voted_party === party;
    return matchSearch && matchParty;
  });

  renderVotedTable(filtered);
};


// ===============================================================
//  Hook into tab switch to start listeners on first visit
// ===============================================================

const _origSwitchTab = window.switchTab;
window.switchTab = function (tabId) {
  _origSwitchTab(tabId);
  if (tabId === "registered-tab") startRegisteredListener();
  if (tabId === "voted-tab")      { startRegisteredListener(); startVotedListener(); }
};
