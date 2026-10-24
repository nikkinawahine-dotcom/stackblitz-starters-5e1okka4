require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const jsQR = require('jsqr');
const Jimp = require('jimp');

const brandedQrs = new Map();

function logoFilePath() {
  const nested = path.join(__dirname, 'public', 'logo.png');
  const root = path.join(__dirname, 'logo.png');
  return fs.existsSync(nested) ? nested : root;
}

function circleMask(image) {
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  const r = Math.min(w, h) / 2;
  const cx = w / 2;
  const cy = h / 2;
  image.scan(0, 0, w, h, function (x, y, idx) {
    const dx = x - cx + 0.5;
    const dy = y - cy + 0.5;
    if (dx * dx + dy * dy > r * r) {
      this.bitmap.data[idx + 3] = 0;
    }
  });
  return image;
}

async function makeBrandedQr(lovenseQrUrl) {
  const qrRes = await fetch(lovenseQrUrl);
  const original = Buffer.from(await qrRes.arrayBuffer());
  try {
    const src = await Jimp.read(original);
    const decoded = jsQR(
      new Uint8ClampedArray(src.bitmap.data),
      src.bitmap.width,
      src.bitmap.height
    );
    if (!decoded || !decoded.data) {
      console.error('Could not decode Lovense QR; using original image');
      return original;
    }

    const generated = await QRCode.toBuffer(decoded.data, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 512,
      color: { dark: '#000000', light: '#ffffff' }
    });

    const qr = await Jimp.read(generated);
    const logoPath = logoFilePath();
    if (!fs.existsSync(logoPath)) {
      return generated;
    }

    const logo = await Jimp.read(logoPath);
    const logoSize = Math.round(qr.bitmap.width * 0.2);
    logo.cover(logoSize, logoSize);
    circleMask(logo);

    const ring = 14;
    const badgeSize = logoSize + ring * 2;
    const badge = new Jimp(badgeSize, badgeSize, 0x00000000);
    const cx = badgeSize / 2;
    badge.scan(0, 0, badgeSize, badgeSize, function (x, y, idx) {
      const dx = x - cx + 0.5;
      const dy = y - cx + 0.5;
      if (dx * dx + dy * dy <= (badgeSize / 2) * (badgeSize / 2)) {
        this.bitmap.data[idx] = 255;
        this.bitmap.data[idx + 1] = 255;
        this.bitmap.data[idx + 2] = 255;
        this.bitmap.data[idx + 3] = 255;
      }
    });
    badge.composite(logo, ring, ring);
    const pos = Math.round((qr.bitmap.width - badgeSize) / 2);
    qr.composite(badge, pos, pos);
    return qr.getBufferAsync(Jimp.MIME_PNG);
  } catch (err) {
    console.error('Branded QR failed:', err);
    return original;
  }
}

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

async function ensureSchema() {
  await db.query(`ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS display_name TEXT`);
  await db.query(`ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS shared BOOLEAN DEFAULT false`);
  await db.query(`ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS vibe_strength INTEGER DEFAULT 0`);
  await db.query(`ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS vibe_until TIMESTAMPTZ`);
}
ensureSchema().catch((err) => console.error('Schema update failed:', err));

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

function toyBattery(toy) {
  if (!toy) return null;
  const raw = toy.battery != null && toy.battery !== ''
    ? toy.battery
    : (toy.batt != null && toy.batt !== '' ? toy.batt : toy.batteryLevel);
  if (raw == null || raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : Math.max(0, Math.min(100, n));
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
  if (!toys || typeof toys !== 'object') return [];
  return Object.values(toys).map((toy) => ({
    id: toy.id,
    type: toy.name || 'toy',
    name: toy.nickName || toy.name || toy.id,
    status: toy.status,
    battery: toyBattery(toy)
  }));
}

function displayToyName(name) {
  const raw = String(name || 'Toy');
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function toyLine(toys) {
  if (!toys.length) return 'No toy';
  return toys.map((toy) => {
    const name = displayToyName(toy.name);
    return toy.battery == null ? name : `${name}  ${toy.battery}%`;
  }).join(' | ');
}

function toysFromCommand(data) {
  if (!data) return [];
  const payload = data.data && data.data.toys ? data.data.toys : data.toys;
  if (!payload) return [];
  return listToys({ toys: payload });
}

function batteryFromCommand(data) {
  if (!data) return null;
  const direct = toyBattery(data) || toyBattery(data.data);
  if (direct != null) return direct;
  if (typeof data.data === 'number') return Math.max(0, Math.min(100, data.data));
  if (typeof data.data === 'string' && data.data !== '' && !data.data.includes('{')) {
    const n = parseInt(data.data, 10);
    if (!Number.isNaN(n)) return Math.max(0, Math.min(100, n));
  }
  const toys = toysFromCommand(data);
  const found = toys.find((toy) => toy.battery != null);
  return found ? found.battery : null;
}

function mergeBattery(base, extra) {
  if (!extra || !extra.length) return base;
  const byId = new Map(extra.filter((toy) => toy.id).map((toy) => [toy.id, toy]));
  if (!base.length) return extra;
  return base.map((toy) => {
    const live = byId.get(toy.id) || extra.find((item) => item.name === toy.name);
    if (!live) return toy;
    return {
      ...toy,
      name: live.name || toy.name,
      battery: live.battery != null ? live.battery : toy.battery
    };
  });
}

const batteryCache = new Map();

async function rememberBatteries(session, toys) {
  if (!session || !session.connection || !session.connection.toys || !toys.some((toy) => toy.battery != null)) {
    return;
  }
  const toysObj = typeof session.connection.toys === 'string'
    ? JSON.parse(session.connection.toys)
    : { ...session.connection.toys };
  let changed = false;
  for (const toy of toys) {
    if (toy.battery == null) continue;
    const key = Object.keys(toysObj).find((id) => id === toy.id || (toysObj[id] && toysObj[id].id === toy.id));
    if (!key || toysObj[key].battery === toy.battery) continue;
    toysObj[key] = { ...toysObj[key], battery: toy.battery };
    changed = true;
  }
  if (!changed) return;
  const connection = { ...session.connection, toys: toysObj };
  await db.query(
    'UPDATE active_sessions SET toys = $2 WHERE sl_uuid = $1',
    [session.sl_uuid, JSON.stringify(connection)]
  );
}

async function toysForSession(session) {
  let toys = listToys(session.connection);
  const cached = batteryCache.get(session.sl_uuid);
  if (cached && Date.now() - cached.at < 20000) {
    toys = mergeBattery(toys, cached.toys);
  }
  if (toys.some((toy) => toy.battery == null)) {
    try {
      const live = await sendLovenseCommand(session.sl_uuid, { command: 'GetToys', apiVer: 1 });
      const parsed = toysFromCommand(live);
      if (parsed.length) toys = mergeBattery(toys, parsed);
    } catch (err) {
      console.error('GetToys for titler failed:', err.message);
    }
  }
  for (const toy of toys) {
    if (toy.battery != null || !toy.id) continue;
    try {
      const batt = await sendLovenseCommand(session.sl_uuid, {
        command: 'GetBattery',
        toy: toy.id,
        apiVer: 1
      });
      const value = batteryFromCommand(batt);
      if (value != null) toy.battery = value;
    } catch (err) {
      console.error('GetBattery failed:', err.message);
    }
  }
  if (toys.some((toy) => toy.battery != null)) {
    batteryCache.set(session.sl_uuid, { at: Date.now(), toys });
    try {
      await rememberBatteries(session, toys);
    } catch (err) {
      console.error('Saving battery failed:', err.message);
    }
  }
  return toys;
}

function commandOk(data) {
  return data && (data.code === 200 || data.code === 0 || data.result === true);
}

function postHttpsJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: 'POST',
      rejectUnauthorized: false,
      timeout: 8000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          resolve({ code: res.statusCode, message: raw });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Lovense Remote timed out')));
    req.write(data);
    req.end();
  });
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

async function sendToyCommand(uid, connection, payload) {
  const domain = connection && connection.domain;
  const port = connection && (connection.httpsPort || connection.wssPort);
  if (domain && port && !String(domain).includes('127-0-0-1')) {
    try {
      const lan = await postHttpsJson(
        `https://${domain}:${port}/command`,
        { 'X-platform': PLATFORM_NAME },
        payload
      );
      if (commandOk(lan)) {
        return lan;
      }
      console.error('LAN command rejected:', lan);
    } catch (err) {
      console.error('LAN command failed:', err.message);
    }
  }
  return sendLovenseCommand(uid, payload);
}

const fades = new Map();

function sampleRamp(from, to, maxSteps) {
  const diff = to - from;
  if (diff === 0) return [to];
  const steps = Math.min(Math.abs(diff), maxSteps);
  const levels = [];
  for (let i = 1; i <= steps; i++) {
    levels.push(Math.round(from + (diff * i) / steps));
  }
  levels[levels.length - 1] = to;
  return levels;
}

function fadePosition(state) {
  if (!state) return 0;
  if (!state.levels || !state.started) return state.at || 0;
  const index = Math.min(state.levels.length - 1, Math.floor((Date.now() - state.started) / 100));
  return state.levels[index];
}

function cancelFade(uid) {
  const state = fades.get(uid);
  if (state) state.gen += 1;
  fades.set(uid, { gen: (state?.gen || 0) + 1, at: 0, levels: null, started: 0 });
}

async function sendSmoothLevel(uid, connection, toyId, target, seconds) {
  const previous = fades.get(uid);
  const from = fadePosition(previous);
  const gen = (previous?.gen || 0) + 1;
  if (target === from) {
    fades.set(uid, { gen, at: target, levels: null, started: 0 });
    const hold = {
      command: 'Function',
      action: target === 0 ? 'Stop' : `Vibrate:${target}`,
      timeSec: target === 0 ? 0 : Math.max(1, seconds),
      apiVer: 1,
      stopPrevious: 1
    };
    if (toyId && target !== 0) hold.toy = toyId;
    return sendToyCommand(uid, connection, hold);
  }

  const maxSteps = Math.max(1, Math.min(20, Math.floor(Math.max(1, seconds) * 10) - 1));
  const levels = sampleRamp(from, target, maxSteps);
  const rampMs = levels.length * 100;
  fades.set(uid, { gen, at: target, levels, started: Date.now() });

  if (target === 0 && levels.length < 3) {
    return sendToyCommand(uid, connection, {
      command: 'Function',
      action: 'Stop',
      timeSec: 0,
      apiVer: 1,
      stopPrevious: 1
    });
  }

  const pattern = {
    command: 'Pattern',
    rule: 'V:1;F:v;S:100#',
    strength: levels.join(';'),
    timeSec: Math.max(1, rampMs / 1000),
    apiVer: 2,
    stopPrevious: 1
  };
  if (toyId) pattern.toy = toyId;
  const result = await sendToyCommand(uid, connection, pattern);
  if (!commandOk(result)) {
    const direct = {
      command: 'Function',
      action: `Vibrate:${target}`,
      timeSec: Math.max(1, seconds),
      apiVer: 1,
      stopPrevious: 1
    };
    if (toyId) direct.toy = toyId;
    return sendToyCommand(uid, connection, direct);
  }

  const holdSec = Math.round(seconds - rampMs / 1000);
  if (target > 0 && holdSec >= 1) {
    setTimeout(() => {
      const state = fades.get(uid);
      if (!state || state.gen !== gen) return;
      const hold = {
        command: 'Function',
        action: `Vibrate:${target}`,
        timeSec: holdSec,
        apiVer: 1,
        stopPrevious: 1
      };
      if (toyId) hold.toy = toyId;
      sendToyCommand(uid, connection, hold).catch((err) => {
        console.error('Smooth hold failed:', err.message);
      });
    }, rampMs);
  }
  return result;
}

async function getSession(slUuid) {
  const result = await db.query(
    `SELECT sl_uuid, sl_http_url, status, toys, display_name, shared, vibe_strength, vibe_until
     FROM active_sessions WHERE sl_uuid = $1`,
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
      `INSERT INTO active_sessions (sl_uuid, sl_http_url, status, lovense_token, display_name, shared)
       VALUES ($1, $2, 'pending', $3, $4, false)
       ON CONFLICT (sl_uuid) DO UPDATE SET
         sl_http_url = $2,
         status = 'pending',
         lovense_token = $3,
         display_name = $4,
         toys = NULL,
         shared = false,
         vibe_strength = 0,
         vibe_until = NOW()`,
      [sl_uuid, sl_http_url, utoken, sl_name || sl_uuid]
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

    brandedQrs.set(sl_uuid, await makeBrandedQr(qrData.data.qr));

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

app.get('/api/hud/branded-qr/:sl_uuid', (req, res) => {
  const buf = brandedQrs.get(req.params.sl_uuid);
  if (!buf) {
    return res.status(404).send('QR expired. Touch the object again.');
  }
  res.set('Content-Type', 'image/png');
  res.send(buf);
});

app.get('/pair/:sl_uuid', (req, res) => {
  const slUuid = req.params.sl_uuid;
  const qr = req.query.qr;
  if (!qr) {
    return res.status(400).send("Missing QR image. Ask the HUD to register again.");
  }

  const statusUrl = `/api/hud/status/${encodeURIComponent(slUuid)}`;
  const controlUrl = `/control/${encodeURIComponent(slUuid)}`;
  const qrSrc = `/api/hud/branded-qr/${encodeURIComponent(slUuid)}`;
  const fallbackSrc = `/api/hud/qr-proxy?url=${encodeURIComponent(String(qr))}`;
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
    a { color: #ff7ad9; }
  </style>
</head>
<body>
  <h1>Scan with Lovense Remote</h1>
  <p>Open Lovense Remote, use Scan QR, then wait until this page says connected.</p>
  <img id="qr" src="${qrSrc}" alt="Lovense QR code" onerror="this.onerror=null;this.src='${fallbackSrc}'">
  <p id="status">Waiting for scan…</p>
  <script>
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
      return res.status(404).json({ status: 'unknown', connected: false, toys: [] });
    }
    const connected = session.status === 'connected';
    const until = session.vibe_until ? new Date(session.vibe_until).getTime() : 0;
    const vibe = connected && until > Date.now() ? (parseInt(session.vibe_strength, 10) || 0) : 0;
    const toys = connected ? await toysForSession(session) : [];
    return res.json({
      status: session.status,
      connected,
      vibe,
      toys,
      toy_line: connected ? toyLine(toys) : 'No toy'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Status lookup failed." });
  }
});

app.get('/api/hud/wearers', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT sl_uuid, COALESCE(display_name, sl_uuid) AS display_name
       FROM active_sessions
       WHERE status = 'connected' AND shared = true
       ORDER BY display_name`
    );
    return res.json({ wearers: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Wearer list lookup failed." });
  }
});

app.post('/api/hud/share', async (req, res) => {
  const { sl_uuid, shared } = req.body;
  if (!sl_uuid) {
    return res.status(400).json({ error: "Missing sl_uuid." });
  }
  try {
    const result = await db.query(
      `UPDATE active_sessions
       SET shared = $2
       WHERE sl_uuid = $1 AND status = 'connected'
       RETURNING sl_uuid, shared`,
      [sl_uuid, shared !== false]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Link your toy first, then share it." });
    }
    return res.json({ success: true, shared: result.rows[0].shared });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update sharing." });
  }
});

app.get('/control', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Choose a partner</title>
  <style>
    body { font-family: sans-serif; background: #111; color: #eee; max-width: 420px; margin: 0 auto; padding: 24px; }
    a { display: block; background: #ff4da6; color: #fff; text-decoration: none; padding: 14px; border-radius: 8px; margin: 8px 0; text-align: center; font-weight: bold; }
    p { color: #ccc; }
  </style>
</head>
<body>
  <h1>Control a partner</h1>
  <p>These avatars shared their linked toy.</p>
  <div id="list">Loading…</div>
  <script>
    async function load() {
      const el = document.getElementById("list");
      try {
        const r = await fetch("/api/hud/wearers");
        const data = await r.json();
        if (!data.wearers || !data.wearers.length) {
          el.innerHTML = "<p>Nobody has shared a toy yet. The wearer should touch the object and choose Share.</p>";
          return;
        }
        el.innerHTML = data.wearers.map(function (w) {
          return '<a href="/control/' + encodeURIComponent(w.sl_uuid) + '">' + (w.display_name || w.sl_uuid) + '</a>';
        }).join("");
      } catch (e) {
        el.textContent = "Could not load partners.";
      }
    }
    load();
  </script>
</body>
</html>`);
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
  <p>Drag the slider. Strength eases as you move it, then stops when the seconds run out. Keep Lovense Remote open.</p>
  <label for="toy">Toy</label>
  <select id="toy"><option value="">All connected toys</option></select>
  <label for="strength">Vibration 0–20: <span id="strengthVal">0</span></label>
  <input id="strength" type="range" min="0" max="20" step="1" value="0">
  <label for="duration">Seconds</label>
  <input id="duration" type="number" min="1" max="60" value="5">
  <button id="vibrate">Vibrate for those seconds</button>
    <button id="stop" class="secondary">Stop</button>
    <button id="disconnect" class="secondary">Disconnect</button>
  <p id="status">Loading toys…</p>
  <script>
    const uuid = ${JSON.stringify(slUuid)};
    const toySelect = document.getElementById("toy");
    const strength = document.getElementById("strength");
    const strengthVal = document.getElementById("strengthVal");
    const duration = document.getElementById("duration");
    const status = document.getElementById("status");
    let desired = 0;
    let lastSent = -1;
    let inflight = false;
    let resend = false;
    let endsAt = 0;
    let clock = null;
    let sendTimer = null;

    function allowedSeconds() {
      const n = parseInt(duration.value, 10) || 5;
      return Math.max(1, Math.min(60, n));
    }

    function remaining() {
      if (!endsAt) return 0;
      return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    }

    function queueSend() {
      if (sendTimer) return;
      sendTimer = setTimeout(() => {
        sendTimer = null;
        pump();
      }, 90);
    }

    async function pump() {
      if (inflight) return;
      const level = desired;
      const left = level === 0 ? 0 : remaining();
      if (level > 0 && left <= 0) return;
      if (level === lastSent && !resend) return;
      resend = false;
      inflight = true;
      try {
        await postCommand(commandBody(level, left));
        lastSent = level;
        status.textContent = level === 0 ? "Stopped." : ("Strength " + level + ", " + left + "s left");
      } catch (e) {
        status.textContent = e.message || "Command failed.";
      } finally {
        inflight = false;
        if (desired !== lastSent) queueSend();
      }
    }

    strength.oninput = () => {
      const level = parseInt(strength.value, 10) || 0;
      strengthVal.textContent = String(level);
      desired = level;
      if (level > 0) beginSession();
      else stopClock();
      queueSend();
    function stopClock() {
      if (clock) clearInterval(clock);
      clock = null;
      endsAt = 0;
    }

    function beginSession() {
      if (endsAt > Date.now()) return;
      endsAt = Date.now() + allowedSeconds() * 1000;
      if (clock) clearInterval(clock);
      clock = setInterval(() => {
        if (remaining() > 0) return;
        stopClock();
        strength.value = "0";
        strengthVal.textContent = "0";
        desired = 0;
        status.textContent = "Time is up.";
        pump();
      }, 250);
    }

    async function postCommand(body) {
      const r = await fetch("/api/hud/vibrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        throw new Error(data.error || "Command failed.");
      }
      return data;
    }

    function commandBody(level, seconds) {
      return {
        wearer_uuid: uuid,
        strength: level,
        duration: seconds,
        stop: level === 0,
        toy_id: toySelect.value || undefined
      };
    }

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
          ? "Drag the slider. It runs for the seconds shown, then stops."
          : "No toys reported yet. Keep Remote open and refresh.";
      } catch (e) {
        status.textContent = "Failed to load toys.";
      }
    }

    document.getElementById("vibrate").onclick = () => {
      const level = parseInt(strength.value, 10) || 0;
      if (level === 0) {
        status.textContent = "Move the slider above 0 first.";
        return;
      }
      stopClock();
      desired = level;
      resend = true;
      beginSession();
      pump();
    };
    document.getElementById("stop").onclick = () => {
      stopClock();
      strength.value = "0";
      strengthVal.textContent = "0";
      desired = 0;
      pump();
    };
    document.getElementById("disconnect").onclick = async () => {
      stopClock();
      strength.value = "0";
      strengthVal.textContent = "0";
      desired = 0;
      lastSent = 0;
      try {
        const r = await fetch("/api/hud/disconnect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wearer_uuid: uuid })
        });
        const data = await r.json();
        if (!r.ok || data.error) {
          status.textContent = data.error || "Could not disconnect.";
          return;
        }
        status.textContent = "Disconnected. Use Link toy in Second Life for a new QR.";
      } catch (e) {
        status.textContent = "Could not disconnect.";
      }
    };
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
    if (session.status === 'disconnected') {
      return res.sendStatus(200);
    }
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

app.post('/api/hud/disconnect', async (req, res) => {
  const slUuid = req.body.sl_uuid || req.body.wearer_uuid;
  if (!slUuid) {
    return res.status(400).json({ error: "Missing wearer_uuid." });
  }

  try {
    const session = await getSession(slUuid);
    if (!session) {
      return res.status(404).json({ error: "No link to disconnect." });
    }

    if (session.status === 'connected' && session.connection) {
      cancelFade(slUuid);
      try {
        await sendToyCommand(slUuid, session.connection, {
          command: 'Function',
          action: 'Stop',
          timeSec: 0,
          apiVer: 1,
          stopPrevious: 1
        });
      } catch (err) {
        console.error("Stop before disconnect failed:", err.message);
      }
    }

    await db.query(
      `UPDATE active_sessions
       SET status = 'disconnected',
           toys = NULL,
           vibe_strength = 0,
           vibe_until = NOW()
       WHERE sl_uuid = $1`,
      [slUuid]
    );

    if (session.sl_http_url) {
      try {
        await fetch(session.sl_http_url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: "DISCONNECTED|Link removed until a new QR is requested."
        });
      } catch (err) {
        console.error("SL disconnect notify failed:", err.message);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Disconnect error:", err);
    res.status(500).json({ error: "Could not disconnect." });
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

    let level = parseInt(strength, 10);
    if (Number.isNaN(level)) level = 0;
    level = Math.max(0, Math.min(20, level));
    let seconds = parseInt(duration, 10);
    if (Number.isNaN(seconds)) seconds = 0;
    seconds = Math.max(0, Math.min(60, seconds));
    const stopNow = stop === true || stop === 'true' || level === 0;

    let commandData;
    if (stopNow) {
      cancelFade(wearer_uuid);
      commandData = await sendToyCommand(wearer_uuid, session.connection, {
        command: 'Function',
        action: 'Stop',
        timeSec: 0,
        apiVer: 1,
        stopPrevious: 1
      });
    } else {
      commandData = await sendSmoothLevel(
        wearer_uuid,
        session.connection,
        toy_id,
        level,
        Math.max(1, seconds)
      );
    }
    if (!commandOk(commandData)) {
      const offline = commandData && (commandData.code === 507 || /offline/i.test(String(commandData.message || '')));
      return res.status(502).json({
        error: offline
          ? "Lovense Remote is asleep. Open Remote, keep the phone screen on, then vibrate again."
          : (commandData.message || "Lovense rejected the command."),
        details: commandData
      });
    }

    const strengthNow = stopNow ? 0 : level;
    const holdSeconds = strengthNow === 0 ? 0 : Math.max(1, seconds);
    await db.query(
      `UPDATE active_sessions
       SET vibe_strength = $2,
           vibe_until = CASE
             WHEN $2 <= 0 THEN NOW()
             ELSE NOW() + ($3 * INTERVAL '1 second')
           END
       WHERE sl_uuid = $1`,
      [wearer_uuid, strengthNow, holdSeconds]
    );

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
