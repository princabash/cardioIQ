const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const ALLOWED_ORIGIN = 'https://cardioiq.health';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB, matches client upload limit

// Stashes the intake form (structured fields + uploaded file) BEFORE checkout,
// so the data survives Dodo's redirect round-trip regardless of what happens
// to the browser tab. Returns a short-lived reference ID that rides along in
// the Dodo redirect_url — never the data itself.
//
// This does NOT generate a report and does NOT call the Anthropic API — it
// only stores data. Nothing here costs API spend, so it's safe to call before
// payment is confirmed.
//
// NOTE: Netlify Functions use the (event, context) -> { statusCode, headers, body }
// contract, NOT the Express/Vercel (req, res) contract. Mixing the two causes
// a 502 at invocation time before any of this code even runs.
exports.handler = async function (event) {
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
    let p;
    try {
      p = JSON.parse(event.body || '{}');
    } catch (parseErr) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    if (!p || !p.age || !p.sex) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required patient data' }) };
    }

    if (p.fileBase64 && Buffer.byteLength(p.fileBase64, 'base64') > MAX_FILE_BYTES) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'File too large' }) };
    }

    const stashId = crypto.randomUUID();
    const store = getStore('cardioiq-intake-stash');

    await store.set(stashId, JSON.stringify({
      ...p,
      createdAt: new Date().toISOString()
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ stash_id: stashId }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
