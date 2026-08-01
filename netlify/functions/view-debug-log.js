const { getStore } = require('@netlify/blobs');

// Simple diagnostic viewer for the debug log written by
// generate-report-background.js. Visit this URL directly in a browser:
//   https://cardioiq.health/.netlify/functions/view-debug-log
// Optional: ?key=SECRET query param if DEBUG_LOG_KEY env var is set, to
// keep this from being wide open to the public (it can reveal customer
// emails and payment IDs).
exports.handler = async function (event) {
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };

  const requiredKey = process.env.DEBUG_LOG_KEY;
  if (requiredKey) {
    const params = new URLSearchParams(event.queryStringParameters || {});
    if (params.get('key') !== requiredKey) {
      return { statusCode: 403, headers, body: '<p>Forbidden — missing or wrong ?key=</p>' };
    }
  }

  try {
    const store = getStore({
      name: 'cardioiq-debug-log',
      siteID: process.env.BLOBS_SITE_ID,
      token: process.env.BLOBS_TOKEN
    });

    const { blobs } = await store.list();
    // Keys are ISO-timestamp-prefixed, so lexical sort = chronological sort.
    const sorted = blobs.map(b => b.key).sort().reverse().slice(0, 100);

    const entries = await Promise.all(sorted.map(async key => {
      try {
        const raw = await store.get(key, { type: 'json' });
        return { key, ...raw };
      } catch (e) {
        return { key, stage: 'READ_ERROR', detail: e.message };
      }
    }));

    const rows = entries.map(e => `
      <tr>
        <td>${e.time || ''}</td>
        <td><b>${e.stage || ''}</b></td>
        <td>${(e.detail || '').toString().slice(0, 300)}</td>
        <td>${e.context ? (e.context.payment_id || '') : ''}</td>
        <td>${e.context ? (e.context.email || '') : ''}</td>
      </tr>
    `).join('');

    const html = `
      <html><head><title>CardioIQ Debug Log</title>
      <style>
        body{font-family:monospace;padding:20px;background:#111;color:#eee;}
        table{border-collapse:collapse;width:100%;}
        td,th{border:1px solid #444;padding:6px 10px;text-align:left;font-size:13px;vertical-align:top;}
        th{background:#222;}
      </style></head><body>
      <h2>CardioIQ Debug Log (most recent ${entries.length} entries)</h2>
      <table>
        <tr><th>Time</th><th>Stage</th><th>Detail</th><th>Payment ID</th><th>Email</th></tr>
        ${rows || '<tr><td colspan="5">No entries yet.</td></tr>'}
      </table>
      </body></html>
    `;

    return { statusCode: 200, headers, body: html };
  } catch (err) {
    return { statusCode: 500, headers, body: '<p>Error reading debug log: ' + err.message + '</p>' };
  }
};
