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
  await db.query(`ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS hud_mode TEXT DEFAULT 'normal'`);
  await db.query(`CREATE TABLE IF NOT EXISTS saved_patterns (
    id BIGSERIAL PRIMARY KEY,
    sl_uuid TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    steps JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (sl_uuid, name_key)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS control_grants (
    token TEXT PRIMARY KEY,
    wearer_uuid TEXT NOT NULL,
    recipient_uuid TEXT,
    recipient_name TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`ALTER TABLE control_grants ADD COLUMN IF NOT EXISTS sender_name TEXT`);
  await db.query(`ALTER TABLE control_grants ADD COLUMN IF NOT EXISTS seconds_left INTEGER`);
  await db.query(`ALTER TABLE control_grants ADD COLUMN IF NOT EXISTS hud_mode TEXT DEFAULT 'normal'`);
  await db.query(`ALTER TABLE control_grants ADD COLUMN IF NOT EXISTS running_since TIMESTAMPTZ`);
  await db.query(`ALTER TABLE control_grants ADD COLUMN IF NOT EXISTS rate INTEGER DEFAULT 30`);
  await db.query(`ALTER TABLE control_grants ADD COLUMN IF NOT EXISTS hard_expire BOOLEAN DEFAULT FALSE`);
  await db.query(`CREATE TABLE IF NOT EXISTS control_offers (
    id TEXT PRIMARY KEY,
    wearer_uuid TEXT NOT NULL,
    recipient_uuid TEXT NOT NULL,
    recipient_name TEXT,
    sender_name TEXT,
    seconds INTEGER NOT NULL,
    price INTEGER NOT NULL,
    rate INTEGER NOT NULL DEFAULT 30,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`ALTER TABLE control_offers ADD COLUMN IF NOT EXISTS rate INTEGER DEFAULT 30`);
  await db.query(`ALTER TABLE control_offers ADD COLUMN IF NOT EXISTS grant_token TEXT`);
  await db.query(`CREATE TABLE IF NOT EXISTS site_assets (
    name TEXT PRIMARY KEY,
    bytes BYTEA NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS time_adds (
    id TEXT PRIMARY KEY,
    wearer_uuid TEXT NOT NULL,
    recipient_uuid TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    price INTEGER NOT NULL,
    rate INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`UPDATE control_grants
    SET seconds_left = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (expires_at - NOW())))::int)
    WHERE seconds_left IS NULL`);
}
ensureSchema().catch((err) => console.error('Schema update failed:', err));

app.get('/neon-sign.png', async (req, res, next) => {
  try {
    const found = await db.query(`SELECT bytes FROM site_assets WHERE name = 'neon-sign'`);
    if (!found.rows[0]) return next();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(found.rows[0].bytes);
  } catch (err) {
    next();
  }
});

app.get('/neon-sign.mp4', async (req, res, next) => {
  try {
    const found = await db.query(`SELECT bytes FROM site_assets WHERE name = 'neon-loop'`);
    if (!found.rows[0]) return next();
    const buf = found.rows[0].bytes;
    const total = buf.length;
    res.set('Content-Type', 'video/mp4');
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('Accept-Ranges', 'bytes');
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      const start = match ? Number(match[1]) : NaN;
      const end = match && match[2] ? Number(match[2]) : total - 1;
      if (!match || start >= total || end >= total || start > end) {
        res.status(416).set('Content-Range', `bytes */${total}`).end();
        return;
      }
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${total}`);
      res.set('Content-Length', String(end - start + 1));
      res.end(buf.subarray(start, end + 1));
      return;
    }
    res.set('Content-Length', String(total));
    res.end(buf);
  } catch (err) {
    next(err);
  }
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

function toyBattery(toy) {
  if (!toy) return null;
  const raw = toy.battery != null && toy.battery !== ''
    ? toy.battery
    : (toy.batt != null && toy.batt !== '' ? toy.batt : toy.batteryLevel);
  if (raw == null || raw === '') return null;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return null;
  return Math.max(0, Math.min(100, n));
}

const FUNCTION_ORDER = ['Vibrate', 'Vibrate1', 'Vibrate2', 'Vibrate3', 'Rotate', 'Pump', 'Thrusting', 'Fingering', 'Suction', 'Depth', 'Oscillate', 'Stroke', 'Position'];
const FUNCTION_LIMITS = {
  Vibrate: 20, Vibrate1: 20, Vibrate2: 20, Vibrate3: 20,
  Rotate: 20, Pump: 3, Thrusting: 20, Fingering: 20, Suction: 20,
  Depth: 3, Oscillate: 20, Stroke: 100, Position: 100
};
const FUNCTION_ALIASES = {
  v: 'Vibrate', vibrate: 'Vibrate',
  v1: 'Vibrate1', vibrate1: 'Vibrate1',
  v2: 'Vibrate2', vibrate2: 'Vibrate2',
  v3: 'Vibrate3', vibrate3: 'Vibrate3',
  r: 'Rotate', rotate: 'Rotate',
  p: 'Pump', pump: 'Pump',
  t: 'Thrusting', thrusting: 'Thrusting', thrust: 'Thrusting',
  f: 'Fingering', fingering: 'Fingering',
  s: 'Suction', suction: 'Suction',
  d: 'Depth', depth: 'Depth',
  o: 'Oscillate', oscillate: 'Oscillate',
  stroke: 'Stroke',
  position: 'Position', pos: 'Position'
};
const MODEL_FUNCTIONS = [
  [/solace\s*pro|solacepro/, ['Thrusting', 'Stroke', 'Position']],
  [/solace/, ['Thrusting', 'Depth']],
  [/mission/, ['Vibrate']],
  [/nora/, ['Vibrate', 'Rotate']],
  [/max/, ['Vibrate', 'Pump']],
  [/tenera/, ['Suction']],
  [/flexer/, ['Fingering']],
  [/gravity/, ['Vibrate', 'Thrusting', 'Depth']],
  [/sex\s*machine|xmachine/, ['Thrusting']],
  [/osci/, ['Oscillate']]
];

function asFunctionList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try { return asFunctionList(JSON.parse(trimmed)); } catch (err) { /* fall through */ }
  }
  return trimmed.split(/[,\s]+/);
}

function knownFunctions(value) {
  const names = [];
  for (const item of asFunctionList(value)) {
    const name = FUNCTION_ALIASES[String(item || '').trim().toLowerCase()];
    if (name && !names.includes(name)) names.push(name);
  }
  return FUNCTION_ORDER.filter((name) => names.includes(name));
}

function functionsForToy(toy) {
  const reported = knownFunctions(toy && (toy.fullFunctionNames || toy.functions || toy.shortFunctionNames));
  if (reported.length) return reported;
  const model = String((toy && (toy.toyType || toy.type || toy.name)) || '').toLowerCase();
  for (const [pattern, functions] of MODEL_FUNCTIONS) {
    if (pattern.test(model)) return functions.slice();
  }
  return ['Vibrate'];
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
  const entries = Array.isArray(toys)
    ? toys.map((toy, i) => [toy && (toy.id || toy.toyId) || String(i), toy])
    : Object.entries(toys);
  return entries.map(([key, toy]) => {
    if (!toy || typeof toy !== 'object') return null;
    const id = toy.id || toy.toyId || key;
    return {
      id,
      type: toy.name || toy.toyType || 'toy',
      name: toy.nickName || toy.nickname || toy.name || toy.toyType || id,
      status: toy.status,
      battery: toyBattery(toy),
      functions: functionsForToy(toy)
    };
  }).filter(Boolean);
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

function toyListEntries(value) {
  return toyListPairs(value).map(([, toy]) => toy);
}

function parseToyValue(value) {
  if (typeof value === 'string') {
    try { return parseToyValue(JSON.parse(value)); } catch (err) { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function toyListPairs(value) {
  if (typeof value === 'string') {
    try { return toyListPairs(JSON.parse(value)); } catch (err) { return []; }
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      const toy = parseToyValue(item) || item;
      const id = toy && (toy.id || toy.toyId);
      return [id || ('toy' + (i + 1)), toy];
    });
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => [key, parseToyValue(item) || item]);
  }
  return [];
}

function toysFromCallback(body) {
  if (!body || typeof body !== 'object') return null;
  const nested = body.data && typeof body.data === 'object' ? body.data : {};
  const source = body.toyList != null ? body.toyList
    : (body.toys != null ? body.toys
      : (nested.toyList != null ? nested.toyList : nested.toys));
  if (source == null) return null;
  const map = {};
  for (const [key, toy] of toyListPairs(source)) {
    if (!toy || typeof toy !== 'object') continue;
    const id = String(toy.id || toy.toyId || key || '').trim();
    if (!id) continue;
    const battery = toyBattery(toy);
    const type = toy.toyType || toy.name || toy.type || 'toy';
    map[id] = {
      id,
      name: type,
      nickName: toy.nickname || toy.nickName || toy.name || '',
      status: toy.connected === false || toy.status === 0 || toy.status === '0' ? 0 : 1,
      fullFunctionNames: functionsForToy({
        fullFunctionNames: toy.fullFunctionNames,
        shortFunctionNames: toy.shortFunctionNames,
        functions: toy.functions,
        toyType: type
      }),
      functionsKnown: knownFunctions(toy.fullFunctionNames || toy.shortFunctionNames || toy.functions).length > 0,
      ...(battery == null ? {} : { battery })
    };
  }
  if (!Object.keys(map).length) return null;
  return map;
}

function collectBatteries(value, found = []) {
  if (!value) return found;
  if (typeof value === 'string') {
    if (!value.includes('battery') && !value.includes('toyList')) return found;
    try {
      return collectBatteries(JSON.parse(value), found);
    } catch (err) {
      return found;
    }
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectBatteries(item, found));
    return found;
  }
  if (typeof value !== 'object') return found;
  const battery = toyBattery(value);
  if (battery != null && (value.id || value.toyId || value.name || value.toyType)) {
    found.push({
      id: value.id || value.toyId,
      name: value.nickname || value.nickName || value.name || value.toyType,
      battery
    });
  }
  for (const child of Object.values(value)) {
    if (child && (typeof child === 'object' || typeof child === 'string')) {
      collectBatteries(child, found);
    }
  }
  return found;
}

function toysFromCommand(data) {
  const found = collectBatteries(data);
  if (found.length) return found;
  if (!data) return [];
  const payload = data.data && data.data.toys ? data.data.toys : data.toys;
  if (!payload) return [];
  return listToys({ toys: payload });
}

function mergeBattery(base, extra) {
  if (!extra || !extra.length) return base;
  if (!base.length) return extra;
  const byId = new Map(extra.filter((toy) => toy.id).map((toy) => [String(toy.id), toy]));
  return base.map((toy) => {
    const live = (toy.id && byId.get(String(toy.id)))
      || extra.find((item) => item.name && toy.name && String(item.name).toLowerCase() === String(toy.name).toLowerCase());
    if (!live) return toy;
    return {
      ...toy,
      name: toy.name || live.name,
      battery: live.battery != null ? live.battery : toy.battery,
      functions: (live.functions && live.functions.length) ? live.functions : toy.functions
    };
  });
}

const batteryCache = new Map();

async function replaceStoredToys(session, toys) {
  if (!session || !session.connection || !toys.length) return;
  const toysObj = {};
  for (const toy of toys) {
    const id = toy.id || toy.name;
    if (!id) continue;
    toysObj[id] = {
      id,
      name: toy.type || toy.name || 'toy',
      nickName: toy.name || '',
      status: 1,
      fullFunctionNames: functionsForToy(toy),
      ...(toy.battery == null ? {} : { battery: toy.battery })
    };
  }
  if (!Object.keys(toysObj).length) return;
  const connection = { ...session.connection, toys: toysObj };
  await db.query(
    'UPDATE active_sessions SET toys = $2 WHERE sl_uuid = $1',
    [session.sl_uuid, JSON.stringify(connection)]
  );
}

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
    let key = Object.keys(toysObj).find((id) => id === toy.id || (toysObj[id] && toysObj[id].id === toy.id));
    if (!key && !toy.id && Object.keys(toysObj).length === 1) key = Object.keys(toysObj)[0];
    if (!key) {
      const id = toy.id || toy.name;
      if (!id) continue;
      toysObj[id] = {
        id,
        name: toy.type || toy.name || 'toy',
        nickName: toy.name || '',
        status: 1,
        battery: toy.battery,
        ...(toy.functions && toy.functions.length ? { fullFunctionNames: toy.functions } : {})
      };
      changed = true;
      continue;
    }
    const next = { ...toysObj[key], battery: toy.battery };
    if (toy.functions && toy.functions.length) next.fullFunctionNames = toy.functions;
    const sameBattery = toysObj[key].battery === toy.battery;
    const sameFns = JSON.stringify(toysObj[key].fullFunctionNames || []) === JSON.stringify(next.fullFunctionNames || []);
    if (sameBattery && sameFns) continue;
    toysObj[key] = next;
    changed = true;
  }
  if (!changed) return;
  const connection = { ...session.connection, toys: toysObj };
  await db.query(
    'UPDATE active_sessions SET toys = $2 WHERE sl_uuid = $1',
    [session.sl_uuid, JSON.stringify(connection)]
  );
}

const getToysAt = new Map();

function readReportedToys(data) {
  const mapped = toysFromCallback(data) || toysFromCallback(data && data.data);
  if (!mapped) return [];
  return listToys({ toys: mapped });
}

function localLovense(session) {
  const domain = session && session.connection && session.connection.domain;
  return Boolean(domain && String(domain).includes('127-0-0-1'));
}

function scheduleGetToys(session, force) {
  const uid = session && session.sl_uuid;
  if (!uid) return;
  const hasToys = listToys(session && session.connection).length > 0;
  const wait = force ? 0 : (hasToys ? 60000 : 8000);
  if (Date.now() - (getToysAt.get(uid) || 0) < wait) return;
  getToysAt.set(uid, Date.now());
  sendLovenseCommand(uid, { command: 'GetToys', apiVer: 1 })
    .then(async (live) => {
      const reported = readReportedToys(live);
      const parsed = reported.length ? reported : toysFromCommand(live);
      if (!parsed.length) {
        const data = live && live.data;
        const keys = data && typeof data === 'object' ? Object.keys(data) : [];
        console.log('GetToys had no toys', live && live.code, keys.join(','));
        return;
      }
      const fresh = await getSession(uid);
      if (!fresh || fresh.status !== 'connected') return;
      const previous = listToys(fresh.connection);
      const toys = parsed.map((toy) => {
        const old = previous.find((item) => item.id && toy.id && String(item.id) === String(toy.id));
        return {
          ...toy,
          battery: toy.battery != null ? toy.battery : (old && old.battery != null ? old.battery : null),
          functions: (toy.functions && toy.functions.length) ? toy.functions : (old && old.functions)
        };
      });
      batteryCache.set(uid, { at: Date.now(), toys });
      await replaceStoredToys(fresh, toys);
      console.log('Lovense toys', toys.map((toy) => ({ name: toy.type || toy.name, battery: toy.battery, functions: toy.functions })));
    })
    .catch((err) => console.error('GetToys for titler failed:', err.message));
}

async function toysForSession(session) {
  watchBattery(session);
  let toys = listToys(session.connection);
  const cached = batteryCache.get(session.sl_uuid);
  if (cached) toys = mergeBattery(toys, cached.toys);
  scheduleGetToys(session);
  return toys;
}

const batteryWatchers = new Map();

function stopBatteryWatch(uid) {
  const watcher = batteryWatchers.get(uid);
  if (!watcher) return;
  watcher.stopped = true;
  if (watcher.close) watcher.close();
  batteryWatchers.delete(uid);
}

function watchBattery(session) {
  if (!session || session.status !== 'connected' || !LOVENSE_TOKEN) return;
  if (localLovense(session)) {
    stopBatteryWatch(session.sl_uuid);
    return;
  }
  const existing = batteryWatchers.get(session.sl_uuid);
  if (existing && !existing.stopped) return;
  const watcher = { stopped: false, seen: new Set() };
  batteryWatchers.set(session.sl_uuid, watcher);
  readBatterySocket(session.sl_uuid, session.display_name, watcher).catch((err) => {
    console.error('Battery watch failed:', err.message);
  });
}

async function saveSocketBattery(uid, toyList) {
  const incoming = (Array.isArray(toyList) ? toyList : []).map((toy) => ({
    id: toy.id || toy.toyId,
    name: toy.nickname || toy.nickName || toy.name || toy.toyType,
    battery: toyBattery(toy)
  })).filter((toy) => toy.battery != null);
  if (!incoming.length) return;
  const session = await getSession(uid);
  if (!session || session.status !== 'connected') return;
  const toys = mergeBattery(listToys(session.connection), incoming);
  batteryCache.set(uid, { at: Date.now(), toys });
  await rememberBatteries(session, toys);
  console.log('Lovense battery', toys.map((toy) => ({ name: toy.name, battery: toy.battery })));
}

function batteriesFromPayload(data) {
  const found = [];
  const lists = [];
  if (Array.isArray(data)) lists.push(data);
  if (data && typeof data === 'object') {
    if (Array.isArray(data.toyList)) lists.push(data.toyList);
    if (data.data && Array.isArray(data.data.toyList)) lists.push(data.data.toyList);
    if (data.type === 'battery-changed') {
      const value = data.data && data.data.value != null ? data.data.value : data.value;
      const battery = toyBattery({ battery: value });
      if (battery != null) {
        found.push({ id: data.toyId || data.id, name: data.name, battery });
      }
    }
  }
  for (const list of lists) {
    for (const toy of list) {
      if (!toy || typeof toy !== 'object') continue;
      const battery = toyBattery(toy);
      if (battery == null) continue;
      found.push({
        id: toy.id || toy.toyId,
        name: toy.nickname || toy.nickName || toy.name || toy.toyType,
        battery
      });
    }
  }
  if (found.length) return found;
  return collectBatteries(data);
}

function decodeEnginePayload(text) {
  const raw = String(text || '');
  if (!raw) return [];
  if (raw.includes('\u001e')) return raw.split('\u001e').filter(Boolean);
  if (/^\d+:/.test(raw)) {
    const packets = [];
    let i = 0;
    while (i < raw.length) {
      const colon = raw.indexOf(':', i);
      if (colon < 0) break;
      const n = parseInt(raw.slice(i, colon), 10);
      if (!Number.isFinite(n) || n < 0) break;
      const msg = raw.slice(colon + 1, colon + 1 + n);
      if (msg.length !== n) break;
      packets.push(msg);
      i = colon + 1 + n;
    }
    if (packets.length) return packets;
  }
  return [raw];
}

function socketEvent(packet) {
  if (!packet || !packet.startsWith('42')) return null;
  try {
    const parsed = JSON.parse(packet.slice(2));
    let data = parsed[1];
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (err) { /* device info arrives as a JSON string */ }
    }
    return { name: parsed[0], data };
  } catch (err) {
    return null;
  }
}

function socketBase(socketIoUrl, socketIoPath) {
  const path = socketIoPath || '/socket.io';
  return `${String(socketIoUrl).replace(/\/$/, '')}${String(path).startsWith('/') ? '' : '/'}${path}`;
}

async function handleSocketPacket(uid, watcher, packet) {
  const event = socketEvent(packet);
  if (!event) return;
  const found = batteriesFromPayload(event.data);
  if (found.length) {
    await saveSocketBattery(uid, found);
    return;
  }
  if (event.name && watcher.seen && !watcher.seen.has(event.name)) {
    watcher.seen.add(event.name);
    console.log('Lovense socket event', event.name);
  }
}

async function pollBatterySocket(base, uid, watcher) {
  let opened = null;
  for (const eio of [3, 4]) {
    const openRes = await fetch(`${base}/?EIO=${eio}&transport=polling&t=${Date.now()}`, {
      signal: AbortSignal.timeout(8000)
    });
    const openText = await openRes.text();
    const openPacket = decodeEnginePayload(openText).find((packet) => packet.startsWith('0'));
    if (!openRes.ok || !openPacket) continue;
    let open;
    try { open = JSON.parse(openPacket.slice(1)); } catch (err) { continue; }
    if (!open || !open.sid) continue;
    opened = { eio, sid: open.sid, pingInterval: open.pingInterval || 25000, pingTimeout: open.pingTimeout || 20000 };
    break;
  }
  if (!opened) throw new Error('Lovense socket handshake failed');

  const { eio, sid } = opened;
  const post = async (packet) => {
    const body = eio === 3 ? `${packet.length}:${packet}` : packet;
    await fetch(`${base}/?EIO=${eio}&transport=polling&sid=${encodeURIComponent(sid)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body,
      signal: AbortSignal.timeout(8000)
    });
  };
  await post('40');
  console.log('Lovense socket open', eio);

  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  while (!watcher.stopped && Date.now() < deadline) {
    const poll = await fetch(`${base}/?EIO=${eio}&transport=polling&sid=${encodeURIComponent(sid)}&t=${Date.now()}`, {
      signal: AbortSignal.timeout(opened.pingInterval + opened.pingTimeout)
    });
    const text = await poll.text();
    if (!poll.ok) break;
    for (const packet of decodeEnginePayload(text)) {
      if (packet === '2') {
        await post('3');
        continue;
      }
      if (packet === '1' || packet.startsWith('41')) return;
      await handleSocketPacket(uid, watcher, packet);
    }
  }
}

async function readBatterySocket(uid, displayName, watcher) {
  let delay = 15000;
  while (!watcher.stopped) {
    try {
      const tokenRes = await fetch('https://api.lovense-api.com/api/basicApi/getToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: LOVENSE_TOKEN,
          uid,
          uname: displayName || uid
        }),
        signal: AbortSignal.timeout(8000)
      });
      const tokenData = await tokenRes.json();
      const authToken = tokenData && tokenData.data && tokenData.data.authToken;
      if (!authToken) {
        console.error('Lovense socket token failed:', tokenData && tokenData.code, tokenData && tokenData.message);
      } else {
        const urlRes = await fetch('https://api.lovense-api.com/api/basicApi/getSocketUrl', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: PLATFORM_NAME, authToken }),
          signal: AbortSignal.timeout(8000)
        });
        const urlData = await urlRes.json();
        const socketIoUrl = urlData && urlData.data && urlData.data.socketIoUrl;
        const socketIoPath = urlData && urlData.data && urlData.data.socketIoPath;
        if (!socketIoUrl) {
          console.error('Lovense socket url failed:', urlData && urlData.code, urlData && urlData.message);
        } else if (!watcher.stopped) {
          await pollBatterySocket(socketBase(socketIoUrl, socketIoPath), uid, watcher);
        }
      }
    } catch (err) {
      if (!watcher.stopped) console.error('Battery watch failed:', err.message);
      delay = String(err.message).includes('handshake') ? Math.min(delay * 2, 5 * 60 * 1000) : 15000;
    }
    if (watcher.stopped) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function preserveBattery(previousToys, incomingToys) {
  let prev = previousToys;
  let next = incomingToys;
  if (typeof prev === 'string') {
    try { prev = JSON.parse(prev); } catch (err) { prev = null; }
  }
  if (typeof next === 'string') {
    try { next = JSON.parse(next); } catch (err) { next = null; }
  }
  if (!next || typeof next !== 'object') return incomingToys;
  if (!prev || typeof prev !== 'object') return next;
  const copy = { ...next };
  for (const [id, toy] of Object.entries(copy)) {
    if (!toy || typeof toy !== 'object') continue;
    const old = prev[id] || Object.values(prev).find((item) => item && item.id === (toy.id || id));
    if (!old) continue;
    const patch = { ...toy };
    let changed = false;
    if (toyBattery(toy) == null && toyBattery(old) != null) {
      patch.battery = toyBattery(old);
      changed = true;
    }
    if ((!toy.fullFunctionNames || !toy.fullFunctionNames.length) && old.fullFunctionNames && old.fullFunctionNames.length) {
      patch.fullFunctionNames = old.fullFunctionNames;
      changed = true;
    } else if (!toy.functionsKnown && old.fullFunctionNames && old.fullFunctionNames.length) {
      patch.fullFunctionNames = old.fullFunctionNames;
      changed = true;
    }
    if (changed) copy[id] = patch;
  }
  return copy;
}

function localCommandUrl(connection) {
  if (!connection || !connection.domain || !connection.httpsPort) return null;
  return `https://${connection.domain}:${connection.httpsPort}/command`;
}

function commandOk(data) {
  return data && (data.code === 200 || data.code === 0 || data.result === true);
}

function postHttpsJson(url, headers, body, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: 'POST',
      rejectUnauthorized: false,
      timeout: timeoutMs || 1200,
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
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.write(data);
    req.end();
  });
}

async function sendLovenseCommand(uid, payload, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let response;
  try {
    response = await fetch('https://api.lovense-api.com/api/lan/v2/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: LOVENSE_TOKEN,
        uid,
        ...payload
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    return { code: response.status, message: text };
  }
}

function remoteOnlyHost(domain) {
  const host = String(domain || '');
  if (!host || host.includes('127-0-0-1')) return true;
  return /^(?:10|192-168|172-(?:1[6-9]|2\d|3[0-1]))-/.test(host);
}

const commandRoute = new Map();

async function sendToyCommand(uid, connection, payload, signal) {
  const domain = connection && connection.domain;
  const port = connection && (connection.httpsPort || connection.wssPort);
  if (commandRoute.get(uid) !== 'cloud' && domain && port && !remoteOnlyHost(domain)) {
    try {
      const lan = await postHttpsJson(
        `https://${domain}:${port}/command`,
        { 'X-platform': PLATFORM_NAME },
        payload,
        500,
        signal
      );
      if (commandOk(lan)) {
        commandRoute.set(uid, 'lan');
        return lan;
      }
      commandRoute.set(uid, 'cloud');
      console.error('LAN command rejected:', lan);
    } catch (err) {
      if (!signal || !signal.aborted) {
        commandRoute.set(uid, 'cloud');
        console.error('LAN command failed:', err.message);
      } else {
        throw err;
      }
    }
  }
  return sendLovenseCommand(uid, payload, signal);
}

const fades = new Map();

function percentToLevel(percent) {
  const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  if (p <= 0) return 0;
  return Math.max(1, Math.round((p * 20) / 100));
}

function scaledLevel(name, percent) {
  const max = FUNCTION_LIMITS[name] || 20;
  const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  if (p <= 0) return 0;
  if (max === 100) return p;
  return Math.max(1, Math.round((p * max) / 100));
}

function levelsToCommand(levels) {
  const scaled = {};
  for (const name of FUNCTION_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(levels, name)) continue;
    scaled[name] = scaledLevel(name, levels[name]);
  }
  const parts = [];
  for (const name of FUNCTION_ORDER) {
    if (name === 'Stroke' || name === 'Position') continue;
    if (scaled[name] > 0) parts.push(`${name}:${scaled[name]}`);
  }
  if (scaled.Stroke > 0 && (scaled.Thrusting > 0 || !parts.length)) {
    if (!parts.some((part) => part.startsWith('Thrusting:'))) parts.push('Thrusting:1');
    parts.push(`Stroke:0-${Math.max(20, scaled.Stroke)}`);
  }
  return { action: parts.join(','), position: scaled.Position > 0 ? scaled.Position : 0 };
}

function glideStrengths(from, to) {
  const start = Math.max(0, Math.min(20, from | 0));
  const end = Math.max(0, Math.min(20, to | 0));
  if (start === end) return [end];
  const span = Math.abs(end - start);
  const slots = Math.min(50, Math.max(span, 12));
  const eased = [];
  for (let i = 1; i <= slots; i++) {
    const t = i / slots;
    const curve = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    eased.push(Math.round(start + (end - start) * curve));
  }
  eased[eased.length - 1] = end;
  while (eased.length > 1 && eased[0] === start) eased.shift();
  return eased.slice(0, 50);
}

function fadePosition(state) {
  if (!state) return 0;
  if (!state.levels || !state.started) return state.at || 0;
  const stepMs = state.stepMs || 200;
  const index = Math.min(state.levels.length - 1, Math.floor((Date.now() - state.started) / stepMs));
  return state.levels[index];
}

function cancelFade(uid) {
  stopFollower(uid);
  const state = fades.get(uid);
  if (state) state.gen += 1;
  fades.set(uid, { gen: (state?.gen || 0) + 1, at: 0, levels: null, started: 0 });
}

function functionCommand(action, seconds, toyId, indefinite) {
  const command = {
    command: 'Function',
    action,
    timeSec: action === 'Stop' || indefinite ? 0 : Math.max(1, seconds),
    apiVer: 1,
    stopPrevious: 1
  };
  if (toyId && action !== 'Stop') command.toy = toyId;
  return command;
}

const SEND_GAP_MS = 60;
const STEP_MS = 50;

function clampLevel(value) {
  return Math.max(0, Math.min(20, value | 0));
}

const followers = new Map();

function stopFollower(uid) {
  const state = followers.get(uid);
  if (!state) return;
  state.gen += 1;
  if (state.abort) state.abort.abort();
  if (state.timer) clearTimeout(state.timer);
  followers.delete(uid);
}

function ensureFollower(uid) {
  let state = followers.get(uid);
  if (!state) {
    state = {
      gen: 1,
      at: 0,
      target: 0,
      until: 0,
      sentAt: 0,
      nextSendAt: 0,
      playStarted: 0,
      playUntil: 0,
      steps: null,
      flat: false,
      hold: false,
      busy: false,
      seq: 0,
      sending: null,
      abort: null,
      timer: null,
      lastResult: { code: 200, result: true }
    };
    followers.set(uid, state);
  }
  return state;
}

function buildRamp(from, to) {
  const start = clampLevel(from);
  const end = clampLevel(to);
  if (start === end) return [end];
  const sign = end > start ? 1 : -1;
  const steps = [];
  for (let level = start + sign; level !== end + sign && steps.length < 20; level += sign) {
    steps.push(level);
  }
  return steps;
}

function glideSteps(from, to) {
  const start = clampLevel(from);
  const end = clampLevel(to);
  const sign = end === start ? 0 : (end > start ? 1 : -1);
  const distance = Math.min(4, Math.abs(end - start));
  const steps = [];
  let level = start;
  for (let i = 0; i < distance; i++) {
    level += sign;
    steps.push(level);
  }
  if (!steps.length) steps.push(end);
  const landed = steps[steps.length - 1];
  const rampLen = steps.length;
  while (steps.length < rampLen + 12 && steps.length < 50) steps.push(landed);
  return steps;
}

function playingLevel(state) {
  if (!state) return 0;
  if (state.flat || !state.steps || !state.playStarted) return clampLevel(state.at || 0);
  const index = Math.min(state.steps.length - 1, Math.floor((Date.now() - state.playStarted) / STEP_MS));
  return state.steps[index];
}

async function sendGlide(uid, connection, toyId, steps, signal) {
  const pattern = {
    command: 'Pattern',
    rule: 'V:1;F:v;S:50#',
    strength: steps.join(';'),
    timeSec: Math.max(0.2, Math.round(steps.length * STEP_MS) / 1000),
    apiVer: 2,
    stopPrevious: 1
  };
  if (toyId) pattern.toy = toyId;
  return sendToyCommand(uid, connection, pattern, signal);
}

async function sendCustomPattern(uid, connection, toyId, steps, timeSec) {
  const pattern = {
    command: 'Pattern',
    rule: 'V:1;F:v;S:200#',
    strength: steps.join(';'),
    timeSec,
    apiVer: 2
  };
  if (toyId) pattern.toy = toyId;
  return sendToyCommand(uid, connection, pattern);
}

function schedulePlan(uid, delay) {
  const state = followers.get(uid);
  if (!state || state.busy) return;
  const wait = Math.max(0, delay || 0);
  if (state.timer) {
    if (state.timerWait != null && state.timerWait <= wait) return;
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.timerWait = wait;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.timerWait = null;
    planLevel(uid).catch((err) => console.error('Slider command failed:', err.message));
  }, wait);
}

async function planLevel(uid) {
  const state = followers.get(uid);
  if (!state || state.busy || state.local) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
    state.timerWait = null;
  }
  const target = clampLevel(state.target);
  const holding = !!(state.hold && target !== 0);
  if (!holding && Date.now() >= state.until && target !== 0) return;
  if (Date.now() < state.nextSendAt && target !== 0) {
    schedulePlan(uid, state.nextSendAt - Date.now());
    return;
  }
  const from = playingLevel(state);
  if (target !== 0 && state.rampUntil && Date.now() < state.rampUntil && state.heading) {
    const want = Math.sign(target - from);
    if (want === 0 || want === state.heading) {
      schedulePlan(uid, state.rampUntil - Date.now());
      return;
    }
  }
  if (target !== 0 && from === target && state.flat && (holding || Date.now() < state.until)) return;

  const gen = state.gen;
  state.busy = true;
  state.sending = target;
  if (state.abort) state.abort.abort();
  const abort = new AbortController();
  state.abort = abort;
  const steps = target === 0 || from === target ? null : glideSteps(from, target);
  try {
    const seconds = holding ? 0 : Math.max(1, Math.ceil((state.until - Date.now()) / 1000));
      const result = steps
      ? await sendGlide(uid, state.connection, state.toyId, steps, abort.signal)
      : await sendToyCommand(
        uid,
        state.connection,
        target === 0
          ? functionCommand('Stop', 0, state.toyId)
          : functionCommand(`Vibrate:${target}`, seconds, state.toyId, holding),
        abort.signal
      );
    state.lastResult = result;
    if (!followers.get(uid) || state.gen !== gen || state.local) return;
    if (!commandOk(result)) {
      console.error('Slider command rejected:', result && result.code, result && result.message);
      state.nextSendAt = Date.now() + 200;
      return;
    }
    const started = Date.now();
    const liveTarget = clampLevel(state.target);
    state.sentAt = started;
    state.nextSendAt = started + SEND_GAP_MS;
    if (steps) {
      const rampCount = steps.findIndex((level, index) => index > 0 && level === steps[index - 1]);
      const rampSteps = rampCount === -1 ? 1 : rampCount;
      const landed = steps[Math.max(0, rampSteps - 1)];
      state.flat = false;
      state.steps = steps;
      state.at = landed;
      state.heading = Math.sign(landed - from) || state.heading || 0;
      state.playStarted = started;
      state.rampUntil = started + rampSteps * STEP_MS;
      state.playUntil = started + steps.length * STEP_MS;
      const want = Math.sign(liveTarget - landed);
      if (liveTarget === 0 || (want && state.heading && want !== state.heading)) {
        state.refreshAt = started;
      } else if (landed === liveTarget) {
        state.refreshAt = Math.max(state.rampUntil, state.playUntil - 250);
      } else {
        state.refreshAt = state.rampUntil;
      }
    } else {
      state.flat = true;
      state.steps = null;
      state.at = target;
      state.heading = 0;
      state.rampUntil = 0;
      state.playStarted = started;
      state.playUntil = target === 0 ? 0 : (holding ? state.until : started + seconds * 1000);
      state.refreshAt = 0;
    }
  } catch (err) {
    const aborted = abort.signal.aborted || err.name === 'AbortError' || err.message === 'aborted';
    if (!aborted) {
      console.error('Slider command failed:', err.message);
      state.lastResult = { code: 500, message: err.message };
      state.nextSendAt = Date.now() + 200;
      state.flat = false;
    }
  } finally {
    const current = followers.get(uid);
    if (current && current.gen === gen) {
      current.busy = false;
      if (current.local) {
        current.refreshAt = 0;
      } else if (current.refreshAt) {
        const wait = Math.max(0, current.refreshAt - Date.now());
        current.refreshAt = 0;
        schedulePlan(uid, wait);
      } else if (clampLevel(current.target) !== current.at && (current.hold || Date.now() < current.until || clampLevel(current.target) === 0)) {
        schedulePlan(uid, Math.max(0, current.nextSendAt - Date.now()));
      }
    }
  }
}

async function sendSmoothLevel(uid, connection, toyId, target, seconds, hold, seq) {
  const state = ensureFollower(uid);
  if (seq && state.seq && seq < state.seq) return state.lastResult || { code: 200, result: true };
  state.connection = connection;
  state.toyId = toyId || state.toyId;
  if (seq) state.seq = seq;
  state.target = clampLevel(target);
  state.hold = !!hold && state.target !== 0;
  state.until = state.hold
    ? Number.POSITIVE_INFINITY
    : Date.now() + Math.max(1, seconds) * 1000;
  const takeOver = !!state.local;
  state.local = false;
  if (state.busy) {
    if (state.target === 0 && state.abort) state.abort.abort();
    return state.lastResult || { code: 200, result: true };
  }
  if (!takeOver && state.flat && state.at === state.target && (state.target === 0 || state.hold || Date.now() < state.until)) {
    return state.lastResult || { code: 200, result: true };
  }
  if (state.target !== 0 && Date.now() < state.nextSendAt) {
    schedulePlan(uid, state.nextSendAt - Date.now());
    return state.lastResult || { code: 200, result: true };
  }
  await planLevel(uid);
  return state.lastResult || { code: 200, result: true };
}

const GRANT_MINUTES = new Set([1, 5, 10, 15, 30, 60]);
const guestStops = new Map();

function clearGuestStop(wearer) {
  const prev = guestStops.get(wearer);
  if (!prev) return;
  clearTimeout(prev.timer);
  guestStops.delete(wearer);
}

async function stopWearerToy(wearer) {
  const session = await getSession(wearer);
  if (!session || !session.connection) return;
  cancelFade(wearer);
  await sendToyCommand(wearer, session.connection, {
    command: 'Function',
    action: 'Stop',
    timeSec: 0,
    apiVer: 1,
    stopPrevious: 1
  });
  await db.query(
    `UPDATE active_sessions SET vibe_strength = 0, vibe_until = NOW() WHERE sl_uuid = $1`,
    [wearer]
  );
}

function armGuestStop(wearer, token, secondsLeft) {
  clearGuestStop(wearer);
  const delay = Math.max(0, secondsLeft * 1000);
  const timer = setTimeout(() => {
    guestStops.delete(wearer);
    finishGrant(token, wearer).catch((err) => console.error("Grant stop failed:", err));
  }, delay);
  guestStops.set(wearer, { timer, token });
}

async function finishGrant(token, wearer) {
  const done = await db.query(
    `UPDATE control_grants
     SET seconds_left = 0, running_since = NULL
     WHERE token = $1 AND running_since IS NOT NULL
     RETURNING token`,
    [token]
  );
  if (!done.rows.length) return;
  await stopWearerToy(wearer);
}

function grantRemaining(row) {
  let left = parseInt(row.seconds_left, 10);
  if (Number.isNaN(left)) {
    left = Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000);
  }
  if (row.running_since) {
    const elapsed = Math.max(0, (Date.now() - new Date(row.running_since).getTime()) / 1000);
    left -= elapsed;
  }
  return Math.max(0, Math.floor(left));
}

async function readGrant(token) {
  const result = await db.query(
    `SELECT seconds_left, running_since, expires_at FROM control_grants WHERE token = $1`,
    [token]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return { secondsLeft: grantRemaining(row), running: !!row.running_since };
}

async function pauseGrant(token) {
  const paused = await db.query(
    `UPDATE control_grants
     SET seconds_left = GREATEST(
           0,
           seconds_left - GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - running_since)))::int)
         ),
         running_since = NULL
     WHERE token = $1 AND running_since IS NOT NULL
     RETURNING seconds_left`,
    [token]
  );
  if (paused.rows.length) return parseInt(paused.rows[0].seconds_left, 10) || 0;
  const current = await readGrant(token);
  return current ? current.secondsLeft : 0;
}

async function beginGrantRun(token) {
  const started = await db.query(
    `UPDATE control_grants
     SET running_since = COALESCE(running_since, NOW())
     WHERE token = $1 AND seconds_left > 1
     RETURNING seconds_left, running_since, expires_at`,
    [token]
  );
  if (!started.rows.length) return null;
  const secondsLeft = grantRemaining(started.rows[0]);
  if (secondsLeft <= 1) return null;
  return { secondsLeft, running: true };
}

async function startGuestClock(actor, wearer) {
  const run = await beginGrantRun(actor.token);
  if (!run) return null;
  const secondsLeft = Math.min(run.secondsLeft, actor.secondsLeft || run.secondsLeft);
  if (secondsLeft <= 1) return null;
  armGuestStop(wearer, actor.token, secondsLeft);
  return { seconds_left: secondsLeft, running: true };
}

async function stopGuestClock(actor, wearer) {
  clearGuestStop(wearer);
  const left = await pauseGrant(actor.token);
  return { seconds_left: left, running: false };
}

const releasedAt = new Map();

function releaseOwnerTakeover(wearer) {
  const now = Date.now();
  if (now - (releasedAt.get(wearer) || 0) < 5000) return;
  releasedAt.set(wearer, now);
  releaseGuestRun(wearer).catch((err) => console.error('Release guest run failed:', err.message));
}

async function releaseGuestRun(wearer) {
  clearGuestStop(wearer);
  await db.query(
    `UPDATE control_grants
     SET seconds_left = GREATEST(
           0,
           seconds_left - GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - running_since)))::int)
         ),
         running_since = NULL
     WHERE wearer_uuid = $1 AND running_since IS NOT NULL`,
    [wearer]
  );
}

async function resolveControl(body) {
  const token = String((body && body.grant_token) || '');
  if (token) {
    if (!token || token.length > 80) return { error: "This control link is not valid.", status: 404 };
    const result = await db.query(
      `SELECT wearer_uuid, expires_at, sender_name, seconds_left, running_since, hud_mode, rate, hard_expire FROM control_grants WHERE token = $1`,
      [token]
    );
    if (!result.rows.length) return { error: "This control link is not valid.", status: 404 };
    const row = result.rows[0];
    let secondsLeft = grantRemaining(row);
    if (row.hard_expire) {
      const wall = Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000);
      secondsLeft = Math.min(secondsLeft, Math.max(0, wall));
    }
    if (secondsLeft <= 0) {
      if (row.running_since) {
        await db.query(
          `UPDATE control_grants SET seconds_left = 0, running_since = NULL WHERE token = $1`,
          [token]
        );
      }
      if (hudMode(row.hud_mode) === 'hooker') {
        return {
          wearer: row.wearer_uuid,
          guest: true,
          expiresAt: new Date(row.expires_at),
          senderName: row.sender_name || '',
          token,
          secondsLeft: 0,
          running: false,
          hudMode: 'hooker',
          rate: Math.max(1, Number(row.rate) || LINDENS_PER_MINUTE)
        };
      }
      return { error: "This control time is used up.", status: 403 };
    }
    return {
      wearer: row.wearer_uuid,
      guest: true,
      expiresAt: new Date(row.expires_at),
      senderName: row.sender_name || '',
      token,
      secondsLeft,
      running: !!row.running_since,
      hudMode: hudMode(row.hud_mode),
      rate: Math.max(1, Number(row.rate) || LINDENS_PER_MINUTE)
    };
  }
  const wearer = String((body && (body.wearer_uuid || body.sl_uuid)) || '');
  if (!wearer || wearer.length > 80) return { error: "Missing wearer_uuid.", status: 400 };
  return { wearer, guest: false, expiresAt: null };
}

function hudMode(raw) {
  return String(raw || '').toLowerCase() === 'hooker' ? 'hooker' : 'normal';
}

const LINDENS_PER_MINUTE = 30;
const MAX_SPAN_SECONDS = 6 * 30 * 24 * 60 * 60;
const MAX_PRICE = 2147483647;

function spanSeconds(body) {
  const seconds = parseInt(body && body.seconds, 10);
  if (Number.isFinite(seconds) && seconds >= 1) return seconds;
  const minutes = parseInt(body && body.minutes, 10);
  if (Number.isFinite(minutes) && minutes >= 1) return minutes * 60;
  return 0;
}

function offerPrice(seconds, rate) {
  const price = Math.round((seconds / 60) * rate);
  if (!Number.isFinite(price) || price < 1 || price > MAX_PRICE) return 0;
  return price;
}

function secondsForPayment(amount, rate) {
  return Math.max(1, Math.min(86400, Math.round((amount / rate) * 60)));
}

function offerLabel(seconds) {
  seconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const units = [
    [2592000, 'month'],
    [604800, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute']
  ];
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      const count = seconds / size;
      return count + ' ' + name + (count === 1 ? '' : 's');
    }
  }
  if (seconds < 60) return seconds === 1 ? '1 second' : seconds + ' seconds';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes + (minutes === 1 ? ' minute ' : ' minutes ') + rest + (rest === 1 ? ' second' : ' seconds');
}

function limitSeconds(seconds, actor) {
  if (!actor.guest) return { seconds };
  const left = actor.secondsLeft;
  if (left <= 1) return { error: "This control time is used up.", status: 403 };
  if (seconds <= 0) return { seconds: 0 };
  return { seconds: Math.min(seconds, left) };
}

const HOLD_DB_SECONDS = 365 * 24 * 60 * 60;

function wantsHold(body, actor, stopping) {
  if (!body || actor.guest || stopping) return false;
  return body.hold === true || body.hold === 'true' || body.hold === 1;
}

const linkCache = new Map();

function forgetLink(uid) {
  linkCache.delete(uid);
  commandRoute.delete(uid);
}

async function linkForCommand(uid) {
  const hit = linkCache.get(uid);
  if (hit && hit.session && hit.session.status === 'connected' && hit.session.connection && Date.now() - hit.at < 20000) {
    return hit.session;
  }
  const session = await getSession(uid);
  if (session && session.status === 'connected' && session.connection) {
    linkCache.set(uid, { at: Date.now(), session });
  }
  return session;
}

async function getSession(slUuid) {
  const result = await db.query(
    `SELECT sl_uuid, sl_http_url, status, toys, display_name, shared, vibe_strength, vibe_until, hud_mode
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
      `INSERT INTO active_sessions (sl_uuid, sl_http_url, status, lovense_token, display_name, shared, vibe_until)
       VALUES ($1, $2, 'pending', $3, $4, false, NOW())
       ON CONFLICT (sl_uuid) DO UPDATE SET
         sl_http_url = $2,
         status = CASE WHEN active_sessions.status = 'connected' THEN 'connected' ELSE 'pending' END,
         lovense_token = $3,
         display_name = $4,
         toys = CASE WHEN active_sessions.status = 'connected' THEN active_sessions.toys ELSE NULL END,
         shared = CASE WHEN active_sessions.status = 'connected' THEN active_sessions.shared ELSE false END,
         vibe_strength = CASE WHEN active_sessions.status = 'connected' THEN active_sessions.vibe_strength ELSE 0 END,
         vibe_until = CASE WHEN active_sessions.status = 'connected' THEN active_sessions.vibe_until ELSE NOW() END`,
      [sl_uuid, sl_http_url, utoken, sl_name || sl_uuid]
    );

    const qrResponse = await fetch('https://api.lovense-api.com/api/lan/v2/qrcode', {
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

    let qrData = await qrResponse.json();
    let qrImage = qrData && qrData.data && (qrData.data.qrcodeUrl || qrData.data.qr);
    if (!qrImage) {
      console.error('Lovense v2 qrcode failed:', qrData && qrData.code, qrData && qrData.message);
      const legacy = await fetch('https://api.lovense-api.com/api/lan/getQrCode', {
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
      qrData = await legacy.json();
      qrImage = qrData && qrData.data && qrData.data.qr;
    }
    if (!qrImage) {
      console.error('Lovense getQrCode failed:', qrData && qrData.code, qrData && qrData.message);
      return res.status(502).json({
        error: "Lovense did not return a QR code.",
        details: (qrData && qrData.message) || "No QR image"
      });
    }

    brandedQrs.set(sl_uuid, await makeBrandedQr(qrImage));

    const pairingUrl = `${publicBase(req)}/pair/${encodeURIComponent(sl_uuid)}?qr=${encodeURIComponent(qrImage)}`;

    return res.json({
      success: true,
      message: "Scan the QR code with Lovense Remote to link your toy.",
      qr: qrImage,
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
  if (!/^https:\/\/([\w.-]+\.)?(lovense\.com|lovense-api\.com)\//i.test(src)) {
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
  <title>Mālama Hōkū</title>
  <style>
    body { font-family: sans-serif; background: #111; color: #eee; text-align: center; padding: 24px; }
    img.logo { width: 240px; height: 240px; border-radius: 50%; object-fit: cover; display: block; margin: 0 auto 8px; }
    #qr { width: 260px; height: 260px; background: #fff; padding: 12px; border-radius: 8px; }
    #status { margin-top: 16px; font-size: 18px; }
    a { color: #ff7ad9; }
  </style>
</head>
<body>
  <img class="logo" src="/logo.png" alt="Mālama Hōkū">
  <h1>Mālama Hōkū</h1>
  <p>Open Lovense Remote, use Scan QR, then wait until this page says connected.</p>
  <img id="qr" src="${qrSrc}" alt="Lovense QR code">
  <p id="status">Waiting for scan…</p>
  <script>
    const statusEl = document.getElementById("status");
    const qr = document.getElementById("qr");
    const started = Date.now();
    qr.onerror = () => {
      if (!qr.dataset.fallback) {
        qr.dataset.fallback = "1";
        qr.src = ${JSON.stringify(fallbackSrc)};
        return;
      }
      statusEl.textContent = "This code expired. Touch Link toy in Second Life and scan the new one.";
    };
    async function poll() {
      try {
        const r = await fetch(${JSON.stringify(statusUrl)});
        const data = await r.json();
        if (data.status === "connected") {
          statusEl.innerHTML = 'Connected! <a href="${controlUrl}">Open toy controls</a>';
          return;
        }
        const waited = Date.now() - started;
        statusEl.textContent = waited < 20000
          ? "Waiting for scan…"
          : "Still waiting. In Lovense Remote, open Scan and point it at this code.";
      } catch (e) {
        statusEl.textContent = "The page can't reach the server. Touch Link toy again.";
      }
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
      toy_line: connected ? toyLine(toys) : 'No toy',
      hud_mode: hudMode(session.hud_mode)
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

app.post('/api/hud/mode', async (req, res) => {
  const wearer = String(req.body.sl_uuid || req.body.wearer_uuid || '');
  const mode = hudMode(req.body.mode);
  if (!wearer) return res.status(400).json({ error: "Missing wearer." });
  try {
    const updated = await db.query(
      `UPDATE active_sessions SET hud_mode = $2 WHERE sl_uuid = $1 RETURNING hud_mode`,
      [wearer, mode]
    );
    if (!updated.rows.length) return res.status(404).json({ error: "Link your toy first." });
    return res.json({ success: true, hud_mode: mode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not switch the HUD." });
  }
});

app.post('/api/hud/grant', async (req, res) => {
  const wearer = String(req.body.sl_uuid || '');
  const recipient = String(req.body.recipient_uuid || '');
  const recipientName = String(req.body.recipient_name || 'someone').replace(/[\r\n\t]/g, ' ').trim().slice(0, 64) || 'someone';
  const sentName = String(req.body.sender_name || '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
  const minutes = parseInt(req.body.minutes, 10);
  if (!wearer || !recipient) return res.status(400).json({ error: "Missing avatar." });
  if (!GRANT_MINUTES.has(minutes)) return res.status(400).json({ error: "Pick 1, 5, 10, 15, 30, or 60 minutes." });
  if (recipient === wearer) return res.status(400).json({ error: "Pick someone else." });

  try {
    const session = await getSession(wearer);
    if (!session || session.status !== 'connected') {
      return res.status(404).json({ error: "Link your toy before sending a control link." });
    }
    const senderName = sentName || String(session.display_name || '').trim();
    const mode = hudMode(req.body.mode || session.hud_mode);
    const token = crypto.randomBytes(18).toString('hex');
    const hardExpire = req.body.hard_expire === true || String(req.body.hard_expire || '') === '1' || String(req.body.hard_expire || '') === 'true';
    await db.query(
      `INSERT INTO control_grants (token, wearer_uuid, recipient_uuid, recipient_name, sender_name, seconds_left, hud_mode, expires_at, hard_expire)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 * INTERVAL '1 minute'), $9)`,
      [token, wearer, recipient, recipientName, senderName || null, minutes * 60, mode, minutes, hardExpire]
    );
    if (senderName) {
      await db.query(
        `UPDATE active_sessions SET display_name = $2 WHERE sl_uuid = $1`,
        [wearer, senderName]
      );
    }
    return res.json({
      success: true,
      minutes,
      control_url: `${publicBase(req)}/guest/${token}`
    });
  } catch (err) {
    console.error("Grant error:", err);
    res.status(500).json({ error: "Could not create the control link." });
  }
});

app.post('/api/hud/visit-link', async (req, res) => {
  const wearer = String(req.body.sl_uuid || '');
  const recipient = String(req.body.recipient_uuid || '');
  const recipientName = String(req.body.recipient_name || 'someone').replace(/[\r\n\t]/g, ' ').trim().slice(0, 64) || 'someone';
  const sentName = String(req.body.sender_name || '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
  const seconds = spanSeconds(req.body);
  const rate = Math.min(10000, Math.max(1, parseInt(req.body.per_minute, 10) || 0));
  if (!wearer || !recipient) return res.status(400).json({ error: "Missing avatar." });
  if (recipient === wearer) return res.status(400).json({ error: "Pick someone else." });
  if (!seconds || seconds > MAX_SPAN_SECONDS) return res.status(400).json({ error: "Pick a time from 1 second up to 6 months." });
  if (!rate) return res.status(400).json({ error: "Missing price." });

  try {
    const session = await getSession(wearer);
    const senderName = sentName || String((session && session.display_name) || '').trim();
    const token = crypto.randomBytes(18).toString('hex');
    const minutes = Math.max(1, Math.round(seconds / 60));
    await db.query(
      `INSERT INTO control_grants (token, wearer_uuid, recipient_uuid, recipient_name, sender_name, seconds_left, hud_mode, rate, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::int, 'hooker', $7::int, NOW() + ($8::int * INTERVAL '1 second'))`,
      [token, wearer, recipient, recipientName, senderName || null, seconds, rate, seconds]
    );
    return res.json({
      success: true,
      minutes,
      control_url: `${publicBase(req)}/guest/${token}`
    });
  } catch (err) {
    console.error("Visit link error:", err);
    res.status(500).json({ error: "Could not create the control link." });
  }
});

app.post('/api/hud/offer', async (req, res) => {
  const wearer = String(req.body.sl_uuid || '');
  const recipient = String(req.body.recipient_uuid || '');
  const recipientName = String(req.body.recipient_name || 'someone').replace(/[\r\n\t]/g, ' ').trim().slice(0, 64) || 'someone';
  const sentName = String(req.body.sender_name || '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
  const seconds = spanSeconds(req.body);
  if (!wearer || !recipient) return res.status(400).json({ error: "Missing avatar." });
  if (recipient === wearer) return res.status(400).json({ error: "Pick someone else." });
  if (!seconds || seconds > MAX_SPAN_SECONDS) {
    return res.status(400).json({ error: "Pick a time from 1 second up to 6 months." });
  }

  try {
    const session = await getSession(wearer);
    if (!session || session.status !== 'connected') {
      return res.status(404).json({ error: "Link your toy before sending an offer." });
    }
    if (hudMode(session.hud_mode) !== 'hooker') {
      await db.query(`UPDATE active_sessions SET hud_mode = 'hooker' WHERE sl_uuid = $1`, [wearer]);
    }
    const senderName = sentName || String(session.display_name || '').trim() || 'Someone';
    const rate = Math.min(10000, Math.max(1, parseInt(req.body.per_minute, 10) || LINDENS_PER_MINUTE));
    const price = offerPrice(seconds, rate);
    if (!price) return res.status(400).json({ error: "That price is too large. Pick a shorter time." });
    const label = offerLabel(seconds);
    const id = crypto.randomBytes(18).toString('hex');
    await db.query(`UPDATE control_offers SET status = 'cancelled' WHERE wearer_uuid = $1 AND status = 'pending'`, [wearer]);
    await db.query(
      `INSERT INTO control_offers (id, wearer_uuid, recipient_uuid, recipient_name, sender_name, seconds, price, rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, wearer, recipient, recipientName, senderName, seconds, price, rate]
    );
    return res.json({
      success: true,
      offer_id: id,
      price,
      seconds,
      rate,
      label,
      offer_url: `${publicBase(req)}/offer/${id}`
    });
  } catch (err) {
    console.error("Offer error:", err);
    res.status(500).json({ error: "Could not send the offer." });
  }
});

app.get('/api/hud/pay-state', async (req, res) => {
  const wearer = String(req.query.sl_uuid || '');
  const hidden = { mode: 'hide', price: 0, offer_id: '', label: '', recipient_uuid: '', rate: 0 };
  if (!wearer) return res.status(400).json({ error: "Missing avatar." });
  try {
    const session = await getSession(wearer);
    if (!session || session.status !== 'connected') return res.json(hidden);
    const pending = await db.query(
      `SELECT id, recipient_uuid, price, seconds, rate
       FROM control_offers
       WHERE wearer_uuid = $1 AND status = 'pending'
         AND created_at > NOW() - INTERVAL '15 minutes'
       ORDER BY created_at DESC
       LIMIT 1`,
      [wearer]
    );
    if (pending.rows.length) {
      const offer = pending.rows[0];
      return res.json({
        mode: 'offer',
        price: Number(offer.price),
        offer_id: offer.id,
        label: offerLabel(offer.seconds),
        recipient_uuid: offer.recipient_uuid,
        rate: Math.max(1, Number(offer.rate) || LINDENS_PER_MINUTE)
      });
    }
    if (hudMode(session.hud_mode) !== 'hooker') return res.json(hidden);
    const grant = await db.query(
      `SELECT recipient_uuid, rate
       FROM control_grants
       WHERE wearer_uuid = $1 AND hud_mode = 'hooker'
         AND recipient_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       ORDER BY created_at DESC
       LIMIT 1`,
      [wearer]
    );
    if (!grant.rows.length) return res.json(hidden);
    const rate = Math.max(1, Number(grant.rows[0].rate) || LINDENS_PER_MINUTE);
    return res.json({
      mode: 'add',
      price: rate,
      offer_id: '',
      label: '',
      recipient_uuid: grant.rows[0].recipient_uuid,
      rate
    });
  } catch (err) {
    console.error("Pay state error:", err);
    res.status(500).json({ error: "Could not read the open payment." });
  }
});

app.post('/api/hud/offer/accept', async (req, res) => {
  const wearer = String(req.body.sl_uuid || '');
  const offerId = String(req.body.offer_id || '');
  const recipient = String(req.body.recipient_uuid || '');
  const amount = parseInt(req.body.amount, 10);
  if (!wearer || !offerId || !recipient) return res.status(400).json({ error: "Missing offer." });

  try {
    const found = await db.query(
      `SELECT * FROM control_offers
       WHERE id = $1 AND wearer_uuid = $2 AND status = 'pending'
         AND created_at > NOW() - INTERVAL '15 minutes'`,
      [offerId, wearer]
    );
    if (!found.rows.length) return res.status(404).json({ error: "That offer is no longer open." });
    const offer = found.rows[0];
    if (offer.recipient_uuid !== recipient) return res.status(403).json({ error: "This offer is for someone else." });
    if (amount !== Number(offer.price)) return res.status(400).json({ error: "The payment does not match the price." });

    const session = await getSession(wearer);
    if (!session || session.status !== 'connected') {
      return res.status(404).json({ error: "The toy is not connected." });
    }

    const token = crypto.randomBytes(18).toString('hex');
    await db.query(
      `INSERT INTO control_grants (token, wearer_uuid, recipient_uuid, recipient_name, sender_name, seconds_left, hud_mode, rate, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::int, 'hooker', $7::int, NOW() + ($8::int * INTERVAL '1 second'))`,
      [token, wearer, recipient, offer.recipient_name, offer.sender_name, Number(offer.seconds), Math.max(1, Number(offer.rate) || LINDENS_PER_MINUTE), Number(offer.seconds)]
    );
    await db.query(`UPDATE control_offers SET status = 'paid', grant_token = $2 WHERE id = $1`, [offerId, token]);
    return res.json({
      success: true,
      price: offer.price,
      label: offerLabel(offer.seconds),
      control_url: `${publicBase(req)}/guest/${token}`
    });
  } catch (err) {
    console.error("Offer accept error:", err);
    res.status(500).json({ error: "Could not start the paid time." });
  }
});

app.post('/api/hud/offer/extend', async (req, res) => {
  const wearer = String(req.body.sl_uuid || '');
  const recipient = String(req.body.recipient_uuid || '');
  const amount = parseInt(req.body.amount, 10);
  const rate = Math.min(10000, Math.max(1, parseInt(req.body.per_minute, 10) || LINDENS_PER_MINUTE));
  if (!wearer || !recipient) return res.status(400).json({ error: "Missing avatar." });
  if (!amount || amount < 1) return res.status(400).json({ error: "Missing payment." });

  try {
    const found = await db.query(
      `SELECT token, seconds_left, running_since
       FROM control_grants
       WHERE wearer_uuid = $1 AND recipient_uuid = $2 AND hud_mode = 'hooker'
       ORDER BY created_at DESC
       LIMIT 1`,
      [wearer, recipient]
    );
    if (!found.rows.length) return res.status(404).json({ error: "No paid time to add to." });
    const added = secondsForPayment(amount, rate);
    const updated = await db.query(
      `UPDATE control_grants
       SET seconds_left = COALESCE(seconds_left, 0) + $2,
           rate = $3
       WHERE token = $1
       RETURNING seconds_left, running_since`,
      [found.rows[0].token, added, rate]
    );
    const row = updated.rows[0];
    return res.json({
      success: true,
      seconds_added: added,
      seconds_left: grantRemaining(row),
      label: offerLabel(added),
      rate,
      control_url: `${publicBase(req)}/guest/${found.rows[0].token}`
    });
  } catch (err) {
    console.error("Offer extend error:", err);
    res.status(500).json({ error: "Could not add the time." });
  }
});

app.post('/api/hud/grant/:token/add', async (req, res) => {
  const minutes = Math.min(60, Math.max(1, parseInt(req.body.minutes, 10) || 0));
  if (!minutes) return res.status(400).json({ error: "Pick how many minutes." });
  try {
    const grant = await db.query(
      `SELECT token, wearer_uuid, recipient_uuid, rate, hud_mode
       FROM control_grants WHERE token = $1`,
      [String(req.params.token || '')]
    );
    if (!grant.rows.length) return res.status(404).json({ error: "This control link is not valid." });
    const row = grant.rows[0];
    if (hudMode(row.hud_mode) !== 'hooker') return res.status(400).json({ error: "More time is only for this page." });
    const rate = Math.max(1, Number(row.rate) || LINDENS_PER_MINUTE);
    const price = minutes * rate;
    const id = crypto.randomBytes(9).toString('hex');
    await db.query(
      `UPDATE time_adds SET status = 'replaced'
       WHERE wearer_uuid = $1 AND recipient_uuid = $2 AND status = 'pending'`,
      [row.wearer_uuid, row.recipient_uuid]
    );
    await db.query(
      `INSERT INTO time_adds (id, wearer_uuid, recipient_uuid, minutes, price, rate)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, row.wearer_uuid, row.recipient_uuid, minutes, price, rate]
    );
    return res.json({ id, minutes, price, rate, label: offerLabel(minutes * 60) });
  } catch (err) {
    console.error("Add time request error:", err);
    res.status(500).json({ error: "Could not send that choice." });
  }
});

app.get('/api/hud/add-request', async (req, res) => {
  const wearer = String(req.query.sl_uuid || '');
  if (!wearer) return res.status(400).json({ error: "Missing avatar." });
  try {
    const found = await db.query(
      `SELECT id, recipient_uuid, minutes, price, rate
       FROM time_adds
       WHERE wearer_uuid = $1 AND status = 'pending'
         AND created_at > NOW() - INTERVAL '15 minutes'
       ORDER BY created_at DESC
       LIMIT 1`,
      [wearer]
    );
    if (!found.rows.length) return res.json({ id: "" });
    const row = found.rows[0];
    return res.json({
      id: row.id,
      recipient_uuid: row.recipient_uuid,
      minutes: Number(row.minutes),
      price: Number(row.price),
      rate: Number(row.rate),
      label: offerLabel(Number(row.minutes) * 60)
    });
  } catch (err) {
    console.error("Add request lookup error:", err);
    res.status(500).json({ error: "Could not read the time choice." });
  }
});

app.post('/api/hud/add-request/confirm', async (req, res) => {
  const wearer = String(req.body.sl_uuid || '');
  const requestId = String(req.body.request_id || '');
  if (!wearer || !requestId) return res.status(400).json({ error: "Missing time choice." });
  try {
    const found = await db.query(
      `SELECT * FROM time_adds
       WHERE id = $1 AND wearer_uuid = $2 AND status = 'pending'
         AND created_at > NOW() - INTERVAL '15 minutes'`,
      [requestId, wearer]
    );
    if (!found.rows.length) return res.status(404).json({ error: "That time choice is no longer open." });
    const add = found.rows[0];
    const grant = await db.query(
      `SELECT token FROM control_grants
       WHERE wearer_uuid = $1 AND recipient_uuid = $2 AND hud_mode = 'hooker'
       ORDER BY created_at DESC
       LIMIT 1`,
      [wearer, add.recipient_uuid]
    );
    if (!grant.rows.length) return res.status(404).json({ error: "No paid time to add to." });
    const added = Number(add.minutes) * 60;
    const updated = await db.query(
      `UPDATE control_grants
       SET seconds_left = COALESCE(seconds_left, 0) + $2,
           rate = $3
       WHERE token = $1
       RETURNING seconds_left, running_since`,
      [grant.rows[0].token, added, Number(add.rate)]
    );
    await db.query(`UPDATE time_adds SET status = 'confirmed' WHERE id = $1`, [requestId]);
    return res.json({
      success: true,
      seconds_added: added,
      seconds_left: grantRemaining(updated.rows[0]),
      label: offerLabel(added)
    });
  } catch (err) {
    console.error("Add time confirm error:", err);
    res.status(500).json({ error: "Could not add the time." });
  }
});

app.post('/api/hud/offer/decline', async (req, res) => {
  const wearer = String(req.body.sl_uuid || '');
  const offerId = String(req.body.offer_id || '');
  const recipient = String(req.body.recipient_uuid || '');
  if (!wearer || !offerId || !recipient) return res.status(400).json({ error: "Missing offer." });
  try {
    await db.query(
      `UPDATE control_offers SET status = 'declined'
       WHERE id = $1 AND wearer_uuid = $2 AND recipient_uuid = $3 AND status = 'pending'`,
      [offerId, wearer, recipient]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not close the offer." });
  }
});

app.get('/offer/:id', async (req, res) => {
  try {
    const found = await db.query(
      `SELECT sender_name, seconds, price, rate, status, created_at, wearer_uuid, recipient_uuid, grant_token
       FROM control_offers WHERE id = $1`,
      [String(req.params.id || '')]
    );
    if (!found.rows.length) {
      return res.status(404).type('html').send(guestMessage("This offer is not open."));
    }
    const offer = found.rows[0];
    let grantToken = offer.grant_token || '';
    if (!grantToken && offer.status === 'paid') {
      const grant = await db.query(
        `SELECT token FROM control_grants
         WHERE wearer_uuid = $1 AND recipient_uuid = $2 AND created_at >= $3
         ORDER BY created_at DESC LIMIT 1`,
        [offer.wearer_uuid, offer.recipient_uuid, offer.created_at]
      );
      grantToken = (grant.rows[0] && grant.rows[0].token) || '';
    }
    if (grantToken) return res.redirect(`/guest/${encodeURIComponent(grantToken)}`);
    const fresh = offer.status === 'pending' && (Date.now() - new Date(offer.created_at).getTime()) < 15 * 60 * 1000;
    const name = String(offer.sender_name || 'She').replace(/[&<>"]/g, '');
    const label = offerLabel(offer.seconds);
    const rate = Math.max(1, Number(offer.rate) || LINDENS_PER_MINUTE);
    const note = fresh
      ? `Right-click the ball on her collar and choose Pay. L$${offer.price} pays her for this time. This page becomes the controls after payment.`
      : "This offer is closed.";
    res.type('html').send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${fresh ? '<meta http-equiv="refresh" content="4">' : ''}
  <title>${name} — Mālama Hōkū</title>
  <link href="https://fonts.googleapis.com/css2?family=Pacifico&display=swap" rel="stylesheet">
  <style>
    body { font-family: sans-serif; background: #160208; color: #ffe8ee; max-width: 420px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 8px; font-family: "Pacifico", cursive; font-size: 30px; font-weight: 400; background: linear-gradient(100deg, #ffe08a, #ff8a1e 40%, #ff3d6e 75%, #ff4df0); -webkit-background-clip: text; background-clip: text; color: transparent; }
    img.logo { width: 220px; height: 220px; border-radius: 50%; object-fit: cover; display: block; margin: 0 0 8px; }
    .name { margin: 0; color: #ff5a7a; font-size: 22px; font-weight: bold; letter-spacing: 0.04em; text-transform: uppercase; }
    .price { font-size: 28px; font-weight: bold; color: #ffe08a; margin: 12px 0; }
    p { color: #ffc1cf; }
  </style>
</head>
<body>
  <img class="logo" src="/logo.png" alt="Mālama Hōkū">
  <h1>Mālama Hōkū</h1>
  <p class="name">${name}</p>
  <p>${name} is offering ${label}.</p>
  <p class="price">L$${offer.price}</p>
  <p>L$${rate} a minute.</p>
  <p>${note}</p>
</body>
</html>`);
  } catch (err) {
    console.error(err);
    res.status(500).type('html').send(guestMessage("Could not open this offer."));
  }
});

app.get('/api/hud/grant/:token', async (req, res) => {
  try {
    const actor = await resolveControl({ grant_token: req.params.token });
    if (actor.error) return res.status(actor.status).json({ error: actor.error });
    const session = await getSession(actor.wearer);
    if (!session || session.status !== 'connected') {
      return res.status(404).json({ error: "Toy is not connected." });
    }
    const toys = await toysForSession(session);
    const patterns = await db.query(
      `SELECT id, name FROM saved_patterns WHERE sl_uuid = $1 ORDER BY created_at ASC, id ASC`,
      [actor.wearer]
    );
    let pendingAdd = null;
    if (actor.guest && actor.hudMode === 'hooker') {
      const pending = await db.query(
        `SELECT minutes, price FROM time_adds
         WHERE wearer_uuid = $1 AND status = 'pending'
           AND created_at > NOW() - INTERVAL '15 minutes'
         ORDER BY created_at DESC
         LIMIT 1`,
        [actor.wearer]
      );
      if (pending.rows[0]) {
        pendingAdd = { minutes: Number(pending.rows[0].minutes), price: Number(pending.rows[0].price) };
      }
    }
    return res.json({
      toys,
      patterns: patterns.rows,
      seconds_left: actor.secondsLeft,
      running: actor.running,
      rate: actor.rate || LINDENS_PER_MINUTE,
      owner_name: actor.senderName || session.display_name || '',
      pending_add: pendingAdd
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not open this control link." });
  }
});

app.get('/control', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mālama Hōkū</title>
  <style>
    body { font-family: sans-serif; background: #111; color: #eee; max-width: 420px; margin: 0 auto; padding: 24px; }
    a { display: block; background: #ff4da6; color: #fff; text-decoration: none; padding: 14px; border-radius: 8px; margin: 8px 0; text-align: center; font-weight: bold; }
    img.logo { width: 220px; height: 220px; border-radius: 50%; object-fit: cover; display: block; margin: 0 0 8px; }
    p { color: #ccc; }
  </style>
</head>
<body>
  <img class="logo" src="/logo.png" alt="Mālama Hōkū">
  <h1>Mālama Hōkū</h1>
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

    const toys = await toysForSession(session);
    const local = localCommandUrl(session.connection);

    return res.json({ toys, local_command: local });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Toy list lookup failed." });
  }
});

function hookerNeonSign() {
  return `<p class="ready-script">The Slut is Ready</p><aside class="neon-sign" aria-hidden="true"><video src="/neon-sign.mp4?v=loop" autoplay muted loop playsinline></video></aside>`;
}

function ageGate() {
  return `<div class="age-gate" id="ageGate" role="dialog" aria-modal="true" aria-labelledby="ageTitle">
    <div class="age-card">
      <img class="logo" src="/logo.png" alt="Mālama Hōkū">
      <h2 id="ageTitle">Mālama Hōkū</h2>
      <p>You must be 18 or older to enter.</p>
      <div class="age-actions">
        <button type="button" id="ageEnter">Enter</button>
        <button type="button" id="ageExit">Exit</button>
      </div>
    </div>
  </div>
  <script>
    (function () {
      var enter = document.getElementById("ageEnter");
      var exit = document.getElementById("ageExit");
      if (!enter || !exit) return;
      enter.addEventListener("click", function () {
        try { sessionStorage.setItem("hhn-age-ok", "1"); } catch (e) {}
        document.documentElement.classList.add("age-ok");
        document.body.classList.remove("locked");
        var gate = document.getElementById("ageGate");
        if (gate) gate.remove();
        document.querySelectorAll("video").forEach(function (clip) {
          clip.play().catch(function () {});
        });
      });
      exit.addEventListener("click", function () {
        try { sessionStorage.removeItem("hhn-age-ok"); } catch (e) {}
        location.replace("/left");
      });
    })();
  </script>`;
}

function sendControlPage(res, slUuid, guestToken, guestEnds, ownerName, grantSeconds, grantRunning, pageMode, payRate) {
  res.type('html').send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${ownerName ? "Control " + ownerName.replace(/[&<>"]/g, "") + " — Mālama Hōkū" : "Mālama Hōkū"}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Great+Vibes&family=Pacifico&display=swap" rel="stylesheet">
  <style>
    body { font-family: sans-serif; background: #111; color: #eee; max-width: 420px; margin: 0 auto; padding: 24px; }
    .brand { display: flex; align-items: center; gap: 14px; margin: 0 0 8px; }
    .brand > img { width: 148px; height: 148px; border-radius: 50%; object-fit: cover; flex: none; box-shadow: 0 0 0 2px #f5b942; }
    .brand h1 {
      margin: 0;
      font-family: "Pacifico", cursive;
      font-size: 30px;
      font-weight: 400;
      line-height: 1.05;
      background: linear-gradient(100deg, #ffe08a, #ff8a1e 40%, #ff3d6e 75%, #ff4df0);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    p { font-size: 13px; margin: 6px 0; }
    label, select, input, button { display: block; width: 100%; margin: 5px 0; font-size: 13px; }
    select, input { padding: 5px 8px; border-radius: 6px; border: 0; }
    button { padding: 7px 10px; border: 0; border-radius: 8px; background: #ff4da6; color: #fff; font-weight: bold; }
    button.secondary { background: #444; }
    h2 { font-size: 13px; margin: 12px 0 2px; }
    .pattern-note { margin: 0 0 6px; color: #ccc; font-size: 12px; }
    .patterns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .mode-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 8px 0 4px; }
    .mode-row button { margin: 0; }
    .add-custom { display: grid; grid-template-columns: 1fr auto; gap: 6px; margin-top: 6px; }
    .add-custom input, .add-custom button { margin: 0; }
    .patterns button { margin: 0; background: #6b2d78; }
    .patterns button.live, .saved-row button.live, #playDraft.live { background: #1f9d4a; }
    .on-word {
      display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 8px;
      background: rgba(0,0,0,0.28); font-size: 10px; letter-spacing: 0.04em; vertical-align: 1px;
    }
    #builder[hidden] { display: none; }
    #bars { display: grid; grid-template-columns: repeat(16, 1fr); gap: 3px; height: 110px; margin: 6px 0; touch-action: none; }
    #bars button { margin: 0; padding: 0; height: 100%; background: #2a2a2a; position: relative; overflow: hidden; border-radius: 4px; }
    #bars button span { position: absolute; left: 0; right: 0; bottom: 0; background: linear-gradient(#ff8a1e, #ff3d6e); pointer-events: none; }
    #toyFns { margin-top: 0; }
    #playDraft { background: #6b2d78; }
    #playDraft.live { background: #1f9d4a; }
    .saved { display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px; }
    .saved-row { display: grid; grid-template-columns: 1fr auto; gap: 6px; }
    .saved-row button { margin: 0; }
    .saved-row .remove { width: auto; background: #444; padding: 7px 10px; }
    #status { min-height: 24px; color: #9f9; }
    .sender { margin: 2px 0 0; font-size: 22px; font-weight: bold; color: #ffe08a; }
    body.hooker { background: #070003; color: #ffe8ee; position: relative; }
    body.hooker button { background: #c8102e; }
    body.hooker button.secondary { background: #3a1018; }
    body.hooker .patterns button { background: #6b1024; }
    body.hooker .sender { color: #ff5a7a; letter-spacing: 0.04em; text-transform: uppercase; }
    body.hooker #grantLine, body.hooker .pattern-note { color: #ffc1cf; }
    body.hooker #status { color: #ffd0dc; }
    body.hooker .brand { position: relative; min-height: 160px; padding-right: 132px; }
    body.hooker .brand > img, body.hooker .brand h1 { position: relative; z-index: 1; }
    body.hooker .ready-script {
      position: absolute; z-index: 2; left: 244px; top: 50%; margin: 0;
      transform: translateY(-54%) rotate(-8deg);
      font-family: "Great Vibes", cursive; font-size: 30px; line-height: 1; font-weight: 400;
      white-space: nowrap; pointer-events: none; color: #fff6fb;
      text-shadow: 0 0 6px #ff4da6, 0 0 16px #ff2a78, 0 0 28px #ff4df0, 0 2px 0 #4a0018;
    }
    body.hooker .neon-sign {
      position: absolute; z-index: 0; top: 164px; right: -28px; width: 210px; margin: 0;
      pointer-events: none;
    }
    body.hooker .neon-sign video {
      width: 100%; height: auto; display: block; border-radius: 0; box-shadow: none; background: transparent;
      -webkit-mask-image: radial-gradient(ellipse 100% 100% at 54% 46%, #000 0%, rgba(0,0,0,0.72) 16%, rgba(0,0,0,0.28) 38%, transparent 62%);
      mask-image: radial-gradient(ellipse 100% 100% at 54% 46%, #000 0%, rgba(0,0,0,0.72) 16%, rgba(0,0,0,0.28) 38%, transparent 62%);
    }
    html.age-ok .age-gate { display: none !important; }
    body.hooker.locked > :not(.age-gate) { visibility: hidden; }
    html.age-ok body.hooker.locked > :not(.age-gate) { visibility: visible; }
    .age-gate {
      position: fixed; inset: 0; z-index: 30; background: #070003; color: #ffe8ee;
      display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center;
    }
    .age-card { width: min(320px, 100%); }
    .age-card h2 {
      margin: 0 0 10px; font-family: "Pacifico", cursive; font-size: 32px; font-weight: 400;
      background: linear-gradient(100deg, #ffe08a, #ff8a1e 40%, #ff3d6e 75%, #ff4df0);
      -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .age-card img.logo { width: 200px; height: 200px; border-radius: 50%; object-fit: cover; display: block; margin: 0 auto 8px; }
    .age-card p { font-size: 16px; color: #ffe8ee; margin: 0 0 16px; }
    .age-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .age-actions button { margin: 0; }
    #ageExit { background: #3a1018; }
    [hidden] { display: none !important; }
  </style>
${guestToken && pageMode === 'hooker' ? '<script>try{if(sessionStorage.getItem("hhn-age-ok")==="1")document.documentElement.classList.add("age-ok")}catch(e){}</script>' : ""}
</head>
<body class="${guestToken && pageMode === 'hooker' ? 'hooker locked' : ''}">
  ${guestToken && pageMode === 'hooker' ? ageGate() : ""}
  <header class="brand">
    <img src="/logo.png" alt="Mālama Hōkū">
    <h1>Mālama Hōkū</h1>
    ${guestToken && pageMode === 'hooker' ? hookerNeonSign() : ""}
  </header>
  <p id="senderName" class="sender"${ownerName ? "" : " hidden"}></p>
  <p id="intro">Move the slider. The toy follows it.</p>
  <button type="button" id="hudMode" class="secondary">Normal HUD</button>
  <p id="grantLine" class="pattern-note"></p>
  <p id="addTime" class="pattern-note" hidden></p>
  <div id="addMinutes" class="patterns" hidden></div>
  <div id="addCustom" class="add-custom" hidden>
    <input id="addCustomMinutes" type="number" min="1" max="60" step="1" inputmode="numeric" placeholder="Minutes">
    <button type="button" id="addCustomSend">Send</button>
  </div>
  <label id="toyLabel" for="toy">Toy</label>
  <select id="toy"><option value="">All connected toys</option></select>
  <p id="toyFns" class="pattern-note"></p>
  <label id="strengthLabel" for="strength">Vibration 0–100: <span id="strengthVal">0</span></label>
  <input id="strength" type="range" min="0" max="100" step="1" value="0">
  <div id="extraControls"></div>
  <div id="powerMode" class="mode-row">
    <button type="button" id="modeTimed">For seconds</button>
    <button type="button" id="modeHold" class="secondary">Stay on</button>
  </div>
  <p id="holdNote" class="pattern-note" hidden>Sliders hold where you put them. A pattern stays on until you tap it again.</p>
  <label id="secondsLabel" for="duration">Seconds</label>
  <input id="duration" type="number" min="1" max="60" value="5">
  <button id="vibrate">Vibrate for those seconds</button>
  <h2 id="presetHeading">Vibration patterns</h2>
  <p id="presetNote" class="pattern-note">Lovense patterns for Connect and Remote. They run for the seconds above.</p>
  <div id="presetButtons" class="patterns">
    <button type="button" data-pattern="pulse">Pulse</button>
    <button type="button" data-pattern="wave">Wave</button>
    <button type="button" data-pattern="fireworks">Fireworks</button>
    <button type="button" data-pattern="earthquake">Earthquake</button>
  </div>
  <h2 id="mineHeading">My patterns</h2>
  <p id="mineNote" class="pattern-note">Saved on this avatar. They stay here every time you open the controls.</p>
  <div id="savedPatterns" class="saved"></div>
  <button type="button" id="makePattern" class="secondary">Make a pattern</button>
  <div id="builder" hidden>
    <label for="patternName">Name</label>
    <input id="patternName" maxlength="24" placeholder="Slow rise">
    <p class="pattern-note">Drag the bars. Each bar is one beat, from off at the bottom to full at the top.</p>
    <div id="bars"></div>
    <button type="button" id="playDraft">Try it</button>
    <button type="button" id="savePattern">Save for this avatar</button>
  </div>
    <button id="stop" class="secondary">Stop</button>
    <button id="disconnect" class="secondary">Disconnect</button>
  <p id="battery"></p>
  <p id="status">Loading toys…</p>
  <script>
    const uuid = ${JSON.stringify(slUuid)};
    const guestToken = ${JSON.stringify(guestToken || "")};
    const guestEnds = ${Number(guestEnds) || 0};
    let ownerName = ${JSON.stringify(ownerName || "")};
    function awaitingLine(price) {
      const who = ownerName || "her";
      if (price) return "Awaiting confirmation from " + who + ". Pay L$" + price + " in Second Life.";
      return "Awaiting confirmation from " + who + ".";
    }
    let grantLeft = ${Number(grantSeconds) || 0};
    let grantRunning = ${grantRunning ? "true" : "false"};
    let grantSync = Date.now();
    const pageMode = ${JSON.stringify(pageMode || "normal")};
    const payRate = ${Math.max(1, Number(payRate) || 30)};
    let sentMode = "normal";
    let holdOn = false;
    try {
      if (!guestToken && localStorage.getItem("hhn-hold-on") === "1") holdOn = true;
    } catch (e) {}

    function stayingOn() {
      return holdOn && !guestToken;
    }

    function withActor(body) {
      if (guestToken) body.grant_token = guestToken;
      else body.wearer_uuid = uuid;
      return body;
    }
    const toySelect = document.getElementById("toy");
    const strength = document.getElementById("strength");
    const strengthVal = document.getElementById("strengthVal");
    const duration = document.getElementById("duration");
    const status = document.getElementById("status");
    const batteryLine = document.getElementById("battery");
    let desired = 0;
    let lastSent = -1;
    let inflight = false;
    let resend = false;
    let endsAt = 0;
    let clock = null;
    let sendTimer = null;
    let sendImmediate = false;
    let flightGen = 0;
    let flying = false;
    let dirty = false;
    let commandSeq = 0;
    let glideSteps = null;
    let glideStarted = 0;
    let rampUntil = 0;
    let rampMs = 0;
    let holdMs = 0;
    let settleDue = 0;
    let glideHeading = 0;
    let sendAt = 0;
    let localWorks = null;
    let localChain = Promise.resolve();
    let localCommand = "";
    let loadedToys = [];
    let shownFns = "";
    let lastLevels = "";
    let wasMulti = false;

    function toyStep(percent) {
      const p = Math.max(0, Math.min(100, percent));
      if (p <= 0) return 0;
      return Math.max(1, Math.round((p * 20) / 100));
    }

    function allowedSeconds() {
      if (guestToken) return Math.max(2, shownGrantLeft() || grantLeft || 2);
      const n = parseInt(duration.value, 10) || 5;
      return Math.max(1, Math.min(60, n));
    }

    function remaining() {
      if (!endsAt) return 0;
      return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    }

    function localScale(name, percent) {
      const max = name === "Pump" || name === "Depth" ? 3 : (name === "Stroke" || name === "Position" ? 100 : 20);
      const p = Math.max(0, Math.min(100, percent | 0));
      if (p <= 0) return 0;
      if (max === 100) return p;
      return Math.max(1, Math.round((p * max) / 100));
    }

    function playingNow() {
      if (!glideSteps || !glideStarted) return 0;
      const index = Math.min(glideSteps.length - 1, Math.floor((Date.now() - glideStarted) / 50));
      return glideSteps[index];
    }

    function rememberGlide(to) {
      const from = playingNow();
      const end = to | 0;
      const sign = end === from ? 0 : (end > from ? 1 : -1);
      const distance = Math.min(4, Math.abs(end - from));
      const steps = [];
      let level = from;
      for (let i = 0; i < distance; i++) {
        level += sign;
        steps.push(level);
      }
      if (!steps.length) steps.push(end);
      const landed = steps[steps.length - 1];
      const rampLen = steps.length;
      while (steps.length < rampLen + 12 && steps.length < 50) steps.push(landed);
      const now = Date.now();
      glideSteps = steps;
      glideStarted = now;
      glideHeading = sign;
      rampMs = distance * 50;
      holdMs = (steps.length - rampLen) * 50;
      rampUntil = now + rampMs;
      settleDue = landed === end ? now + rampMs + holdMs - 250 : 0;
      return steps;
    }

    function clearGlide() {
      glideSteps = null;
      glideStarted = 0;
      glideHeading = 0;
      rampUntil = 0;
      rampMs = 0;
      holdMs = 0;
      settleDue = 0;
    }

    function lockLevel(step) {
      glideSteps = [step];
      glideStarted = Date.now();
      glideHeading = 0;
      rampUntil = 0;
      rampMs = 0;
      holdMs = 0;
      settleDue = 0;
    }

    function followWait() {
      const step = toyStep(desired);
      if (step === 0 || lastSent < 0) return 0;
      const want = Math.sign(step - playingNow());
      if (want && glideHeading && want !== glideHeading) return 0;
      if (!want) return settleDue ? Math.max(0, settleDue - Date.now()) : 0;
      return Math.max(0, rampUntil - Date.now());
    }

    function armSend(gen) {
      const wait = followWait();
      const at = Date.now() + wait;
      if (sendTimer) {
        if (sendAt <= at) return;
        clearTimeout(sendTimer);
      }
      sendAt = at;
      sendTimer = setTimeout(() => {
        sendTimer = null;
        sendSlider(gen, false);
      }, wait);
    }

    function localPayload(levels, seconds, holding, stop) {
      if (stop) {
        clearGlide();
        return { command: "Function", action: "Stop", timeSec: 0, apiVer: 1, stopPrevious: 1 };
      }
      if ((levels.Position || 0) > 0 || (levels.Stroke || 0) > 0) return null;
      const order = ["Vibrate", "Vibrate1", "Vibrate2", "Vibrate3", "Rotate", "Pump", "Thrusting", "Fingering", "Suction", "Depth", "Oscillate"];
      const vibeOnly = !order.some((name) => name !== "Vibrate" && (levels[name] || 0) > 0);
      if (vibeOnly) {
        const step = toyStep(levels.Vibrate || 0);
        if (step <= 0) {
          clearGlide();
          return { command: "Function", action: "Stop", timeSec: 0, apiVer: 1, stopPrevious: 1 };
        }
        if (step === playingNow()) {
          lockLevel(step);
          const holdPayload = {
            command: "Function",
            action: "Vibrate:" + step,
            timeSec: holding ? 0 : Math.max(1, seconds),
            apiVer: 1,
            stopPrevious: 1
          };
          if (toySelect.value) holdPayload.toy = toySelect.value;
          return holdPayload;
        }
        const steps = rememberGlide(step);
        const payload = {
          command: "Pattern",
          rule: "V:1;F:v;S:50#",
          strength: steps.join(";"),
          timeSec: Math.max(0.2, Math.round(steps.length * 50) / 1000),
          apiVer: 2,
          stopPrevious: 1
        };
        if (toySelect.value) payload.toy = toySelect.value;
        return payload;
      }
      const parts = [];
      order.forEach((name) => {
        const level = localScale(name, levels[name] || 0);
        if (level > 0) parts.push(name + ":" + level);
      });
      if (!parts.length) {
        clearGlide();
        return { command: "Function", action: "Stop", timeSec: 0, apiVer: 1, stopPrevious: 1 };
      }
      const payload = {
        command: "Function",
        action: parts.join(","),
        timeSec: holding ? 0 : Math.max(1, seconds),
        apiVer: 1,
        stopPrevious: 1
      };
      if (toySelect.value) payload.toy = toySelect.value;
      return payload;
    }

    function pushLocal(payload) {
      if (!payload || localWorks === false) return Promise.resolve(false);
      const run = localChain.then(() => raceLocal(payload));
      localChain = run.then(() => {}, () => {});
      return run;
    }

    function raceLocal(payload) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), localWorks ? 250 : 120);
      const urls = ["https://127-0-0-1.lovense.club:30010/command"];
      if (localCommand && urls.indexOf(localCommand) < 0) urls.push(localCommand);
      const jobs = urls.map((url) => fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-platform": "HotHawaiianNights" },
        body: JSON.stringify(payload),
        signal: controller.signal
      }).then((r) => r.json()).then((data) => !!(data && (data.code === 200 || data.code === 0 || data.result === true))).catch(() => false));
      return new Promise((resolve) => {
        let pending = jobs.length;
        let settled = false;
        jobs.forEach((job) => {
          job.then((ok) => {
            if (ok && !settled) {
              settled = true;
              localWorks = true;
              resolve(true);
            }
          }).finally(() => {
            pending -= 1;
            if (!pending && !settled) {
              if (localWorks !== true) localWorks = false;
              resolve(false);
            }
          });
        });
      }).finally(() => {
        clearTimeout(timer);
        controller.abort();
      });
    }

    function finishFlight(gen) {
      if (gen !== flightGen) return;
      flying = false;
      if (!dirty) return;
      dirty = false;
      armSend(gen);
    }

    function sendSlider(gen, immediateStop) {
      if (gen !== flightGen) return;
      flying = true;
      const levels = immediateStop ? { Vibrate: 0 } : collectLevels();
      const holding = stayingOn();
      let body;
      let seconds = 0;
      if (immediateStop) {
        body = commandBody(0, 0, true, false);
      } else if (multiOn(levels)) {
        seconds = holding ? 0 : remaining();
        if (!holding && seconds <= 0) return finishFlight(gen);
        const signature = JSON.stringify(levels) + "|" + (toySelect.value || "") + "|" + (holding ? "h" : "t");
        if (signature === lastLevels) return finishFlight(gen);
        lastLevels = signature;
        wasMulti = true;
        lastSent = -1;
        body = withActor({
          levels: levels,
          duration: seconds,
          hold: holding,
          stop: false,
          toy_id: toySelect.value || undefined
        });
        status.textContent = holding ? "On until the slider is 0." : "Controls sent.";
      } else {
        if (wasMulti) {
          wasMulti = false;
          lastSent = -1;
          lastLevels = "";
        }
        const level = desired;
        const step = toyStep(level);
        const here = playingNow();
        seconds = holding || level === 0 ? 0 : remaining();
        if (!holding && level > 0 && seconds <= 0) return finishFlight(gen);
        const tracking = !!(glideSteps && glideStarted);
        if (step === lastSent && (!tracking || (step === here && !settleDue))) return finishFlight(gen);
        lastSent = step;
        body = commandBody(level, seconds, false, holding && level > 0);
        status.textContent = level === 0
          ? "Off."
          : (holding ? ("On at " + level + ". It stops at 0.") : ("Strength " + level + " of 100"));
      }
      body.seq = ++commandSeq;
      const snap = {
        steps: glideSteps,
        started: glideStarted,
        until: rampUntil,
        heading: glideHeading,
        rampMs: rampMs,
        holdMs: holdMs,
        settle: settleDue
      };
      const payload = localPayload(levels, seconds, holding && !immediateStop, immediateStop || !levelsOn(levels));
      pushLocal(payload).then(async (delivered) => {
        if (!delivered && !immediateStop) {
          glideSteps = snap.steps;
          glideStarted = snap.started;
          rampUntil = snap.until;
          glideHeading = snap.heading;
          rampMs = snap.rampMs;
          holdMs = snap.holdMs;
          settleDue = snap.settle;
        } else if (delivered && payload && payload.command === "Pattern") {
          const now = Date.now();
          glideStarted = now;
          rampUntil = now + rampMs;
          if (settleDue) settleDue = now + rampMs + holdMs - 250;
        }
        if (gen !== flightGen) return;
        body.delivered = !!delivered;
        if (delivered && !immediateStop && toyStep(desired) > 0 && (settleDue || toyStep(desired) !== playingNow())) {
          dirty = true;
        }
        if (delivered && !immediateStop) {
          postCommand(body).catch(() => {});
          return;
        }
        await postCommand(body);
      }).catch((e) => {
        if (gen !== flightGen || body.delivered) return;
        lastSent = -1;
        lastLevels = "";
        status.textContent = e.message || "Command failed.";
      }).finally(() => finishFlight(gen));
    }

    function queueSend(immediateStop) {
      if (immediateStop) {
        if (sendTimer) clearTimeout(sendTimer);
        sendTimer = null;
        sendImmediate = false;
        dirty = false;
        flightGen += 1;
        desired = 0;
        lastSent = 0;
        lastLevels = "";
        wasMulti = false;
        clearGlide();
        sendAt = 0;
        status.textContent = "Stopped.";
        sendSlider(flightGen, true);
        return;
      }
      if (flying) {
        dirty = true;
        return;
      }
      armSend(flightGen);
    }

    strength.oninput = () => {
      const level = parseInt(strength.value, 10) || 0;
      strengthVal.textContent = String(level);
      desired = level;
      if (liveKey) clearLivePattern();
      const levels = collectLevels();
      if (stayingOn()) stopClock();
      else if (levelsOn(levels)) beginSession();
      else stopClock();
      queueSend(false);
    };

    function stopClock() {
      if (clock) clearInterval(clock);
      clock = null;
      endsAt = 0;
    }

    function beginSession(reset) {
      if (!reset && endsAt > Date.now()) return;
      const seconds = reset ? Math.max(2, allowedSeconds()) : allowedSeconds();
      endsAt = Date.now() + seconds * 1000;
      if (clock) clearInterval(clock);
      clock = setInterval(() => {
        if (remaining() > 0) return;
        stopClock();
        strength.value = "0";
        strengthVal.textContent = "0";
        zeroExtras();
        desired = 0;
        status.textContent = guestToken
          ? "Paused. You can start again with the time left."
          : "Time is up.";
        queueSend(true);
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
      if (guestToken) applyGrant(data);
      return data;
    }

    function commandBody(level, seconds, immediateStop, holding) {
      return withActor({
        strength: level,
        duration: seconds,
        hold: !!holding,
        stop: !!immediateStop,
        toy_id: toySelect.value || undefined
      });
    }

    function paintModes() {
      const timed = document.getElementById("modeTimed");
      const held = document.getElementById("modeHold");
      if (!timed || !held) return;
      timed.className = holdOn ? "secondary" : "";
      held.className = holdOn ? "" : "secondary";
      document.getElementById("holdNote").hidden = !holdOn;
      document.getElementById("vibrate").textContent = runLabel(selectedFunctions());
      const presetNote = document.getElementById("presetNote");
      const mineNote = document.getElementById("mineNote");
      if (presetNote) {
        presetNote.textContent = holdOn
          ? "Tap a pattern. It stays on until you tap it again."
          : "Lovense patterns for Connect and Remote. They run for the seconds above.";
      }
      if (mineNote) {
        mineNote.textContent = holdOn
          ? "Tap one. It stays on until you tap it again."
          : "Saved on this avatar. They stay here every time you open the controls.";
      }
    }

    function chooseHold(next) {
      if (guestToken || holdOn === next) return;
      const patternWasLive = !!liveKey;
      holdOn = next;
      try { localStorage.setItem("hhn-hold-on", holdOn ? "1" : "0"); } catch (e) {}
      paintModes();
      if (!holdOn && patternWasLive) {
        clearLivePattern();
        queueSend(true);
        status.textContent = "Pattern is off.";
        return;
      }
      if (holdOn) {
        stopClock();
        if (levelsOn(collectLevels())) {
          lastSent = -1;
          lastLevels = "";
          queueSend(false);
        } else {
          status.textContent = "Move the slider. It stays on until you set it to 0.";
        }
        return;
      }
      if (levelsOn(collectLevels())) {
        lastSent = -1;
        lastLevels = "";
        beginSession(true);
        queueSend(false);
      }
    }

    function toyLabel(toy) {
      const name = toy.name + " (" + toy.type + ")";
      return toy.battery == null ? name : (name + "  " + toy.battery + "%");
    }

    function showToys(toys) {
      const selected = toySelect.value;
      toySelect.innerHTML = '<option value="">All connected toys</option>';
      (toys || []).forEach((toy) => {
        const opt = document.createElement("option");
        opt.value = toy.id;
        opt.textContent = toyLabel(toy);
        toySelect.appendChild(opt);
      });
      if (selected && Array.from(toySelect.options).some((opt) => opt.value === selected)) {
        toySelect.value = selected;
      }
      const withBattery = (toys || []).filter((toy) => toy.battery != null);
      batteryLine.textContent = withBattery.length
        ? withBattery.map((toy) => toy.name + "  " + toy.battery + "%").join(" | ")
        : "";
      loadedToys = toys || [];
      renderFunctions();
    }

    function fnName(name) {
      const labels = {
        Vibrate: "Vibration",
        Vibrate1: "Vibration 1",
        Vibrate2: "Vibration 2",
        Vibrate3: "Vibration 3",
        Rotate: "Rotation",
        Pump: "Pump",
        Thrusting: "Thrusting",
        Fingering: "Fingering",
        Suction: "Suction",
        Depth: "Depth",
        Oscillate: "Oscillate",
        Stroke: "Stroke range",
        Position: "Position"
      };
      return labels[name] || name;
    }

    function selectedFunctions() {
      const id = toySelect.value;
      const chosen = id ? loadedToys.filter((toy) => String(toy.id) === String(id)) : loadedToys;
      const names = [];
      (chosen.length ? chosen : [{ functions: ["Vibrate"] }]).forEach((toy) => {
        const list = (toy.functions && toy.functions.length) ? toy.functions : ["Vibrate"];
        list.forEach((name) => {
          if (names.indexOf(name) < 0) names.push(name);
        });
      });
      return names.length ? names : ["Vibrate"];
    }

    function collectLevels() {
      const levels = {};
      if (selectedFunctions().indexOf("Vibrate") >= 0 && !strength.hidden) {
        levels.Vibrate = parseInt(strength.value, 10) || 0;
      }
      document.querySelectorAll("#extraControls input").forEach((input) => {
        levels[input.getAttribute("data-fn")] = parseInt(input.value, 10) || 0;
      });
      return levels;
    }

    function levelsOn(levels) {
      return Object.keys(levels).some((name) => levels[name] > 0);
    }

    function multiOn(levels) {
      return Object.keys(levels).some((name) => name !== "Vibrate" && levels[name] > 0);
    }

    function zeroExtras() {
      document.querySelectorAll("#extraControls input").forEach((input) => {
        input.value = "0";
        const val = document.getElementById(input.id + "Val");
        if (val) val.textContent = "0";
      });
    }

    function showPatternTools(hasVibe) {
      ["presetHeading", "presetNote", "presetButtons", "mineHeading", "mineNote", "savedPatterns"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.hidden = !hasVibe;
      });
      const make = document.getElementById("makePattern");
      if (guestToken) make.hidden = true;
      else make.hidden = !hasVibe;
      if (!hasVibe) document.getElementById("builder").hidden = true;
    }

    function runLabel(names) {
      if (guestToken && pageMode === "hooker") return "Work it";
      if (stayingOn()) {
        return names.length === 1 && names[0] === "Vibrate" ? "Hold this level" : "Hold these levels";
      }
      if (names.length === 1 && names[0] === "Vibrate") {
        return guestToken ? "Vibrate" : "Vibrate for those seconds";
      }
      return guestToken ? "Run" : "Run for those seconds";
    }

    function renderFunctions() {
      const names = selectedFunctions();
      const key = (toySelect.value || "*") + "|" + names.join(",");
      const hasVibe = names.indexOf("Vibrate") >= 0;
      document.getElementById("strengthLabel").hidden = !hasVibe;
      strength.hidden = !hasVibe;
      showPatternTools(hasVibe);
      document.getElementById("vibrate").textContent = runLabel(names);
      const note = document.getElementById("toyFns");
      if (!loadedToys.length) note.textContent = "";
      else {
        const chosen = toySelect.value
          ? loadedToys.filter((toy) => String(toy.id) === String(toySelect.value))
          : loadedToys;
        const who = chosen.length === 1 ? (chosen[0].name || "This toy") : "These toys";
        note.textContent = who + ": " + names.map(fnName).join(", ") + ".";
      }
      if (key === shownFns) return;
      shownFns = key;
      const box = document.getElementById("extraControls");
      box.replaceChildren();
      names.forEach((name) => {
        if (name === "Vibrate") return;
        const inputId = "fn-" + name;
        const label = document.createElement("label");
        label.htmlFor = inputId;
        label.append(document.createTextNode(fnName(name) + " 0–100: "));
        const val = document.createElement("span");
        val.id = inputId + "Val";
        val.textContent = "0";
        label.append(val);
        const input = document.createElement("input");
        input.id = inputId;
        input.type = "range";
        input.min = "0";
        input.max = "100";
        input.step = "1";
        input.value = "0";
        input.setAttribute("data-fn", name);
        input.oninput = () => {
          val.textContent = input.value;
          if (liveKey) clearLivePattern();
          const levels = collectLevels();
          if (stayingOn()) stopClock();
          else if (levelsOn(levels)) beginSession();
          else stopClock();
          queueSend(false);
        };
        box.append(label, input);
      });
      if (guestToken && shownGrantLeft() <= 0) {
        box.querySelectorAll("input").forEach((el) => { el.disabled = true; });
      }
    }

    toySelect.onchange = () => {
      clearLivePattern();
      shownFns = "";
      strength.value = "0";
      strengthVal.textContent = "0";
      desired = 0;
      renderFunctions();
      queueSend(true);
    };

    function parseLocalToys(data) {
      let payload = data && data.data && data.data.toys ? data.data.toys : (data && data.toys);
      if (!payload) return [];
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch (e) { return []; }
      }
      return Object.values(payload).map((item) => {
        let toy = item;
        if (typeof toy === "string") {
          try { toy = JSON.parse(toy); } catch (e) { return null; }
        }
        if (!toy || typeof toy !== "object") return null;
        const raw = toy.battery != null ? toy.battery : toy.batt;
        const n = parseInt(raw, 10);
        return {
          id: toy.id,
          name: toy.nickName || toy.name || toy.id,
          type: toy.name || "toy",
          battery: Number.isNaN(n) ? null : Math.max(0, Math.min(100, n)),
          fullFunctionNames: toy.fullFunctionNames,
          shortFunctionNames: toy.shortFunctionNames
        };
      }).filter((toy) => toy && toy.battery != null);
    }

    async function readBattery() {
      const urls = [];
      if (localCommand) urls.push(localCommand);
      urls.push("https://127-0-0-1.lovense.club:30010/command");
      for (const url of urls) {
        try {
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-platform": "HotHawaiianNights" },
            body: JSON.stringify({ command: "GetToys" })
          });
          const data = await r.json();
          const toys = parseLocalToys(data);
          if (!toys.length) continue;
          const saved = await fetch("/api/hud/battery", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wearer_uuid: uuid, toys })
          });
          const body = await saved.json();
          if (body && body.toys) showToys(body.toys);
          return;
        } catch (e) {}
      }
    }

    async function loadToys() {
      try {
        const r = await fetch(guestToken
          ? ("/api/hud/grant/" + encodeURIComponent(guestToken))
          : ("/api/hud/toys/" + encodeURIComponent(uuid)));
        const data = await r.json();
        if (!r.ok) {
          status.textContent = data.error || "Could not load toys.";
          return;
        }
        localCommand = data.local_command || "";
        showToys(data.toys);
        if (guestToken) renderGuestPatterns(data.patterns || []);
        if (guestToken && pageMode === "hooker") {
          status.textContent = (data.toys && data.toys.length)
            ? "Drag it. She stays on."
            : "No toy yet.";
        }         else {
          const names = selectedFunctions();
          status.textContent = (data.toys && data.toys.length)
            ? (stayingOn()
              ? "Move the slider. It stays on until you set it to 0."
              : (names.length > 1
                ? "Each slider is one of this toy's controls."
                : "Move the slider. Power follows while you drag."))
            : "No toys reported yet. Keep Lovense Remote open and refresh.";
        }
      } catch (e) {
        status.textContent = "Failed to load toys.";
      }
    }

    let liveKey = "";

    function labelOf(button) {
      const saved = button.getAttribute("data-label");
      if (saved) return saved;
      const label = button.textContent.trim();
      button.setAttribute("data-label", label);
      return label;
    }

    function paintPatternButton(button, on) {
      const label = labelOf(button);
      button.classList.toggle("live", !!on);
      button.replaceChildren(document.createTextNode(label));
      if (!on) return;
      button.append(document.createTextNode(" "));
      const mark = document.createElement("span");
      mark.className = "on-word";
      mark.textContent = "on";
      button.append(mark);
    }

    function clearLivePattern() {
      if (!liveKey) return;
      liveKey = "";
      document.querySelectorAll("button.live").forEach((button) => paintPatternButton(button, false));
    }

    function showLive(button, key) {
      document.querySelectorAll("button.live").forEach((el) => {
        if (el !== button) paintPatternButton(el, false);
      });
      liveKey = key;
      paintPatternButton(button, true);
    }

    function silenceSlider() {
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = null;
      dirty = false;
      flightGen += 1;
      flying = false;
      desired = 0;
      lastSent = 0;
      lastLevels = "";
      wasMulti = false;
      clearGlide();
      sendAt = 0;
      strength.value = "0";
      strengthVal.textContent = "0";
      zeroExtras();
    }

    function stopLivePattern(label) {
      clearLivePattern();
      stopClock();
      strength.value = "0";
      strengthVal.textContent = "0";
      zeroExtras();
      desired = 0;
      queueSend(true);
      status.textContent = label + " is off.";
    }

    async function postPattern(url, body) {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || "Pattern failed.");
      if (guestToken) applyGrant(data);
      return data;
    }

    document.querySelectorAll("[data-pattern]").forEach((button) => {
      button.onclick = async () => {
        const name = button.getAttribute("data-pattern");
        const label = labelOf(button);
        const key = "preset:" + name;
        if (stayingOn()) {
          if (liveKey === key) {
            stopLivePattern(label);
            return;
          }
          silenceSlider();
          stopClock();
          showLive(button, key);
          status.textContent = label + " is on.";
          try {
            await postPattern("/api/hud/pattern", withActor({
              name,
              duration: 0,
              hold: true,
              toy_id: toySelect.value || undefined
            }));
          } catch (e) {
            if (liveKey === key) clearLivePattern();
            status.textContent = e.message || "Pattern failed.";
          }
          return;
        }
        clearLivePattern();
        const seconds = Math.max(2, allowedSeconds());
        stopClock();
        zeroExtras();
        desired = 0;
        lastSent = 0;
        beginSession(true);
        status.textContent = label + " for " + seconds + " seconds.";
        try {
          await postPattern("/api/hud/pattern", withActor({
            name,
            duration: seconds,
            toy_id: toySelect.value || undefined
          }));
        } catch (e) {
          status.textContent = e.message || "Pattern failed.";
        }
      };
    });

    document.getElementById("vibrate").onclick = () => {
      const levels = collectLevels();
      if (!levelsOn(levels)) {
        status.textContent = "Move a slider above 0 first.";
        return;
      }
      if (stayingOn()) {
        stopClock();
        desired = levels.Vibrate || 0;
        lastSent = -1;
        lastLevels = "";
        queueSend(false);
        return;
      }
      stopClock();
      desired = levels.Vibrate || 0;
      beginSession(true);
      if (multiOn(levels)) {
        lastLevels = "";
        wasMulti = true;
        const seconds = allowedSeconds();
        status.textContent = "Running for " + seconds + " seconds.";
        postCommand(withActor({
          levels: levels,
          duration: seconds,
          stop: false,
          toy_id: toySelect.value || undefined
        })).catch((e) => {
          status.textContent = e.message || "Command failed.";
        });
        return;
      }
      resend = true;
      queueSend(false);
    };
    document.getElementById("stop").onclick = () => {
      clearLivePattern();
      stopClock();
      strength.value = "0";
      strengthVal.textContent = "0";
      zeroExtras();
      desired = 0;
      queueSend(true);
    };

    const BAR_COUNT = 16;
    let draft = Array.from({ length: BAR_COUNT }, () => 0);
    let painting = false;

    function renderBars() {
      const box = document.getElementById("bars");
      box.replaceChildren();
      draft.forEach((level) => {
        const bar = document.createElement("button");
        bar.type = "button";
        const fill = document.createElement("span");
        fill.style.height = Math.round((level / 20) * 100) + "%";
        bar.appendChild(fill);
        box.appendChild(bar);
      });
    }

    function paintAt(event) {
      const bars = document.getElementById("bars").children;
      for (let i = 0; i < bars.length; i++) {
        const rect = bars[i].getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right) continue;
        const ratio = 1 - (event.clientY - rect.top) / rect.height;
        const level = Math.max(0, Math.min(20, Math.round(ratio * 20)));
        draft[i] = level;
        bars[i].firstChild.style.height = Math.round((level / 20) * 100) + "%";
      }
    }

    async function playCustom(label, extra, button) {
      const key = button ? (button.id === "playDraft" ? "draft" : ("saved:" + (extra.id || label))) : "";
      if (stayingOn() && button) {
        if (liveKey === key) {
          stopLivePattern(label);
          return;
        }
        silenceSlider();
        stopClock();
        showLive(button, key);
        status.textContent = label + " is on.";
        try {
          await postPattern("/api/hud/custom-pattern", Object.assign(withActor({
            duration: 0,
            hold: true,
            toy_id: toySelect.value || undefined
          }), extra));
        } catch (e) {
          if (liveKey === key) clearLivePattern();
          status.textContent = e.message || "Pattern failed.";
        }
        return;
      }
      clearLivePattern();
      const seconds = Math.max(2, allowedSeconds());
      stopClock();
      zeroExtras();
      desired = 0;
      lastSent = 0;
      beginSession(true);
      status.textContent = label + " for " + seconds + " seconds.";
      try {
        await postPattern("/api/hud/custom-pattern", Object.assign(withActor({
          duration: seconds,
          toy_id: toySelect.value || undefined
        }), extra));
      } catch (e) {
        status.textContent = e.message || "Pattern failed.";
      }
    }

    function renderGuestPatterns(rows) {
      const box = document.getElementById("savedPatterns");
      box.replaceChildren();
      if (!rows.length) {
        const empty = document.createElement("p");
        empty.className = "pattern-note";
        empty.textContent = "No saved patterns yet.";
        box.appendChild(empty);
        return;
      }
      rows.forEach((row) => {
        const play = document.createElement("button");
        play.type = "button";
        play.textContent = row.name;
        play.setAttribute("data-label", row.name);
        play.setAttribute("data-id", String(row.id));
        play.onclick = () => playCustom(row.name, { id: row.id }, play);
        box.appendChild(play);
      });
    }

    async function loadSaved() {
      const box = document.getElementById("savedPatterns");
      box.replaceChildren();
      try {
        const r = await fetch("/api/hud/patterns/" + encodeURIComponent(uuid));
        const data = await r.json();
        const rows = (data && data.patterns) || [];
        if (!rows.length) {
          const empty = document.createElement("p");
          empty.className = "pattern-note";
          empty.textContent = "No saved patterns yet.";
          box.appendChild(empty);
          return;
        }
        rows.forEach((row) => {
          const line = document.createElement("div");
          line.className = "saved-row";
          const play = document.createElement("button");
          play.type = "button";
          play.textContent = row.name;
          play.setAttribute("data-label", row.name);
          play.setAttribute("data-id", String(row.id));
          play.onclick = () => playCustom(row.name, { id: row.id }, play);
          if (liveKey === "saved:" + row.id) paintPatternButton(play, true);
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "secondary remove";
          remove.textContent = "Remove";
          remove.onclick = async () => {
            const wasLive = liveKey === "saved:" + row.id;
            const response = await fetch("/api/hud/patterns/delete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ wearer_uuid: uuid, id: row.id })
            });
            const result = await response.json();
            if (!response.ok || result.error) {
              status.textContent = result.error || "Could not remove that pattern.";
              return;
            }
            if (wasLive) stopLivePattern(row.name);
            status.textContent = row.name + " removed.";
            loadSaved();
          };
          line.append(play, remove);
          box.appendChild(line);
        });
      } catch (e) {
        const empty = document.createElement("p");
        empty.className = "pattern-note";
        empty.textContent = "Saved patterns could not be loaded.";
        box.appendChild(empty);
      }
    }

    const bars = document.getElementById("bars");
    renderBars();
    bars.addEventListener("pointerdown", (event) => {
      painting = true;
      bars.setPointerCapture(event.pointerId);
      paintAt(event);
      event.preventDefault();
    });
    bars.addEventListener("pointermove", (event) => {
      if (!painting) return;
      paintAt(event);
    });
    bars.addEventListener("pointerup", () => { painting = false; });
    bars.addEventListener("pointercancel", () => { painting = false; });

    document.getElementById("makePattern").onclick = () => {
      const builder = document.getElementById("builder");
      builder.hidden = !builder.hidden;
    };
    document.getElementById("playDraft").onclick = () => {
      if (draft.every((n) => n === 0)) {
        status.textContent = "Raise at least one bar.";
        return;
      }
      const label = document.getElementById("patternName").value.trim() || "Custom";
      const draftButton = document.getElementById("playDraft");
      draftButton.setAttribute("data-label", "Try it");
      playCustom(label, { steps: draft.slice() }, draftButton);
    };
    document.getElementById("savePattern").onclick = async () => {
      const name = document.getElementById("patternName").value.trim();
      if (!name) {
        status.textContent = "Name the pattern first.";
        return;
      }
      if (draft.every((n) => n === 0)) {
        status.textContent = "Raise at least one bar.";
        return;
      }
      try {
        const r = await fetch("/api/hud/patterns", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wearer_uuid: uuid, name, steps: draft.slice() })
        });
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error || "Could not save.");
        status.textContent = name + " saved for this avatar.";
        document.getElementById("builder").hidden = true;
        document.getElementById("patternName").value = "";
        draft = Array.from({ length: BAR_COUNT }, () => 0);
        renderBars();
        loadSaved();
      } catch (e) {
        status.textContent = e.message || "Could not save.";
      }
    };

    document.getElementById("disconnect").onclick = async () => {
      stopClock();
      strength.value = "0";
      strengthVal.textContent = "0";
      zeroExtras();
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
    function showSender(name) {
      const sender = document.getElementById("senderName");
      if (!name) {
        sender.hidden = true;
        sender.textContent = "";
        return;
      }
      ownerName = name;
      sender.hidden = false;
      sender.textContent = name;
      document.title = "Control " + name + " — Mālama Hōkū";
    }

    function shownGrantLeft() {
      if (!grantRunning) return Math.max(0, grantLeft);
      return Math.max(0, grantLeft - Math.floor((Date.now() - grantSync) / 1000));
    }

    function applyGrant(data) {
      if (!data || data.seconds_left == null) return;
      grantLeft = Math.max(0, Math.floor(data.seconds_left));
      grantRunning = !!data.running;
      grantSync = Date.now();
      renderGrant();
    }

    function renderGrant() {
      if (!guestToken) return;
      const line = document.getElementById("grantLine");
      const left = shownGrantLeft();
      const mins = Math.floor(left / 60);
      const secs = left % 60;
      const clockText = mins + ":" + (secs < 10 ? "0" : "") + secs;
      if (left <= 0) {
        line.textContent = pageMode === "hooker"
          ? "Clock is at 0:00. Pay her to add time."
          : "Control time is used up.";
        if (status.dataset.awaiting !== "1") {
          status.textContent = pageMode === "hooker"
            ? "Pay her to add time."
            : "Control time is used up.";
        }
        document.querySelectorAll("button, input, select").forEach((el) => {
          if (!el.closest("#addMinutes") && !el.closest("#addCustom")) el.disabled = true;
        });
        return;
      }
      document.querySelectorAll("button, input, select").forEach((el) => {
        if (!el.closest("#addMinutes") && !el.closest("#addCustom")) el.disabled = false;
      });
      if (pageMode === "hooker" && status.textContent === "Pay her to add time.") {
        status.textContent = "Drag it. She stays on.";
      }
      line.textContent = pageMode === "hooker"
        ? (grantRunning
          ? ("On the clock. " + clockText + " left.")
          : ("Clock paused. " + clockText + " left. Start again."))
        : (grantRunning
          ? ("Controlling " + (ownerName || "their") + "'s toy. Time left " + clockText + ".")
          : ("Time left " + clockText + ". Paused. Start again to use the rest."));
    }

    function tickGrant() {
      renderGrant();
    }

    if (guestToken) {
      showSender(ownerName);
      document.getElementById("hudMode").hidden = true;
      document.getElementById("intro").textContent = ownerName
        ? ("You are controlling " + ownerName + "'s toy. Time runs only while the toy is on.")
        : "Time runs only while the toy is on. Stop keeps the rest.";
      document.getElementById("mineHeading").textContent = ownerName ? (ownerName + "'s patterns") : "Their patterns";
      document.getElementById("mineNote").textContent = "Patterns this avatar saved.";
      document.getElementById("presetNote").textContent = "Lovense patterns for Connect and Remote.";
      document.getElementById("secondsLabel").hidden = true;
      document.getElementById("duration").hidden = true;
      document.getElementById("powerMode").hidden = true;
      document.getElementById("holdNote").hidden = true;
      document.getElementById("vibrate").textContent = "Vibrate";
      document.getElementById("disconnect").hidden = true;
      document.getElementById("makePattern").hidden = true;
      document.getElementById("builder").hidden = true;
      if (pageMode === "hooker") {
        document.getElementById("intro").textContent = ownerName
          ? (ownerName + " is on the clock.")
          : "On the clock.";
        document.getElementById("toyLabel").textContent = "Her toy";
        document.getElementById("strengthLabel").firstChild.textContent = "How hard 0–100: ";
        document.getElementById("vibrate").textContent = "Work it";
        document.getElementById("presetHeading").textContent = "Menu";
        document.getElementById("presetNote").textContent = "Pick one. It runs while the clock is going.";
        document.querySelector('[data-pattern="pulse"]').textContent = "Tease";
        document.querySelector('[data-pattern="wave"]').textContent = "Ride";
        document.querySelector('[data-pattern="fireworks"]').textContent = "Pop off";
        document.querySelector('[data-pattern="earthquake"]').textContent = "Pound";
        document.getElementById("mineHeading").textContent = ownerName ? (ownerName + "'s specials") : "Specials";
        document.getElementById("mineNote").textContent = "What she saved.";
        document.getElementById("stop").textContent = "Hold up";
        const addTime = document.getElementById("addTime");
        const addMinutes = document.getElementById("addMinutes");
        addTime.hidden = false;
        addTime.textContent = "Pick more minutes. Second Life asks you to pay that amount, then she confirms.";
        addMinutes.hidden = false;
        const addCustom = document.getElementById("addCustom");
        const addCustomMinutes = document.getElementById("addCustomMinutes");
        async function sendMinutes(mins) {
          status.textContent = "Sending " + mins + " minutes to Second Life.";
          try {
            const response = await fetch("/api/hud/grant/" + encodeURIComponent(guestToken) + "/add", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ minutes: mins })
            });
            const result = await response.json();
            if (!response.ok) {
              status.textContent = (result && result.error) || "Could not send that.";
              return;
            }
            status.dataset.awaiting = "1";
            status.textContent = awaitingLine(result.price);
            addTime.textContent = awaitingLine();
          } catch (err) {
            status.textContent = "Could not send that.";
          }
        }
        if (!addMinutes.dataset.ready) {
          addMinutes.dataset.ready = "1";
          [1, 5, 10, 30].forEach((mins) => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = mins + " min";
            button.onclick = () => sendMinutes(mins);
            addMinutes.appendChild(button);
          });
          const other = document.createElement("button");
          other.type = "button";
          other.textContent = "Other";
          other.onclick = () => {
            addCustom.hidden = false;
            addCustomMinutes.focus();
          };
          addMinutes.appendChild(other);
          document.getElementById("addCustomSend").onclick = () => {
            const mins = Math.round(Number(addCustomMinutes.value));
            if (!mins || mins < 1 || mins > 60) {
              status.textContent = "Type 1 to 60 minutes.";
              return;
            }
            sendMinutes(mins);
          };
          addCustomMinutes.addEventListener("keydown", (event) => {
            if (event.key === "Enter") document.getElementById("addCustomSend").click();
          });
        }
        setInterval(() => {
          fetch("/api/hud/grant/" + encodeURIComponent(guestToken))
            .then((r) => r.json())
            .then((data) => {
              if (data && data.seconds_left != null) applyGrant(data);
              if (data && data.toys) showToys(data.toys);
              if (data && data.pending_add) {
                status.dataset.awaiting = "1";
                status.textContent = awaitingLine(data.pending_add.price);
                addTime.hidden = false;
                addTime.textContent = awaitingLine();
              } else if (data && data.rate) {
                if (status.dataset.awaiting === "1") status.textContent = "Drag it. She stays on.";
                delete status.dataset.awaiting;
                addTime.hidden = false;
                addTime.textContent = "Pick more minutes at L$" + data.rate + " each. Second Life asks you to pay that amount, then she confirms.";
              }
            })
            .catch(() => {});
        }, 4000);
      }
      tickGrant();
      setInterval(tickGrant, 1000);
    } else {
      const modeButton = document.getElementById("hudMode");
      modeButton.onclick = async () => {
        const next = sentMode === "hooker" ? "normal" : "hooker";
        try {
          const r = await fetch("/api/hud/mode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wearer_uuid: uuid, mode: next })
          });
          const data = await r.json();
          if (!r.ok || data.error) throw new Error(data.error || "Could not switch.");
          sentMode = data.hud_mode || next;
          modeButton.textContent = sentMode === "hooker" ? "Hooker HUD" : "Normal HUD";
          status.textContent = sentMode === "hooker"
            ? "Links now send the hooker HUD."
            : "Links now send the normal HUD.";
        } catch (e) {
          status.textContent = e.message || "Could not switch.";
        }
      };
      fetch("/api/hud/status/" + encodeURIComponent(uuid))
        .then((r) => r.json())
        .then((data) => {
          sentMode = data && data.hud_mode === "hooker" ? "hooker" : "normal";
          modeButton.textContent = sentMode === "hooker" ? "Hooker HUD" : "Normal HUD";
        })
        .catch(() => {});
    }
    if (!guestToken) {
      document.getElementById("modeTimed").onclick = () => chooseHold(false);
      document.getElementById("modeHold").onclick = () => chooseHold(true);
      paintModes();
    }
    loadToys().then(() => { if (!guestToken) readBattery(); });
    if (!guestToken) loadSaved();
    setInterval(() => {
      if (guestToken) {
        fetch("/api/hud/grant/" + encodeURIComponent(guestToken))
          .then((r) => r.json())
          .then((data) => {
            if (data && data.seconds_left != null) applyGrant(data);
            if (pageMode === "hooker" && data && data.pending_add) {
              const addTime = document.getElementById("addTime");
              status.dataset.awaiting = "1";
              status.textContent = awaitingLine(data.pending_add.price);
              addTime.hidden = false;
              addTime.textContent = awaitingLine();
            } else if (data && data.rate && pageMode === "hooker") {
              const addTime = document.getElementById("addTime");
              if (status.dataset.awaiting === "1") status.textContent = "Drag it. She stays on.";
              delete status.dataset.awaiting;
              addTime.hidden = false;
              addTime.textContent = "Pick more minutes at L$" + data.rate + " each. Second Life asks you to pay that amount, then she confirms.";
            }
            else if (data && data.error) {
              grantLeft = 0;
              grantRunning = false;
              renderGrant();
            }
            if (data && data.owner_name) showSender(data.owner_name);
            if (data && data.toys) showToys(data.toys);
            if (data && data.error) status.textContent = data.error;
          })
          .catch(() => {});
        return;
      }
      fetch("/api/hud/status/" + encodeURIComponent(uuid))
        .then((r) => r.json())
        .then((data) => {
          if (!data) return;
          if (data.connected && data.toys && data.toys.length) {
            showToys(data.toys);
            if (/not connected|No toys|Could not load|Failed to load/i.test(status.textContent || "")) {
              const names = selectedFunctions();
              status.textContent = stayingOn()
                ? "Move the slider. It stays on until you set it to 0."
                : (names.length > 1
                  ? "Each slider is one of this toy's controls."
                  : "Move the slider. Power follows while you drag.");
            }
            return;
          }
          if (!loadedToys.length) loadToys();
        })
        .catch(() => {});
    }, 5000);
  </script>
</body>
</html>`);
}

function guestMessage(text) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mālama Hōkū</title></head><body style="font-family:sans-serif;background:#111;color:#eee;max-width:420px;margin:0 auto;padding:24px"><img src="/logo.png" alt="Mālama Hōkū" style="width:220px;height:220px;border-radius:50%;object-fit:cover;display:block;margin:0 0 8px"><h1>Mālama Hōkū</h1><p>${text}</p></body></html>`;
}

app.get('/left', (req, res) => {
  res.type('html').send(guestMessage("You left. You must be 18 or older to enter."));
});

app.get('/control/:sl_uuid', (req, res) => {
  sendControlPage(res, req.params.sl_uuid, "", 0, "");
});

app.get('/guest/:token', async (req, res) => {
  try {
    const actor = await resolveControl({ grant_token: req.params.token });
    if (actor.error) return res.status(actor.status).type('html').send(guestMessage(actor.error));
    const session = await getSession(actor.wearer);
    const senderName = actor.senderName || (session && session.display_name) || "";
    sendControlPage(res, "", req.params.token, 0, senderName, actor.secondsLeft, actor.running, actor.hudMode, actor.rate);
  } catch (err) {
    console.error(err);
    res.status(500).type('html').send(guestMessage("Could not open this control link."));
  }
});

async function newestPendingUid() {
  const pending = await db.query(
    `SELECT sl_uuid FROM active_sessions
     WHERE status = 'pending'
       AND vibe_until > NOW() - INTERVAL '4 hours'
     ORDER BY vibe_until DESC
     LIMIT 1`
  );
  return pending.rows[0] && pending.rows[0].sl_uuid;
}

async function uidForToyCallback(body) {
  const domain = body.domain || '';
  const deviceCode = body.deviceCode ? String(body.deviceCode) : '';
  const rows = await db.query(
    `SELECT sl_uuid, status, toys FROM active_sessions WHERE status IN ('connected', 'pending')`
  );
  const sessions = rows.rows.map((row) => ({
    sl_uuid: row.sl_uuid,
    status: row.status,
    connection: parseConnection(row.toys) || {}
  }));
  if (domain) {
    const sameDomain = sessions.filter((row) => row.connection.domain === domain);
    if (sameDomain.length === 1) return sameDomain[0].sl_uuid;
  }
  if (deviceCode) {
    const sameDevice = sessions.filter((row) => String(row.connection.deviceCode || '') === deviceCode);
    if (sameDevice.length === 1) return sameDevice[0].sl_uuid;
  }
  const pending = await newestPendingUid();
  if (pending) return pending;
  const connected = sessions.filter((row) => row.status === 'connected');
  if (connected.length === 1) return connected[0].sl_uuid;
  return '';
}

app.post('/api/webhook/lovense', async (req, res) => {
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { body = {}; }
  }
  const nested = body.data && typeof body.data === 'object' ? body.data : {};
  let uid = body.uid || body.userId || body.uuid || body.user_id || nested.uid || nested.userId || nested.uuid;
  const utoken = body.utoken || nested.utoken;
  const domain = body.domain || nested.domain;
  const httpPort = body.httpPort || nested.httpPort;
  const httpsPort = body.httpsPort || nested.httpsPort;
  const wsPort = body.wsPort || nested.wsPort;
  const wssPort = body.wssPort || nested.wssPort;
    const platform = body.platform || nested.platform;
    const appType = body.appType || nested.appType;
    const deviceCode = body.deviceCode || nested.deviceCode || '';
  if (!body.toyList && nested.toyList) body = { ...nested, ...body };

  try {
    if (!uid && utoken) {
      const byToken = await db.query(
        'SELECT sl_uuid FROM active_sessions WHERE lovense_token = $1',
        [utoken]
      );
      uid = byToken.rows[0] && byToken.rows[0].sl_uuid;
    }
    if (!uid && (body.toyList || body.deviceCode || body.domain)) {
      uid = await uidForToyCallback(body);
      if (uid) console.log('Lovense callback matched a saved link');
    }
    if (!uid) {
      console.error('Lovense callback missing uid', Object.keys(body));
      return res.status(400).send('Missing uid.');
    }

    const userCheck = await db.query(
      'SELECT sl_http_url, lovense_token, status, toys, display_name FROM active_sessions WHERE sl_uuid = $1',
      [uid]
    );

    let session = userCheck.rows[0];
    if (!session) {
      const pending = await newestPendingUid();
      if (pending && pending !== uid) {
        const retry = await db.query(
          'SELECT sl_http_url, lovense_token, status, toys, display_name FROM active_sessions WHERE sl_uuid = $1',
          [pending]
        );
        session = retry.rows[0];
        if (session) {
          console.log('Lovense callback matched the open scan', pending);
          uid = pending;
        }
      }
    }
    if (!session) {
      return res.status(404).send("User session not found in database.");
    }
    if (session.status === 'disconnected') {
      return res.sendStatus(200);
    }
    if (utoken && session.lovense_token && utoken !== session.lovense_token) {
      console.log('Lovense utoken changed for', uid);
    }

    const previous = parseConnection(session.toys);
    const incomingToys = toysFromCallback(body) || (previous && previous.toys) || null;
    let mergedToys = preserveBattery(previous && previous.toys, incomingToys);
    if (mergedToys && typeof mergedToys === 'object' && !Array.isArray(mergedToys)) {
      for (const item of collectBatteries(body)) {
        if (item.battery == null) continue;
        const key = (item.id && mergedToys[item.id] && item.id)
          || Object.keys(mergedToys).find((id) => mergedToys[id] && (mergedToys[id].id === item.id || id === item.id));
        if (!key || toyBattery(mergedToys[key]) != null) continue;
        mergedToys[key] = { ...mergedToys[key], battery: item.battery };
      }
    }
    const connection = { toys: mergedToys, domain, httpPort, httpsPort, wsPort, wssPort, platform, appType, deviceCode };
    const reported = listToys(connection).map((toy) => ({
      name: toy.name,
      battery: toy.battery
    }));
    console.log('Lovense link update', { platform, appType, domain, toys: reported });
    if (reported.some((toy) => toy.battery != null)) {
      batteryCache.set(uid, { at: Date.now(), toys: listToys(connection) });
    }

    await db.query(
      `UPDATE active_sessions
       SET status = 'connected', toys = $1, lovense_token = COALESCE($3, lovense_token)
       WHERE sl_uuid = $2`,
      [JSON.stringify(connection), uid, utoken || null]
    );

    getToysAt.delete(uid);
    linkCache.set(uid, {
      at: Date.now(),
      session: { ...session, status: 'connected', connection }
    });
    scheduleGetToys({ sl_uuid: uid, status: 'connected', connection }, true);

    if (session.sl_http_url && session.status !== 'connected') {
      await fetch(session.sl_http_url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: "CONNECTED|Successfully linked your Lovense toy!"
      });
    }

    watchBattery({
      sl_uuid: uid,
      status: 'connected',
      display_name: session.display_name,
      connection
    });

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

    stopBatteryWatch(slUuid);
    forgetLink(slUuid);
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

app.post('/api/hud/battery', async (req, res) => {
  const slUuid = req.body.sl_uuid || req.body.wearer_uuid;
  const reported = Array.isArray(req.body.toys) ? req.body.toys : [];
  if (!slUuid) {
    return res.status(400).json({ error: "Missing wearer_uuid." });
  }
  try {
    const session = await getSession(slUuid);
    if (!session || session.status !== 'connected') {
      return res.status(404).json({ error: "Toy is not connected." });
    }
    const incoming = reported.map((toy) => ({
      id: toy.id,
      name: toy.name || toy.nickName,
      type: toy.type,
      battery: toyBattery(toy),
      functions: (toy.fullFunctionNames || toy.shortFunctionNames || toy.functions)
        ? functionsForToy({
          fullFunctionNames: toy.fullFunctionNames || toy.functions,
          shortFunctionNames: toy.shortFunctionNames,
          toyType: toy.type || toy.name
        })
        : undefined
    })).filter((toy) => toy.battery != null);
    if (!incoming.length) {
      return res.json({ success: false });
    }
    const toys = mergeBattery(listToys(session.connection), incoming);
    batteryCache.set(slUuid, { at: Date.now(), toys });
    await rememberBatteries(session, toys);
    return res.json({ success: true, toy_line: toyLine(toys), toys });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save battery." });
  }
});

const LOVENSE_PRESETS = new Set(['pulse', 'wave', 'fireworks', 'earthquake']);

function cleanPatternName(raw) {
  const name = String(raw || '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 24) return null;
  return name;
}

function normalizeSteps(raw) {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 50) return null;
  const steps = [];
  for (const item of raw) {
    const value = parseInt(item, 10);
    if (Number.isNaN(value)) return null;
    steps.push(Math.max(0, Math.min(20, value)));
  }
  if (steps.every((n) => n === 0)) return null;
  return steps;
}

app.get('/api/hud/patterns/:sl_uuid', async (req, res) => {
  const wearer = String(req.params.sl_uuid || '');
  if (!wearer || wearer.length > 80) return res.status(400).json({ error: "Missing wearer." });
  try {
    const result = await db.query(
      `SELECT id, name, steps FROM saved_patterns WHERE sl_uuid = $1 ORDER BY created_at ASC, id ASC`,
      [wearer]
    );
    res.json({ patterns: result.rows });
  } catch (err) {
    console.error("Pattern list error:", err);
    res.status(500).json({ error: "Could not load saved patterns." });
  }
});

app.post('/api/hud/patterns', async (req, res) => {
  const wearer = String(req.body.wearer_uuid || '');
  const name = cleanPatternName(req.body.name);
  const steps = normalizeSteps(req.body.steps);
  if (!wearer || wearer.length > 80) return res.status(400).json({ error: "Missing wearer_uuid." });
  if (!name) return res.status(400).json({ error: "Name the pattern in 24 characters or less." });
  if (!steps) return res.status(400).json({ error: "Draw at least one beat, up to 50." });

  try {
    const existing = await db.query(
      `SELECT id FROM saved_patterns WHERE sl_uuid = $1 AND name_key = $2`,
      [wearer, name.toLowerCase()]
    );
    if (!existing.rows.length) {
      const count = await db.query(
        `SELECT COUNT(*)::int AS n FROM saved_patterns WHERE sl_uuid = $1`,
        [wearer]
      );
      if (count.rows[0].n >= 12) {
        return res.status(400).json({ error: "This avatar already has 12 patterns. Remove one to save another." });
      }
    }
    const saved = await db.query(
      `INSERT INTO saved_patterns (sl_uuid, name, name_key, steps)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (sl_uuid, name_key)
       DO UPDATE SET name = EXCLUDED.name, steps = EXCLUDED.steps
       RETURNING id, name`,
      [wearer, name, name.toLowerCase(), JSON.stringify(steps)]
    );
    res.json({ success: true, pattern: saved.rows[0] });
  } catch (err) {
    console.error("Pattern save error:", err);
    res.status(500).json({ error: "Could not save that pattern." });
  }
});

app.post('/api/hud/patterns/delete', async (req, res) => {
  const wearer = String(req.body.wearer_uuid || '');
  const id = parseInt(req.body.id, 10);
  if (!wearer || !id) return res.status(400).json({ error: "Missing pattern." });
  try {
    await db.query(`DELETE FROM saved_patterns WHERE id = $1 AND sl_uuid = $2`, [id, wearer]);
    res.json({ success: true });
  } catch (err) {
    console.error("Pattern delete error:", err);
    res.status(500).json({ error: "Could not remove that pattern." });
  }
});

app.post('/api/hud/custom-pattern', async (req, res) => {
  const actor = await resolveControl(req.body);
  if (actor.error) return res.status(actor.status).json({ error: actor.error });
  const wearer = actor.wearer;
  if (!actor.guest) await releaseGuestRun(wearer);

  try {
    const session = await getSession(wearer);
    if (!session || session.status !== 'connected') {
      return res.status(404).json({ error: "Toy is not connected or session expired. Re-link the QR." });
    }

    let steps = normalizeSteps(req.body.steps);
    if (!steps && req.body.id) {
      const stored = await db.query(
        `SELECT steps FROM saved_patterns WHERE id = $1 AND sl_uuid = $2`,
        [parseInt(req.body.id, 10), wearer]
      );
      if (!stored.rows.length) return res.status(404).json({ error: "That saved pattern is gone." });
      steps = normalizeSteps(stored.rows[0].steps);
    }
    if (!steps) return res.status(400).json({ error: "That pattern has no beats." });

    const hold = wantsHold(req.body, actor, false);
    let seconds = parseInt(req.body.duration, 10);
    if (Number.isNaN(seconds)) seconds = hold ? 0 : 5;
    if (hold) {
      seconds = 0;
    } else {
      const customCap = actor.guest ? Math.max(2, actor.secondsLeft || 60) : 60;
      seconds = Math.max(2, Math.min(customCap, seconds));
      const limitedCustom = limitSeconds(seconds, actor);
      if (limitedCustom.error) return res.status(limitedCustom.status).json({ error: limitedCustom.error });
      seconds = limitedCustom.seconds;
    }
    cancelFade(wearer);

    const commandData = await sendCustomPattern(
      wearer,
      session.connection,
      req.body.toy_id,
      steps,
      hold ? 0 : seconds
    );
    if (!commandOk(commandData)) {
      const offline = commandData && (commandData.code === 507 || /offline/i.test(String(commandData.message || '')));
      return res.status(502).json({
        error: offline
          ? "Lovense Remote is asleep. Open Remote, keep the phone screen on, then try the pattern again."
          : (commandData.message || "Lovense rejected the pattern."),
        details: commandData
      });
    }

    await db.query(
      `UPDATE active_sessions
       SET vibe_strength = 10,
           vibe_until = NOW() + ($2 * INTERVAL '1 second')
       WHERE sl_uuid = $1`,
      [wearer, hold ? HOLD_DB_SECONDS : seconds]
    );
    if (actor.guest) {
      const clock = await startGuestClock(actor, wearer);
      if (clock) Object.assign(commandData, clock);
    }
    return res.json({ success: true, details: commandData, seconds_left: commandData.seconds_left, running: commandData.running });
  } catch (err) {
    console.error("Custom pattern error:", err);
    res.status(500).json({ error: err.message || "Failed to start the pattern." });
  }
});

app.post('/api/hud/pattern', async (req, res) => {
  const actor = await resolveControl(req.body);
  if (actor.error) return res.status(actor.status).json({ error: actor.error });
  const wearer = actor.wearer;
  const name = String(req.body.name || '').toLowerCase();
  if (!LOVENSE_PRESETS.has(name)) {
    return res.status(400).json({ error: "Choose pulse, wave, fireworks, or earthquake." });
  }
  if (!actor.guest) await releaseGuestRun(wearer);

  try {
    const session = await getSession(wearer);
    if (!session || session.status !== 'connected') {
      return res.status(404).json({ error: "Toy is not connected or session expired. Re-link the QR." });
    }

    const hold = wantsHold(req.body, actor, false);
    let seconds = parseInt(req.body.duration, 10);
    if (Number.isNaN(seconds)) seconds = hold ? 0 : 5;
    if (hold) {
      seconds = 0;
    } else {
      const presetCap = actor.guest ? Math.max(2, actor.secondsLeft || 60) : 60;
      seconds = Math.max(2, Math.min(presetCap, seconds));
      const limitedPreset = limitSeconds(seconds, actor);
      if (limitedPreset.error) return res.status(limitedPreset.status).json({ error: limitedPreset.error });
      seconds = limitedPreset.seconds;
    }
    cancelFade(wearer);

    const command = {
      command: 'Preset',
      name,
      timeSec: hold ? 0 : seconds,
      apiVer: 1
    };
    if (req.body.toy_id) command.toy = req.body.toy_id;

    const commandData = await sendToyCommand(wearer, session.connection, command);
    if (!commandOk(commandData)) {
      const offline = commandData && (commandData.code === 507 || /offline/i.test(String(commandData.message || '')));
      return res.status(502).json({
        error: offline
          ? "Lovense Remote is asleep. Open Remote, keep the phone screen on, then try the pattern again."
          : (commandData.message || "Lovense rejected the pattern."),
        details: commandData
      });
    }

    await db.query(
      `UPDATE active_sessions
       SET vibe_strength = 10,
           vibe_until = NOW() + ($2 * INTERVAL '1 second')
       WHERE sl_uuid = $1`,
      [wearer, hold ? HOLD_DB_SECONDS : seconds]
    );
    if (actor.guest) {
      const clock = await startGuestClock(actor, wearer);
      if (clock) Object.assign(commandData, clock);
    }
    return res.json({
      success: true,
      pattern: name,
      details: commandData,
      seconds_left: commandData.seconds_left,
      running: commandData.running
    });
  } catch (err) {
    console.error("Pattern error:", err);
    res.status(500).json({ error: err.message || "Failed to start the pattern." });
  }
});

app.post('/api/hud/vibrate', async (req, res) => {
  const actor = await resolveControl(req.body);
  if (actor.error) return res.status(actor.status).json({ error: actor.error });
  const wearer_uuid = actor.wearer;
  const { strength, duration, toy_id, stop } = req.body;
  const seq = parseInt(req.body.seq, 10) || 0;
  const delivered = req.body.delivered === true || req.body.delivered === 'true';
  if (!actor.guest) releaseOwnerTakeover(wearer_uuid);

  try {
    const session = await linkForCommand(wearer_uuid);
    if (!session || session.status !== 'connected') {
      return res.status(404).json({ error: "Toy is not connected or session expired. Re-link the QR." });
    }

    const levelMap = req.body.levels;
    if (levelMap && typeof levelMap === 'object' && !Array.isArray(levelMap)) {
      let seconds = parseInt(duration, 10);
      if (Number.isNaN(seconds)) seconds = 0;
      const vibeCap = actor.guest ? Math.max(1, actor.secondsLeft || 60) : 60;
      const built = levelsToCommand(levelMap);
      const stopNow = stop === true || stop === 'true' || (!built.action && !built.position);
      const hold = wantsHold(req.body, actor, stopNow);
      if (!hold) seconds = Math.max(0, Math.min(vibeCap, seconds));
      if (actor.guest && !stopNow) {
        const limited = limitSeconds(Math.max(1, seconds), actor);
        if (limited.error) return res.status(limited.status).json({ error: limited.error });
        seconds = limited.seconds;
      }
      const seen = ensureFollower(wearer_uuid);
      if (seq && seen.seq && seq < seen.seq) {
        return res.json({ success: true, ignored: true });
      }
      if (seq) seen.seq = seq;
      let commandData;
      if (delivered && !stopNow) {
        seen.connection = session.connection;
        seen.target = 0;
        seen.at = 0;
        seen.flat = true;
        seen.hold = false;
        if (seen.abort) seen.abort.abort();
        commandData = { code: 200, result: true };
      } else if (stopNow) {
        cancelFade(wearer_uuid);
        commandData = await sendToyCommand(wearer_uuid, session.connection, {
          command: 'Function',
          action: 'Stop',
          timeSec: 0,
          apiVer: 1,
          stopPrevious: 1
        });
      } else {
        if (built.action) {
          const command = {
            command: 'Function',
            action: built.action,
            timeSec: hold ? 0 : Math.max(1, seconds),
            apiVer: 1,
            stopPrevious: 1
          };
          if (toy_id) command.toy = toy_id;
          commandData = await sendToyCommand(wearer_uuid, session.connection, command);
        }
        if (built.position && (!commandData || commandOk(commandData))) {
          const position = {
            command: 'Position',
            value: String(built.position),
            apiVer: 1
          };
          if (toy_id) position.toy = toy_id;
          const moved = await sendToyCommand(wearer_uuid, session.connection, position);
          if (!commandData || !commandOk(moved)) commandData = moved;
        }
      }
      if (!commandOk(commandData)) {
        const offline = commandData && (commandData.code === 507 || /offline/i.test(String(commandData.message || '')));
        return res.status(502).json({
          error: offline
            ? "Lovense Remote is asleep. Open Remote, keep the phone screen on, then try again."
            : (commandData.message || "Lovense rejected the command."),
          details: commandData
        });
      }
      const strengthNow = stopNow ? 0 : Math.max(
        scaledLevel('Vibrate', levelMap.Vibrate || 0),
        scaledLevel('Rotate', levelMap.Rotate || 0),
        scaledLevel('Thrusting', levelMap.Thrusting || 0),
        1
      );
      db.query(
        `UPDATE active_sessions
         SET vibe_strength = $2,
             vibe_until = CASE
               WHEN $2 <= 0 THEN NOW()
               ELSE NOW() + ($3 * INTERVAL '1 second')
             END
         WHERE sl_uuid = $1`,
        [wearer_uuid, strengthNow, stopNow ? 0 : (hold ? HOLD_DB_SECONDS : Math.max(1, seconds))]
      ).catch((err) => console.error('Vibe save failed:', err.message));
      let clock = {};
      if (actor.guest && stopNow) clock = await stopGuestClock(actor, wearer_uuid);
      else if (actor.guest) clock = await startGuestClock(actor, wearer_uuid) || {};
      return res.json({ success: true, details: commandData, seconds_left: clock.seconds_left, running: clock.running });
    }

    let percent = parseInt(strength, 10);
    if (Number.isNaN(percent)) percent = 0;
    percent = Math.max(0, Math.min(100, percent));
    const level = percentToLevel(percent);
    let seconds = parseInt(duration, 10);
    if (Number.isNaN(seconds)) seconds = 0;
    const vibeCap = actor.guest ? Math.max(1, actor.secondsLeft || 60) : 60;
    const stopNow = stop === true || stop === 'true';
    const stopping = stopNow || level === 0;
    const hold = wantsHold(req.body, actor, stopping);
    if (!hold) seconds = Math.max(0, Math.min(vibeCap, seconds));
    if (actor.guest && !stopping) {
      const limited = limitSeconds(seconds, actor);
      if (limited.error) return res.status(limited.status).json({ error: limited.error });
      seconds = limited.seconds;
    }

    const seen = ensureFollower(wearer_uuid);
    if (seq && seen.seq && seq < seen.seq) {
      return res.json({ success: true, ignored: true });
    }
    let commandData;
    if (delivered && !stopping) {
      if (seq) seen.seq = seq;
      seen.connection = session.connection;
      seen.toyId = toy_id || seen.toyId;
      if (seen.timer) {
        clearTimeout(seen.timer);
        seen.timer = null;
        seen.timerWait = null;
      }
      seen.local = true;
      seen.target = level;
      seen.at = level;
      seen.flat = true;
      seen.hold = !!hold;
      seen.until = hold
        ? Number.POSITIVE_INFINITY
        : Date.now() + Math.max(1, seconds) * 1000;
      if (seen.abort && seen.sending !== level) seen.abort.abort();
      commandData = { code: 200, result: true };
    } else {
      commandData = await sendSmoothLevel(
        wearer_uuid,
        session.connection,
        toy_id,
        level,
        stopping ? 0 : (hold ? 0 : Math.max(1, seconds)),
        hold && !stopping,
        seq
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

    const strengthNow = stopping ? 0 : level;
    const holdSeconds = strengthNow === 0 ? 0 : (hold ? HOLD_DB_SECONDS : Math.max(1, seconds));
    db.query(
      `UPDATE active_sessions
       SET vibe_strength = $2,
           vibe_until = CASE
             WHEN $2 <= 0 THEN NOW()
             ELSE NOW() + ($3 * INTERVAL '1 second')
           END
       WHERE sl_uuid = $1`,
      [wearer_uuid, strengthNow, holdSeconds]
    ).catch((err) => console.error('Vibe save failed:', err.message));
    let clock = {};
    if (actor.guest && stopping) clock = await stopGuestClock(actor, wearer_uuid);
    else if (actor.guest) clock = await startGuestClock(actor, wearer_uuid) || {};

    return res.json({ success: true, details: commandData, seconds_left: clock.seconds_left, running: clock.running });
  } catch (err) {
    console.error("Vibration execution error:", err);
    res.status(500).json({ error: err.message || "Failed to transmit vibe command." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Database-connected server is listening on port ${PORT}`);
});
