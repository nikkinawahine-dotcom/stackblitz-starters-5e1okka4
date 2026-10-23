require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const LOVENSE_TOKEN = process.env.LOVENSE_DEVELOPER_TOKEN;
const LOVENSE_KEY = process.env.LOVENSE_KEY;
const LOVENSE_IV = process.env.LOVENSE_IV;

function publicBase(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

app.get('/', async (req, res) => {
  try {
    const dbTest = await db.query('SELECT NOW()');
    res.send(`Your Bridge Server is online and successfully connected to Neon Database! Time: ${dbTest.rows[0].now}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server is up, but failed to connect to the database. Check your .env file!");
  }
});

// HUD starts pairing: save the SL callback URL, ask Lovense for a QR, return a page the HUD can open.
app.post('/api/hud/register', async (req, res) => {
  const { sl_uuid, sl_http_url, sl_name } = req.body;

  if (!sl_uuid || !sl_http_url) {
    return res.status(400).json({ error: "Missing avatar UUID or HTTP URL data." });
  }

  if (!LOVENSE_TOKEN) {
    return res.status(500).json({ error: "LOVENSE_DEVELOPER_TOKEN is not set on the server." });
  }

  const utoken = crypto.randomBytes(16).toString('hex');

  try {
    await db.query(
      `INSERT INTO active_sessions (sl_uuid, sl_http_url, status, lovense_token)
       VALUES ($1, $2, 'pending', $3)
       ON CONFLICT (sl_uuid) DO UPDATE SET
         sl_http_url = $2,
         status = 'pending',
         lovense_token = $3,
         toys = NULL`,
      [sl_uuid, sl_http_url, utoken]
    );

    const qrResponse = await fetch('https://api.lovense-api.com/api/lan/getQrCode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: LOVENSE_TOKEN,
        uid: sl_uuid,
        uname: sl_name || sl_uuid,
        utoken,
        v: 2
      })
    });

    const qrData = await qrResponse.json();
    if (!qrData.result || !qrData.data || !qrData.data.qr) {
      console.error("Lovense getQrCode failed:", qrData);
      return res.status(502).json({
        error: "Lovense did not return a QR code.",
        details: qrData.message || qrData
      });
    }

    const pairingUrl = `${publicBase(req)}/pair/${encodeURIComponent(sl_uuid)}?qr=${encodeURIComponent(qrData.data.qr)}`;

    return res.json({
      success: true,
      message: "Scan the QR code with Lovense Remote to link your toy.",
      qr: qrData.data.qr,
      pairing_url: pairingUrl
    });
  } catch (err) {
    console.error("Database registration error:", err);
    res.status(500).json({ error: "Server encountered a database error during registration." });
  }
});

// Browser page opened from Second Life so the wearer can scan the QR.
app.get('/pair/:sl_uuid', (req, res) => {
  const slUuid = req.params.sl_uuid;
  const qr = req.query.qr;
  if (!qr) {
    return res.status(400).send("Missing QR image. Ask the HUD to register again.");
  }

  const statusUrl = `/api/hud/status/${encodeURIComponent(slUuid)}`;
  res.type('html').send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link Lovense</title>
  <style>
    body { font-family: sans-serif; background: #111; color: #eee; text-align: center; padding: 24px; }
    img { width: 260px; height: 260px; background: #fff; padding: 12px; border-radius: 8px; }
    #status { margin-top: 16px; font-size: 18px; }
  </style>
</head>
<body>
  <h1>Scan with Lovense Remote</h1>
  <p>Open Lovense Remote, use Scan QR, then wait until this page says connected.</p>
  <img src="${String(qr).replace(/"/g, '')}" alt="Lovense QR code">
  <p id="status">Waiting for scan…</p>
  <script>
    async function poll() {
      try {
        const r = await fetch(${JSON.stringify(statusUrl)});
        const data = await r.json();
        if (data.status === "connected") {
          document.getElementById("status").textContent = "Connected! You can close this tab.";
          return;
        }
      } catch (e) {}
      setTimeout(poll, 2000);
    }
    poll();
  </script>
</body>
</html>`);
});

app.get('/api/hud/status/:sl_uuid', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT status FROM active_sessions WHERE sl_uuid = $1',
      [req.params.sl_uuid]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'unknown' });
    }
    return res.json({ status: result.rows[0].status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Status lookup failed." });
  }
});

// Lovense Remote posts here after the QR is scanned. Set this exact path as Callback URL in the Lovense developer dashboard.
app.post('/api/webhook/lovense', async (req, res) => {
  const { uid, utoken, toys, domain, httpPort, httpsPort, wsPort, wssPort, platform, appType } = req.body;

  try {
    const userCheck = await db.query(
      'SELECT sl_http_url, lovense_token FROM active_sessions WHERE sl_uuid = $1',
      [uid]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).send("User session not found in database.");
    }

    const session = userCheck.rows[0];
    if (utoken && session.lovense_token && utoken !== session.lovense_token) {
      return res.status(403).send("utoken mismatch.");
    }

    const connection = { toys, domain, httpPort, httpsPort, wsPort, wssPort, platform, appType };

    await db.query(
      `UPDATE active_sessions
       SET status = 'connected', toys = $1
       WHERE sl_uuid = $2`,
      [JSON.stringify(connection), uid]
    );

    if (session.sl_http_url) {
      await fetch(session.sl_http_url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: "CONNECTED|Successfully linked your Lovense toy!"
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Lovense Webhook Error:", err);
    res.sendStatus(500);
  }
});

// Vibration is the next step. Left in place but not used for pairing.
app.post('/api/hud/vibrate', async (req, res) => {
  res.status(501).json({ error: "Vibration is not wired up yet. Pairing first." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Database-connected server is listening on port ${PORT}`);
});
