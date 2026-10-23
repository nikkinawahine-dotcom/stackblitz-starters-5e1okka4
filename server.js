require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.get('/logo.png', (req, res) => {
  const nested = path.join(__dirname, 'public', 'logo.png');
  const root = path.join(__dirname, 'logo.png');
  res.sendFile(fs.existsSync(nested) ? nested : root);
});

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const LOVENSE_TOKEN = process.env.LOVENSE_DEVELOPER_TOKEN;
const PLATFORM_NAME = process.env.LOVENSE_PLATFORM_NAME || 'HotHawaiianNights';

function publicBase(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

function parseConnection(rowToys) {
  if (!rowToys) return null;
  if (typeof rowToys === 'string') {
    try {
      return JSON.parse(rowToys);
    } catch (err) {
      return null;
    }
  }
  return rowToys;
}

function listToys(connection) {
  if (!connection || !connection.toys) return [];
  let toys = connection.toys;
  if (typeof toys === 'string') {
    try {
      toys = JSON.parse(toys);
    } catch (err) {
      return [];
    }
  }
  return Object.values(toys).map((toy) => ({
    id: toy.id,
    type: toy.name || 'toy',
    name: toy.nickName || toy.name || toy.id,
    status: toy.status
  }));
}

async function sendLovenseCommand(uid, payload) {
  const response = await fetch('https://api.lovense-api.com/api/lan/v2/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: LOVENSE_TOKEN,
      uid,
      ...payload
    })
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    return { code: response.status, message: text };
  }
}

async function getSession(slUuid) {
  const result = await db.query(
    'SELECT sl_uuid, sl_http_url, status, toys FROM active_sessions WHERE sl_uuid = $1',
    [slUuid]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    ...row,
    connection: parseConnection(row.toys)
  };
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
      pairing_url: pairingUrl,
      control_url: `${publicBase(req)}/control/${encodeURIComponent(sl_uuid)}`
    });
  } catch (err) {
    console.error("Database registration error:", err);
    res.status(500).json({ error: "Server encountered a database error during registration." });
  }
});

app.get('/api/hud/qr-proxy', async (req, res) => {
  const src = String(req.query.url || '');
  if (!/^https:\/\/([\w.-]+\.)?lovense\.com\//i.test(src)) {
    return res.status(400).send('Invalid QR source.');
  }
  try {
    const qrRes = await fetch(src);
    if (!qrRes.ok) {
      return res.status(502).send('Could not load QR image.');
    }
    const buf = Buffer.from(await qrRes.arrayBuffer());
    res.set('Content-Type', qrRes.headers.get('content-type') || 'image/jpeg');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(502).send('Could not load QR image.');
  }
});

app.get('/pair/:sl_uuid', (req, res) => {
  const slUuid = req.params.sl_uuid;
  const qr = req.query.qr;
  if (!qr) {
    return res.status(400).send("Missing QR image. Ask the HUD to register again.");
  }

  const statusUrl = `/api/hud/status/${encodeURIComponent(slUuid)}`;
  const controlUrl = `/control/${encodeURIComponent(slUuid)}`;
  const qrSrc = `/api/hud/qr-proxy?url=${encodeURIComponent(String(qr))}`;
  res.type('html').send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link Lovense</title>
  <style>
    body { font-family: sans-serif; background: #111; color: #eee; text-align: center; padding: 24px; }
    canvas { width: 260px; height: 260px; background: #fff; padding: 12px; border-radius: 8px; }
    #status { margin-top: 16px; font-size: 18px; }
    a { color: #ff7ad9; }
  </style>
</head>
<body>
  <h1>Scan with Lovense Remote</h1>
  <p>Open Lovense Remote, use Scan QR, then wait until this page says connected.</p>
  <canvas id="qr" width="260" height="260"></canvas>
  <p id="status">Waiting for scan…</p>
  <script>
    const canvas = document.getElementById("qr");
    const ctx = canvas.getContext("2d");
    const qrImg = new Image();
    const logo = new Image();
    let loaded = 0;
    function draw() {
      loaded += 1;
      if (loaded < 2) return;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 260, 260);
      ctx.drawImage(qrImg, 0, 0, 260, 260);
      const size = 72;
      const x = (260 - size) / 2;
      const y = (260 - size) / 2;
      if (logo.complete && logo.naturalWidth) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(130, 130, size / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(logo, x, y, size, size);
        ctx.restore();
      }
    }
    qrImg.onload = draw;
    logo.onload = draw;
    logo.onerror = draw;
    qrImg.src = ${JSON.stringify(qrSrc)};
    logo.src = "/logo.png";

    async function poll() {
      try {
        const r = await fetch(${JSON.stringify(statusUrl)});
        const data = await r.json();
        if (data.status === "connected") {
          document.getElementById("status").innerHTML = 'Connected! <a href="${controlUrl}">Open toy controls</a>';
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
    const session = await getSession(req.params.sl_uuid);
    if (!session) {
      return res.status(404).json({ status: 'unknown' });
    }
    return res.json({ status: session.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Status lookup failed." });
  }
});

app.get('/api/hud/toys/:sl_uuid', async (req, res) => {
  try {
    const session = await getSession(req.params.sl_uuid);
    if (!session || session.status !== 'connected') {
      return res.status(404).json({ error: "Toy is not connected." });
    }

    const toys = listToys(session.connection);

    return res.json({ toys });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Toy list lookup failed." });
  }
});

app.get('/control/:sl_uuid', (req, res) => {
  const slUuid = req.params.sl_uuid;
  res.type('html').send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lovense Controls</title>
  <style>
    body { font-family: sans-serif; background: #111; color: #eee; max-width: 420px; margin: 0 auto; padding: 24px; }
    label, select, input, button { display: block; width: 100%; margin: 8px 0; font-size: 16px; }
    select, input { padding: 8px; border-radius: 6px; border: 0; }
    button { padding: 12px; border: 0; border-radius: 8px; background: #ff4da6; color: #fff; font-weight: bold; }
    button.secondary { background: #444; }
    #status { min-height: 24px; color: #9f9; }
  </style>
</head>
<body>
  <h1>Toy controls</h1>
  <p>This lists toys currently linked in Lovense Remote, the same way Connect does.</p>
  <label for="toy">Toy</label>
  <select id="toy"><option value="">All connected toys</option></select>
  <label for="strength">Vibration 0–20: <span id="strengthVal">10</span></label>
  <input id="strength" type="range" min="0" max="20" value="10">
  <label for="duration">Seconds</label>
  <input id="duration" type="number" min="1" max="60" value="5">
  <button id="vibrate">Vibrate</button>
  <button id="stop" class="secondary">Stop</button>
  <p id="status">Loading toys…</p>
  <script>
    const uuid = ${JSON.stringify(slUuid)};
    const toySelect = document.getElementById("toy");
    const strength = document.getElementById("strength");
    const strengthVal = document.getElementById("strengthVal");
    const duration = document.getElementById("duration");
    const status = document.getElementById("status");
    strength.oninput = () => strengthVal.textContent = strength.value;

    async function loadToys() {
      try {
        const r = await fetch("/api/hud/toys/" + encodeURIComponent(uuid));
        const data = await r.json();
        if (!r.ok) {
          status.textContent = data.error || "Could not load toys.";
          return;
        }
        toySelect.innerHTML = '<option value="">All connected toys</option>';
        (data.toys || []).forEach((toy) => {
          const opt = document.createElement("option");
          opt.value = toy.id;
          opt.textContent = toy.name + " (" + toy.type + ")";
          toySelect.appendChild(opt);
        });
        status.textContent = (data.toys && data.toys.length)
          ? "Select a toy, then vibrate."
          : "No toys reported yet. Keep Remote open and refresh.";
      } catch (e) {
        status.textContent = "Failed to load toys.";
      }
    }

    async function sendCommand(extra) {
      const body = Object.assign({
        wearer_uuid: uuid,
        strength: parseInt(strength.value, 10),
        duration: parseInt(duration.value, 10) || 5,
        toy_id: toySelect.value || undefined
      }, extra);
      const r = await fetch("/api/hud/vibrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      status.textContent = data.error || (data.success ? "Command sent." : "Command failed.");
    }

    document.getElementById("vibrate").onclick = () => sendCommand({});
    document.getElementById("stop").onclick = () => sendCommand({ stop: true });
    loadToys();
  </script>
</body>
</html>`);
});

app.post('/api/webhook/lovense', async (req, res) => {
  const { uid, utoken, toys, domain, httpPort, httpsPort, wsPort, wssPort, platform, appType } = req.body;

  try {
    const userCheck = await db.query(
      'SELECT sl_http_url, lovense_token, status FROM active_sessions WHERE sl_uuid = $1',
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

    if (session.sl_http_url && session.status !== 'connected') {
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

app.post('/api/hud/vibrate', async (req, res) => {
  const { wearer_uuid, strength, duration, toy_id, stop } = req.body;

  if (!wearer_uuid) {
    return res.status(400).json({ error: "Missing wearer_uuid." });
  }

  try {
    const session = await getSession(wearer_uuid);
    if (!session || session.status !== 'connected') {
      return res.status(404).json({ error: "Toy is not connected or session expired. Re-link the QR." });
    }

    const payload = stop
      ? { command: 'Function', action: 'Stop', timeSec: 0, apiVer: 1 }
      : {
          command: 'Function',
          action: `Vibrate:${parseInt(strength, 10) || 0}`,
          timeSec: parseInt(duration, 10) || 5,
          apiVer: 1
        };

    if (toy_id) {
      payload.toy = toy_id;
    }

    const commandData = await sendLovenseCommand(wearer_uuid, payload);
    const ok = commandData && (commandData.code === 200 || commandData.code === 0 || commandData.result === true);
    if (!ok) {
      return res.status(502).json({
        error: commandData.message || "Lovense rejected the command.",
        details: commandData
      });
    }
    return res.json({ success: true, details: commandData });
  } catch (err) {
    console.error("Vibration execution error:", err);
    res.status(500).json({ error: err.message || "Failed to transmit vibe command." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Database-connected server is listening on port ${PORT}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Database-connected server is listening on port ${PORT}`);
});
