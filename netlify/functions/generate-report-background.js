const https = require('https');
const path = require('path');
const fs = require('fs');
const { getStore } = require('@netlify/blobs');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const nodemailer = require('nodemailer');

const ALLOWED_ORIGIN = 'https://cardioiq.health';
const TIER_PRICES = { essential: 29, standard: 49, premium: 69 }; // USD, must match live Dodo products
const FROM_EMAIL = 'info@cardioiq.health';
const TIER_LABELS = { essential: 'Essential', standard: 'Standard', premium: 'Premium' };

// Fonts are bundled alongside this function (see netlify/functions/fonts/).
// StandardFonts (Helvetica) cannot encode Georgian/Cyrillic script or emoji —
// Noto Sans Georgian covers Latin + Georgian + Cyrillic in one font, so the
// same pair (regular/bold) works for all three report languages.
const FONT_REGULAR_PATH = path.join(__dirname, 'fonts', 'NotoSansGeorgian.ttf');
const FONT_BOLD_PATH = path.join(__dirname, 'fonts', 'NotoSansGeorgian-Bold.ttf');

// The system prompt asks Claude for 🔴🟡🟢 status markers, but no bundled
// font reliably covers emoji glyphs — swap them for plain-text equivalents
// before layout rather than risk a WinAnsi/glyph-coverage crash mid-render.
function sanitizeForPdf(text) {
  return text
    .replace(/🔴/g, '[High]')
    .replace(/🟡/g, '[Moderate]')
    .replace(/🟢/g, '[Good]')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ''); // strip any other stray emoji
}

// ---- Server-side system prompt (never sent to or from the browser) ----
function buildSystemPrompt(selectedPlan) {
  return `You are CardioIQ — a Clinical Intelligence Engine calibrated by Dr. Tea Gamezardashvili MD PhD FACC, President of the Georgian Atherosclerosis Association, National Coordinator of the EAS Lipid Clinic Network.
CRITICAL: You have enough tokens. Do NOT use tables for Longevity Intelligence, Nutrition and Exercise sections — use short paragraphs instead to save space. Complete ALL sections including Cardiologist Letter. Never truncate.
LANGUAGE: Write the entire report in English. Every section title, every sentence, every word must be in English.

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
    (p.notes ? '\n\nPatient-entered lab values / notes (manually typed, no document uploaded):\n' + p.notes : '') +
    (p.hasDocument
      ? '\n\n[A lab report document is attached — extract biomarker values from it directly.]'
      : (p.notes
          ? '\n\n[No lab document was attached — use the patient-entered notes above as the source for biomarker values.]'
          : '\n\n[No lab document or notes were provided — state clearly that biomarker interpretation is limited without lab values.]'));
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

// ---- PDF generation (pdf-lib — no headless-browser dependency, safe for ----
// ---- serverless functions) --------------------------------------------
// Parses the ### section-header markdown the system prompt asks Claude to
// produce and lays it out as a simple, clean multi-page A4 report. Inline
// markdown emphasis (**bold**) is stripped rather than rendered, to keep the
// layout logic simple and robust — a deliberate v1 simplification.
async function buildReportPdf(reportText, meta) {
  const PAGE_W = 595.28, PAGE_H = 841.89; // A4 in points
  const MARGIN = 54;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(FONT_REGULAR_PATH));
  const bold = await doc.embedFont(fs.readFileSync(FONT_BOLD_PATH));
  reportText = sanitizeForPdf(reportText);

  const navy = rgb(0x0B / 255, 0x1F / 255, 0x3A / 255);
  const teal = rgb(0x1A / 255, 0x6B / 255, 0x72 / 255);
  const body = rgb(0.14, 0.16, 0.19);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  function newPageIfNeeded(nextLineHeight) {
    if (y - nextLineHeight < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  }

  function wrapLine(text, useFont, size) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
      const trial = current ? current + ' ' + word : word;
      if (useFont.widthOfTextAtSize(trial, size) > CONTENT_W && current) {
        lines.push(current);
        current = word;
      } else {
        current = trial;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  function drawParagraph(text, { size = 10.5, useFont = font, color = body, lineGap = 5, spaceBefore = 0, spaceAfter = 10 } = {}) {
    if (!text.trim()) return;
    y -= spaceBefore;
    const lineHeight = size + lineGap;
    const lines = wrapLine(text.trim(), useFont, size);
    for (const line of lines) {
      newPageIfNeeded(lineHeight);
      page.drawText(line, { x: MARGIN, y, size, font: useFont, color });
      y -= lineHeight;
    }
    y -= spaceAfter;
  }

  // ---- Header block ----
  page.drawText('CardioIQ', { x: MARGIN, y, size: 20, font: bold, color: navy });
  y -= 26;
  page.drawText('Clinical Intelligence Report — ' + (TIER_LABELS[meta.tier] || meta.tier), {
    x: MARGIN, y, size: 11, font, color: teal
  });
  y -= 18;
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  page.drawText('Prepared ' + dateStr + (meta.age ? ' · Age ' + meta.age : '') + (meta.sex ? ' · ' + meta.sex : ''), {
    x: MARGIN, y, size: 9.5, font, color: rgb(0.4, 0.45, 0.5)
  });
  y -= 22;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: rgb(0.85, 0.85, 0.82) });
  y -= 22;

  // ---- Body: parse ### headers vs paragraphs, strip markdown emphasis ----
  const rawLines = reportText.replace(/\r\n/g, '\n').split('\n');
  let paragraphBuffer = '';
  function flushParagraph() {
    if (paragraphBuffer.trim()) {
      const clean = paragraphBuffer.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');
      drawParagraph(clean, { size: 10.5, useFont: font, color: body, spaceAfter: 10 });
    }
    paragraphBuffer = '';
  }

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (line.startsWith('### ')) {
      flushParagraph();
      newPageIfNeeded(26);
      y -= 6;
      const headerText = line.replace(/^###\s*/, '').replace(/\*\*/g, '');
      drawParagraph(headerText, { size: 13, useFont: bold, color: navy, spaceBefore: 4, spaceAfter: 8 });
    } else if (line === '') {
      flushParagraph();
    } else {
      paragraphBuffer += (paragraphBuffer ? ' ' : '') + line;
    }
  }
  flushParagraph();

  // ---- Footer disclaimer on every page ----
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText('Educational interpretation, not a medical diagnosis. Consult your physician. · Page ' + (i + 1) + '/' + pages.length, {
      x: MARGIN, y: 30, size: 8, font, color: rgb(0.55, 0.58, 0.6)
    });
  });

  return doc.save(); // Uint8Array
}

// ---- Email delivery (Zoho Mail SMTP via nodemailer + App Password) ----
// info@cardioiq.health is hosted on Zoho Mail (mail.zoho.eu), not Google
// Workspace — EU data-center host, per Zoho's regional SMTP endpoints.
function buildTransport() {
  return nodemailer.createTransport({
    host: 'smtp.zoho.eu',
    port: 465,
    secure: true,
    auth: {
      user: FROM_EMAIL,
      pass: process.env.ZOHO_APP_PASSWORD
    }
  });
}

async function sendReportEmail(toEmail, pdfBytes, tier) {
  const transporter = buildTransport();
  const tierLabel = TIER_LABELS[tier] || tier;
  await transporter.sendMail({
    from: 'CardioIQ <' + FROM_EMAIL + '>',
    to: toEmail,
    subject: 'Your CardioIQ ' + tierLabel + ' Report is ready',
    text:
      'Your CardioIQ report is attached as a PDF.\n\n' +
      'This is an educational interpretation of your lab values, not a medical diagnosis — ' +
      'built to inform the conversation with your physician, never to replace it.\n\n' +
      'Questions? Reply to this email or reach us at info@cardioiq.health.\n\n' +
      '— Dr. Tea Gamezardashvili, MD, PhD, MHA, FACC',
    attachments: [
      { filename: 'CardioIQ-' + tierLabel + '-Report.pdf', content: Buffer.from(pdfBytes), contentType: 'application/pdf' }
    ]
  });
}

// Background functions return an empty 202 to the browser immediately — the
// caller never sees whatever this handler returns. Without this, a failed
// generation/PDF/email step would fail silently with only a log entry to
// notice it (exactly the failure mode that started this whole investigation).
// So on any failure path, alert Tea directly instead of just returning JSON.
// Debug logging goes to Netlify Blobs — NOT email — because email delivery
// itself is one of the things that can be broken (Zoho SMTP misconfig, etc).
// If email were the only channel, a broken SMTP config would silently lose
// its own failure reports, which is exactly the blind spot we hit once
// already in this project. Blobs is confirmed working independently.
async function logDebug(stage, detail, context) {
  try {
    const store = getStore({
      name: 'cardioiq-debug-log',
      siteID: process.env.BLOBS_SITE_ID,
      token: process.env.BLOBS_TOKEN
    });
    const key = new Date().toISOString() + '_' + (context.payment_id || 'unknown');
    await store.set(key, JSON.stringify({ stage, detail, context, time: new Date().toISOString() }));
  } catch (e) {
    // If even Blobs logging fails, there's genuinely nothing left to fall
    // back on inside this function — console.error is the last resort.
    console.error('logDebug itself failed:', e.message);
  }
}

async function alertFailure(stage, detail, context) {
  await logDebug(stage, detail, context);
  try {
    const transporter = buildTransport();
    await transporter.sendMail({
      from: 'CardioIQ Alerts <' + FROM_EMAIL + '>',
      to: FROM_EMAIL,
      subject: '⚠ CardioIQ report delivery failed — ' + stage,
      text:
        'Stage: ' + stage + '\n' +
        'Detail: ' + detail + '\n' +
        'Payment ID: ' + (context.payment_id || 'unknown') + '\n' +
        'Tier: ' + (context.tier || 'unknown') + '\n' +
        'Customer email: ' + (context.email || 'unknown') + '\n' +
        'Stash ID: ' + (context.stash_id || 'unknown') + ' (left intact for retry — not yet deleted)\n' +
        'Time: ' + new Date().toISOString()
    });
  } catch (alertErr) {
    // If even the alert email fails (e.g. SMTP itself is down), there's
    // nothing left to do but let the function logs be the last resort.
    console.error('Failed to send failure alert:', alertErr.message);
  }
}

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
    await logDebug('started', 'Handler invoked', { payment_id, tier, stash_id });
    if (!process.env.DODO_PAYMENTS_API_KEY) {
      await alertFailure('config', 'DODO_PAYMENTS_API_KEY not set', { payment_id, tier, stash_id });
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'DODO_PAYMENTS_API_KEY not set' }) };
    }
    const verification = await verifyDodoPayment(payment_id);
    if (verification.status !== 200 || !verification.body) {
      await alertFailure('payment verification', 'Could not verify payment (status ' + verification.status + ')', { payment_id, tier, stash_id });
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'Could not verify payment' }) };
    }
    const paidStatus = String(verification.body.status || '').toLowerCase();
    if (!SUCCESS_STATUSES.includes(paidStatus)) {
      // Not necessarily an error — customer may have abandoned checkout.
      // No alert needed here; this is an expected non-payment path.
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'Payment not confirmed (status: ' + paidStatus + ')' }) };
    }
    // 2. Confirm the paid amount matches the tier requested — prevents paying
    // for Essential and requesting a Premium report.
    // NOTE: confirmed with Dodo — verification.body.amount is always in USD
    // cents regardless of what a dashboard UI may display in local currency
    // (e.g. GEL) for a given card. There is no separate `currency` field to
    // cross-check, so this comparison against the static USD TIER_PRICES is
    // correct as-is.
    const paidAmount = verification.body.amount != null ? verification.body.amount / 100 : null; // Dodo amounts are in cents
    if (paidAmount != null && Math.round(paidAmount) < TIER_PRICES[tier]) {
      await alertFailure('amount mismatch', 'Paid ' + paidAmount + ' for tier ' + tier + ' (expected >= ' + TIER_PRICES[tier] + ')', { payment_id, tier, stash_id });
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'Paid amount does not match requested tier' }) };
    }

    // 3. Payment confirmed — retrieve the stashed intake data.
    // NOTE: deletion is deferred until AFTER the email successfully sends —
    // deleting it here would mean any downstream failure (Claude, PDF, SMTP)
    // permanently loses the customer's intake data with no way to retry.
    // Explicit siteID/token instead of relying on auto-injection — works
    // around Netlify's known MissingBlobsEnvironmentError, which several
    // sites hit even with otherwise-correct usage inside the handler.
    const store = getStore({
      name: 'cardioiq-intake-stash',
      siteID: process.env.BLOBS_SITE_ID,
      token: process.env.BLOBS_TOKEN
    });
    const raw = await store.get(stash_id, { type: 'json' });
    if (!raw) {
      await alertFailure('stash lookup', 'Payment succeeded but intake data not found (already used or expired)', { payment_id, tier, stash_id });
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Intake data not found or already used' }) };
    }

    const p = raw;
    await logDebug('checkpoint', 'Stash retrieved, email=' + (p.email || 'MISSING'), { payment_id, tier, stash_id });
    if (!p.email) {
      await alertFailure('missing email', 'Payment succeeded but stashed intake has no email address', { payment_id, tier, stash_id });
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No email address in stashed intake data' }) };
    }
    const system = buildSystemPrompt(p.selectedPlan);
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
    await logDebug('checkpoint', 'Payment verified, calling Claude', { payment_id, tier, stash_id, email: p.email });
    const result = await callAnthropic(system, content, maxTokens);

    if (result.status !== 200) {
      // Claude call failed — stash stays intact, safe to retry this same request later.
      await alertFailure('report generation', 'Claude API returned status ' + result.status + ': ' + result.body, { payment_id, tier, stash_id, email: p.email });
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Report generation failed', detail: result.body }) };
    }

    let reportText;
    try {
      const parsed = JSON.parse(result.body);
      reportText = (parsed.content || []).map(block => block.text || '').join('\n');
      if (!reportText.trim()) throw new Error('Empty report text');
    } catch (e) {
      await alertFailure('parsing report', e.message, { payment_id, tier, stash_id, email: p.email });
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not parse report content', detail: e.message }) };
    }
    await logDebug('checkpoint', 'Report text received (' + reportText.length + ' chars), building PDF', { payment_id, tier, stash_id, email: p.email });

    let pdfBytes;
    try {
      pdfBytes = await buildReportPdf(reportText, { tier, age: p.age, sex: p.sex });
    } catch (e) {
      await alertFailure('PDF generation', e.message, { payment_id, tier, stash_id, email: p.email });
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'PDF generation failed', detail: e.message }) };
    }
    await logDebug('checkpoint', 'PDF built (' + pdfBytes.length + ' bytes), sending email', { payment_id, tier, stash_id, email: p.email });

    try {
      await sendReportEmail(p.email, pdfBytes, tier);
    } catch (e) {
      // Email failed — stash stays intact so this can be retried without
      // re-charging the customer or losing their intake data.
      await alertFailure('email delivery', e.message, { payment_id, tier, stash_id, email: p.email });
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Email delivery failed', detail: e.message }) };
    }
    await logDebug('success', 'Email sent successfully', { payment_id, tier, stash_id, email: p.email });

    // Only now that the email is confirmed sent do we consume the stash.
    await store.delete(stash_id);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, sent_to: p.email }) };

  } catch (err) {
    await alertFailure('unexpected error', err.message, { payment_id: (typeof payment_id !== 'undefined' ? payment_id : null), tier: (typeof tier !== 'undefined' ? tier : null) });
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
