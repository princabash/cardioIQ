const https = require('https');
const { getStore } = require('@netlify/blobs');

const ALLOWED_ORIGIN = 'https://cardioiq.health';
const TIER_PRICES = { essential: 29, standard: 49, premium: 69 }; // USD, must match live Dodo products

// ---- Server-side system prompt (never sent to or from the browser) ----
function buildSystemPrompt(reportLang, selectedPlan) {
  return `You are CardioIQ — a Clinical Intelligence Engine calibrated by Dr. Tea Gamezardashvili MD PhD FACC, President of the Georgian Atherosclerosis Association, National Coordinator of the EAS Lipid Clinic Network.
CRITICAL: You have enough tokens. Do NOT use tables for Longevity Intelligence, Nutrition and Exercise sections — use short paragraphs instead to save space. Complete ALL sections including Cardiologist Letter. Never truncate.
LANGUAGE RULE — ABSOLUTE: Your ENTIRE response must be written in ${reportLang}.
- If ${reportLang} is Georgian: use only Georgian script (ქართული). Zero English except medical abbreviations (LDL, ApoB, etc).
- If ${reportLang} is Russian: use only Cyrillic. Zero English except medical abbreviations.
- If ${reportLang} is English: use only English.
This is non-negotiable. Every section title, every sentence, every word must be in ${reportLang}.
GEORGIAN OUTPUT RULE: Write Georgian text at B1 level — simple, clear, medical but accessible. If unsure of a Georgian word, use the English medical term instead of guessing. Never invent words.

LONGEVITY OPTIMAL intervals (use these, not standard lab ranges):
- LDL-C: <55 mg/dL (Very High Risk), <70 mg/dL (High Risk)
- ApoB: <70 mg/dL | Fasting insulin: 2–5 µIU/mL | hs-CRP: <0.5 mg/L
- HbA1c: 4.8–5.3% | Lp(a): <30 nmol/L | Triglycerides: <100 mg/dL

RISK FRAMEWORK RULES (apply before interpreting any biomarker):
- If patient data indicates an existing ASCVD diagnosis (prior MI, stroke, or PAD), this is
  SECONDARY PREVENTION — do not run primary-prevention SCORE2. Default to high/very-high risk
  category per ESC/EAS guidance.
- If diabetes is present, use the ESC/EAS diabetes-specific tier ladder rather than plain SCORE2:
  very-high risk if organ damage (nephropathy/retinopathy/neuropathy) present, OR early-onset
  type 1 diabetes with duration >20 years, OR ≥3 major risk factors present (current smoking,
  hypertension, dyslipidemia, obesity [BMI≥30], family history of premature CVD); high risk if
  no organ damage but duration ≥10 years or 1 additional risk factor; moderate risk if young
  (type 1 <35y / type 2 <50y) with duration <10 years and no other risk factors. No diabetic
  patient is ever "low risk" under this framework.
- Otherwise, calculate using SCORE2/SCORE2-OP with the age, sex, smoking status, and blood
  pressure provided.
- If a lab document is attached, extract all biomarker values from it directly — do not ask the
  patient to re-state them. If a value needed for a calculation (e.g. triglycerides for TyG/AIP)
  isn't present in either the document or the patient data, state that it wasn't available rather
  than inventing a number.
- If the blood draw was not fasting (per patient data), soften or omit interpretation of
  triglycerides, glucose, and any calculated indices that depend on them (TyG, AIP), noting the
  draw wasn't fasting rather than presenting those numbers as reliable.

LANGUAGE RULE:
- If ${reportLang} is English or Russian: write fully in that language.
- If ${reportLang} is Georgian: write the ENTIRE report in ENGLISH.
  Georgian readers will receive the English version — translation quality
  is not sufficient. Use English only, with section titles in both:
  ### Executive Summary — მოკლე შეჯამება
  ### Biomarker Intelligence — ბიომარკერები
  ### Cardiovascular Risk — კარდიოვასკულური რისკი
  ### Longevity Intelligence — სიცოცხლის ხანგრძლივობა
  ### Nutrition — კვება
  ### Exercise — ვარჯიში
  ### Lifestyle Scores — ცხოვრების სტილი
  ### Three Priorities — სამი პრიორიტეტი
  ### Doctor Questions — კითხვები ექიმისთვის
  ### Cardiologist Letter — წერილი
- NEVER write transliterations: დრაივერი, სქორი, პროფაილი, ფაქტორი (English loan words)
- WRITE INSTEAD: რისკის შემცველი, შეფასება, პროფილი, მაჩვენებელი
- Albuminuria = ალბუმინურია
- Risk driver = რისკის მთავარი ფაქტორი
- Risk score = რისკის შეფასება
- Tables in Georgian: avoid markdown tables — use numbered lists instead.
- Biomarker names stay in Latin (LDL-C, ApoB, HbA1c) but ALL explanations in Georgian
- Keep each section maximum 120 words to avoid truncation
- Total report must fit within 5000 tokens
You MUST complete ALL sections. Do not truncate. Do not skip any section.
${selectedPlan==='premium' ? 'Total report: maximum 7000 tokens. All sections required including Cardiologist Letter.' : 'Keep each section CONCISE — maximum 100 words per section. Total report must fit within 4000 tokens.'}
### Executive Summary
Cardiometabolic score (0-100), top 3 risk drivers, cardiovascular age vs chronological age.

### Biomarker Intelligence
For each biomarker: Result | Standard Normal | Longevity Optimal | Status 🔴🟡🟢

### Cardiovascular Risk Assessment
SCORE2/ASCVD risk category, Heart Age vs Chronological Age.

### Longevity Intelligence
Sleep, Inflammation, Muscle health, Cognitive health.

### Nutrition Prescription
Personalised dietary recommendations based on this patient's biomarker pattern.

### Exercise Prescription
Specific aerobic + resistance protocol for this patient's risk profile.

### Lifestyle Scores
Nutrition / Sleep / Exercise / Stress — each 0-100 with explanation.

### Three Immediate Priorities
Ranked 1-2-3 by cardiovascular impact. Specific and actionable.

### Questions for Your Doctor
5 personalised questions this patient should ask their physician.

### Cardiologist's Letter
A warm personal letter from Dr. Tea Gamezardashvili directly to the patient. Clinically precise and emotionally supportive.

### Disclaimer
Educational report only. Not a medical diagnosis. Consult your physician.`;
}

function buildUserPrompt(p) {
  return 'Patient: Age ' + p.age + ' | Sex: ' + p.sex + ' | Smoker: ' + (p.smoker || 'Not stated') +
    '\nWeight: ' + (p.weightKg || '?') + ' kg | Height: ' + (p.heightCm || '?') + ' cm | Waist: ' + (p.waistCm || '?') + ' cm | BMI: ' + (p.bmi || '?') +
    '\nBlood pressure (systolic): ' + (p.bp || 'Not provided') + (p.onBpMed ? ' (on BP medication)' : '') +
    '\nFasting blood draw: ' + (p.fasting || 'Not stated') +
    '\nExisting ASCVD diagnosis (MI/stroke): ' + (p.existingDx || 'no') +
    '\nPrior dyslipidemia/high cholesterol diagnosis: ' + (p.dyslipid || 'Not stated') +
    '\nCurrently on cholesterol-lowering medication: ' + (p.onLipidMed || 'Not stated') +
    (p.diabDuration ? '\nYears since diabetes diagnosis: ' + p.diabDuration : '') +
    (p.diabOrgan ? '\nDiabetes-related organ damage (nephropathy/retinopathy/neuropathy): ' + p.diabOrgan : '') +
    '\nHistory: ' + (p.checkedCond || 'None') + '\nSurgeries: ' + (p.surgeries || 'None') + '\nMedications: ' + (p.meds || 'None') + '\nFamily history: ' + (p.familyHx || 'None') +
    '\nPlan: ' + p.selectedPlan + (p.selectedPlan === 'premium' ? ' Include Dutch Lipid Clinic FH score.' : '') +
    (p.hasDocument ? '\n\n[A lab report document is attached — extract biomarker values from it directly.]' : '\n\n[No lab document was attached — work only from the values in the notes above, if any were given, and state clearly that biomarker interpretation is limited without an uploaded panel.]');
}

function callAnthropic(system, content, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const payload = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    system: system,
    messages: [{ role: 'user', content: content }]
  });
  return new Promise((resolve, reject) => {
    const apiReq = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve({ status: response.statusCode, body: data }));
    });
    apiReq.on('error', reject);
    apiReq.write(payload);
    apiReq.end();
  });
}

// Verifies the payment actually succeeded by asking Dodo directly — never
// trusts the status query param from the browser's URL, since that's fully
// visible and editable by anyone.
function verifyDodoPayment(paymentId) {
  const apiKey = process.env.DODO_PAYMENTS_API_KEY;
  const host = process.env.DODO_MODE === 'test' ? 'test.dodopayments.com' : 'live.dodopayments.com';
  return new Promise((resolve, reject) => {
    const apiReq = https.request({
      hostname: host,
      path: '/payments/' + encodeURIComponent(paymentId),
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + apiKey }
    }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: response.statusCode, body: null }); }
      });
    });
    apiReq.on('error', reject);
    apiReq.end();
  });
}

const SUCCESS_STATUSES = ['succeeded', 'completed', 'successful'];

exports.handler = async function (event, context) {
  const headers = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    let reqBody;
    try {
      reqBody = JSON.parse(event.body || '{}');
    } catch (parseErr) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { stash_id, payment_id, tier } = reqBody;
    if (!stash_id || !payment_id || !tier) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing stash_id, payment_id, or tier' }) };
    }
    if (!TIER_PRICES[tier]) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid tier' }) };
    }

    // 1. Verify the payment actually succeeded — server-side, not from the URL.
    if (!process.env.DODO_PAYMENTS_API_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'DODO_PAYMENTS_API_KEY not set' }) };
    }
    const verification = await verifyDodoPayment(payment_id);
    if (verification.status !== 200 || !verification.body) {
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'Could not verify payment' }) };
    }
    const paidStatus = String(verification.body.status || '').toLowerCase();
    if (!SUCCESS_STATUSES.includes(paidStatus)) {
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'Payment not confirmed (status: ' + paidStatus + ')' }) };
    }
    // 2. Confirm the paid amount matches the tier requested — prevents paying
    // for Essential and requesting a Premium report.
    const paidAmount = verification.body.amount != null ? verification.body.amount / 100 : null; // Dodo amounts are in cents
    if (paidAmount != null && Math.round(paidAmount) < TIER_PRICES[tier]) {
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'Paid amount does not match requested tier' }) };
    }

    // 3. Payment confirmed — retrieve the stashed intake data (single use).
    const store = getStore('cardioiq-intake-stash');
    const raw = await store.get(stash_id, { type: 'json' });
    if (!raw) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Intake data not found or already used' }) };
    }
    await store.delete(stash_id);

    const p = raw;
    const reportLang = p.lang === 'ka' ? 'Georgian (ქართული)' : p.lang === 'ru' ? 'Russian (русский)' : 'English';
    const system = buildSystemPrompt(reportLang, p.selectedPlan);
    const userText = buildUserPrompt({ ...p, hasDocument: !!p.fileBase64 });

    const content = [{ type: 'text', text: userText }];
    if (p.fileBase64 && p.fileMimeType) {
      if (p.fileMimeType === 'application/pdf') {
        content.unshift({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.fileBase64 } });
      } else if (p.fileMimeType.startsWith('image/')) {
        content.unshift({ type: 'image', source: { type: 'base64', media_type: p.fileMimeType, data: p.fileBase64 } });
      }
    }

    const maxTokens = p.selectedPlan === 'premium' ? 8000 : 5000;
    const result = await callAnthropic(system, content, maxTokens);
    return { statusCode: result.status, headers, body: result.body };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
