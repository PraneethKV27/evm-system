const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// ===============================
// In-memory fingerprint database
// ===============================
const fingerprintDB = {};

/* ===============================
   CAPTURE FINGERPRINT (SIMULATED)
=============================== */
app.post("/fingerprint/capture", (req, res) => {
  const { aadhaar } = req.body || {};
  let template;

  if (aadhaar && fingerprintDB[aadhaar] && fingerprintDB[aadhaar].length > 0) {
    // Return first stored template to simulate matching scan
    template = fingerprintDB[aadhaar][0];
  } else {
    template = "FP_" + Math.random().toString(36).substring(2, 10);
  }

  res.json({ template });
});

/* ===============================
   STORE FINGERPRINT (REGISTRATION)
=============================== */
app.post("/fingerprint/store", (req, res) => {

  const { aadhaar, samples } = req.body;

  if (!aadhaar || !samples) {
    return res.json({ success: false });
  }

  fingerprintDB[aadhaar] = samples;

  res.json({
    success: true,
    message: "Fingerprint stored"
  });
});

/* ===============================
   VERIFY FINGERPRINT (VOTING)
=============================== */
app.post("/fingerprint/verify", (req, res) => {

  const { aadhaar, template } = req.body;

  const storedSamples = fingerprintDB[aadhaar];

  if (!storedSamples) {
    return res.json({ match: false });
  }

  // Check if template is one of the stored samples or has simulated prefixes
  const match = storedSamples.includes(template) || template.startsWith("FP_") || template.startsWith("MOCK_FP_");

  res.json({ match });
});

/* =============================== */
app.listen(5002, () => {
  console.log("Fingerprint server running on port 5002");
});