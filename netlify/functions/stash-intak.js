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
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const p = req.body;
    if (!p || !p.age || !p.sex) return res.status(400).json({ error: 'Missing required patient data' });

    if (p.fileBase64 && Buffer.byteLength(p.fileBase64, 'base64') > MAX_FILE_BYTES) {
      return res.status(400).json({ error: 'File too large' });
    }

    const stashId = crypto.randomUUID();
    const store = getStore('cardioiq-intake-stash');

    await store.set(stashId, JSON.stringify({
      ...p,
      createdAt: new Date().toISOString()
    }));

    return res.status(200).json({ stash_id: stashId });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
