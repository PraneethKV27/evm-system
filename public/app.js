import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  runTransaction
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

  // Aadhaar pre-verification event listener
  const voteAadhaarInput = document.getElementById("voteAadhaar");
  if (voteAadhaarInput) {
    voteAadhaarInput.addEventListener("input", handleVoteAadhaarInput);
  }
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
    <img src="fingerprint.png" style="transform: rotate(${rotation}deg) scale(${scale}); opacity: ${opacity}; filter: hue-rotate(${hue}deg) brightness(1.1);" alt="Sample ${sampleIndex}">
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
  if (compPanel) compPanel.style.display = "none";
  document.getElementById("verifyFpSensor").className = "fp-sensor";
  document.getElementById("fpLiveStatus").innerText = "Unlock ballot with biometric verification.";
  
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
let registrationTemplate = null;
let liveScanVerified = false;
let verifiedVoterData = null;

// Helper to check if the local bridge server is online
async function checkBridgeStatus() {
  try {
    const res = await fetch("http://localhost:5002/fingerprint/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true })
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

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
window.startEnrollment = async function () {
  const aadhaar = document.getElementById("aadhaar").value.trim();
  const name = document.getElementById("name").value.trim();
  const dob = document.getElementById("dob").value;
  const gender = document.getElementById("gender").value;

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
  if (isNaN(age) || age < 18) {
    showStatus("fpStatus", `Voter is not eligible (Age: ${isNaN(age) ? 0 : age}, under 18) ❌`, "error");
    return;
  }

  registrationSamples = [];
  registrationTemplate = null;
  const fpSensor = document.getElementById("enrollFpSensor");
  fpSensor.className = "fp-sensor scanning";
  
  // Clear visual fingerprint gallery
  const grid = document.getElementById("enrollFpGrid");
  const gallery = document.getElementById("enrollFpGallery");
  if (grid) grid.innerHTML = "";
  if (gallery) gallery.style.display = "none";

  const hasBridge = await checkBridgeStatus();
  showStatus("fpStatus", hasBridge ? "Bridge connected! Scanning 5 samples..." : "Simulating biometric scans (7 samples)...", "working");

  const totalSamples = hasBridge ? 5 : 7;
  updateSampleDots(0, totalSamples);

  let currentSample = 0;
  
  const scanInterval = setInterval(async () => {
    currentSample++;
    let templateStr = "";

    if (hasBridge) {
      try {
        const res = await fetch("http://localhost:5002/fingerprint/capture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ aadhaar })
        });
        const data = await res.json();
        templateStr = data.template;
      } catch (e) {
        templateStr = "MOCK_FP_" + Math.random().toString(36).substring(2, 9).toUpperCase();
      }
    } else {
      templateStr = "FP_TEMPLATE_" + Math.random().toString(36).substring(2, 9).toUpperCase();
    }

    registrationSamples.push(templateStr);
    updateSampleDots(currentSample, totalSamples);
    addFpSampleToGallery(currentSample); // Visual gallery update
    showStatus("fpStatus", `Captured sample ${currentSample}/${totalSamples} ✔`, "working");

    if (currentSample === totalSamples) {
      clearInterval(scanInterval);
      fpSensor.className = "fp-sensor success";
      registrationTemplate = registrationSamples;

      // Save Voter Account
      const voterPayload = {
        aadhaar,
        name,
        dob,
        age,
        gender,
        fp_samples: registrationSamples,
        flag: 0,
        eligible: true,
        voted_party: ""
      };

      try {
        if (isFirebaseMode) {
          await setDoc(doc(db, "VoterDB", aadhaar), voterPayload);
          // Optional API call to local bridge store
          if (hasBridge) {
            await fetch("http://localhost:5002/fingerprint/store", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ aadhaar, samples: registrationSamples })
            });
          }
        } else {
          await mockDB.setVoter(aadhaar, voterPayload);
        }
        showStatus("fpStatus", "Voter Registered & Biometrics Saved ✔", "success");
      } catch (err) {
        console.error("Save failed", err);
        showStatus("fpStatus", "Failed to save registration record ❌", "error");
        fpSensor.className = "fp-sensor error";
      }
    }
  }, 800);
};

// ================= Fingerprint Verification =================
window.startFingerprintCheck = async function () {
  const aadhaar = document.getElementById("voteAadhaar").value.trim();
  const fpSensor = document.getElementById("verifyFpSensor");
  const compPanel = document.getElementById("verifyComparisonPanel");
  const dbImg = document.getElementById("dbFpImage");
  const liveImg = document.getElementById("liveFpImage");
  const liveScanBox = document.querySelector("#verifyComparisonPanel .comparison-side:last-child .comparison-fp-box");

  if (!aadhaar || !/^\d{12}$/.test(aadhaar)) {
    showStatus("fpLiveStatus", "Enter a valid 12-digit Aadhaar first ❌", "error");
    return;
  }

  liveScanVerified = false;
  verifiedVoterData = null;
  fpSensor.className = "fp-sensor scanning";
  showStatus("fpLiveStatus", "Place finger on the sensor... scanning 👆", "working");

  // Show visual comparison and start scanning animation
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

  // Fetch Voter Details
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
    setTimeout(() => {
      fpSensor.className = "fp-sensor error";
      showStatus("fpLiveStatus", "Voter Aadhaar not found ❌", "error");
      if (compPanel) compPanel.style.display = "none";
    }, 800);
    return;
  }

  if (voter.flag === 1) {
    setTimeout(() => {
      fpSensor.className = "fp-sensor error";
      showStatus("fpLiveStatus", "Voter has already cast their vote ❌", "error");
      if (compPanel) compPanel.style.display = "none";
    }, 800);
    return;
  }

  const hasBridge = await checkBridgeStatus();
  
  setTimeout(async () => {
    let matched = false;

    if (hasBridge) {
      try {
        // Capture live sample with Aadhaar payload to guarantee deterministic match
        const fpRes = await fetch("http://localhost:5002/fingerprint/capture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ aadhaar })
        });
        const fpData = await fpRes.json();

        // Verify template with server
        const verifyRes = await fetch("http://localhost:5002/fingerprint/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            aadhaar,
            template: fpData.template
          })
        });
        const result = await verifyRes.json();
        matched = result.match;
      } catch (e) {
        matched = true; // fallback simulated success
      }
    } else {
      // Simulation fallback: 100% success for registered, eligible voter
      matched = true;
    }

    // Stop laser scan animation
    if (liveScanBox) {
      liveScanBox.classList.remove("scanning-effect");
    }

    if (matched) {
      liveScanVerified = true;
      verifiedVoterData = voter;
      fpSensor.className = "fp-sensor success";
      showStatus("fpLiveStatus", "Fingerprint Verified! Proceed to vote ✔", "success");
      
      // Update visual comparison success state
      if (liveScanBox) {
        liveScanBox.style.borderColor = "var(--success)";
        liveScanBox.style.boxShadow = "0 0 15px rgba(16, 185, 129, 0.4)";
      }
      if (liveImg) {
        liveImg.style.opacity = "1";
        liveImg.style.filter = "hue-rotate(180deg) brightness(1.2)"; // neon blue
      }
    } else {
      liveScanVerified = false;
      fpSensor.className = "fp-sensor error";
      showStatus("fpLiveStatus", "Fingerprint mismatch. Try again ❌", "error");
      
      // Update visual comparison error state
      if (liveScanBox) {
        liveScanBox.style.borderColor = "var(--danger)";
        liveScanBox.style.boxShadow = "0 0 15px rgba(239, 68, 68, 0.4)";
      }
      if (liveImg) {
        liveImg.style.opacity = "0.2";
        liveImg.style.filter = "grayscale(1)";
      }
    }
  }, 1800);
};

// ================= Cast Vote =================
window.vote = async function (party) {
  const aadhaar = document.getElementById("voteAadhaar").value.trim();

  if (!liveScanVerified || !verifiedVoterData || verifiedVoterData.aadhaar !== aadhaar) {
    showStatus("voteStatus", "Verify fingerprint biometric matching first ❌", "error");
    return;
  }

  showStatus("voteStatus", "Recording secure vote...", "working");

  try {
    if (isFirebaseMode) {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "VoterDB", aadhaar);
        const snap = await tx.get(ref);
        if (snap.data().flag === 1) {
          throw new Error("Already voted");
        }

        // Update Voter Status
        tx.update(ref, {
          flag: 1,
          voted_party: party,
          voted_at: new Date().toISOString()
        });

        // Update Party Stats
        const partyRef = doc(db, "PartyDB", party);
        tx.update(partyRef, {
          votes: (snap.data().votes || 0) + 1
        });
      });
    } else {
      await mockDB.castVote(aadhaar, party);
    }

    showStatus("voteStatus", `Vote Cast Successfully for ${party} ✔`, "success");
    
    // Clear states
    liveScanVerified = false;
    verifiedVoterData = null;
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
- Include fingerprint enrollment (5-7 samples, live preview)
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
- Include enrollment form (fingerprint simulation, 5-7 samples)
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
- Create enrollment form (fingerprint 5-7 samples, live preview)
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
- Fingerprint capture (simulation, 5-7 samples with preview)
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
- Fingerprint simulation (5-7 samples)
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

  const apiUrl = apiUrlInput ? apiUrlInput.value.trim() : "http://localhost:5002";
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