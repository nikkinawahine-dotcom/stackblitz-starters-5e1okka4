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
  if (Number.isNaN(n) || n < 0) return null;
  return Math.max(0, Math.min(100, n));
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

function toysFromCallback(body) {
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body.toyList)) {
    const map = {};
    for (const toy of body.toyList) {
      if (!toy || typeof toy !== 'object') continue;
      const id = toy.id || toy.toyId;
      if (!id) continue;
      const battery = toyBattery(toy);
      map[id] = {
        id,
        name: toy.toyType || toy.name || 'toy',
        nickName: toy.nickname || toy.nickName || toy.name || '',
        status: toy.connected === false || toy.status === 0 || toy.status === '0' ? 0 : 1,
        ...(battery == null ? {} : { battery })
      };
    }
    return map;
  }
  return body.toys || null;
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
  const byId = new Map(extra.filter((toy) => toy.id).map((toy) => [toy.id, toy]));
  const only = extra.length === 1 && base.length === 1 ? extra[0] : null;
  if (!base.length) return extra;
  return base.map((toy) => {
    const live = byId.get(toy.id)
      || extra.find((item) => item.id && item.id === toy.id)
      || extra.find((item) => item.name && toy.name && String(item.name).toLowerCase() === String(toy.name).toLowerCase())
      || only;
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
    let key = Object.keys(toysObj).find((id) => id === toy.id || (toysObj[id] && toysObj[id].id === toy.id));
    if (!key && Object.keys(toysObj).length === 1) key = Object.keys(toysObj)[0];
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

const getToysAt = new Map();

function scheduleGetToys(session) {
  const uid = session.sl_uuid;
  if (Date.now() - (getToysAt.get(uid) || 0) < 60000) return;
  getToysAt.set(uid, Date.now());
  sendLovenseCommand(uid, { command: 'GetToys', apiVer: 1 })
    .then(async (live) => {
      const parsed = toysFromCommand(live);
      if (!parsed.some((toy) => toy.battery != null)) {
        const data = live && live.data;
        const keys = data && typeof data === 'object' ? Object.keys(data) : [];
        console.log('GetToys had no battery', live && live.code, keys.join(','));
        return;
      }
      const fresh = await getSession(uid);
      if (!fresh || fresh.status !== 'connected') return;
      const toys = mergeBattery(listToys(fresh.connection), parsed);
      batteryCache.set(uid, { at: Date.now(), toys });
      await rememberBatteries(fresh, toys);
      console.log('Lovense battery', toys.map((toy) => ({ name: toy.name, battery: toy.battery })));
    })
    .catch((err) => console.error('GetToys for titler failed:', err.message));
}

async function toysForSession(session) {
  watchBattery(session);
  let toys = listToys(session.connection);
  const cached = batteryCache.get(session.sl_uuid);
  if (cached) toys = mergeBattery(toys, cached.toys);
  if (toys.some((toy) => toy.battery == null)) scheduleGetToys(session);
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
    }
    if (watcher.stopped) return;
    await new Promise((resolve) => setTimeout(resolve, 15000));
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
    if (old && toyBattery(toy) == null && toyBattery(old) != null) {
      copy[id] = { ...toy, battery: toyBattery(old) };
    }
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
    }),
    signal: AbortSignal.timeout(4000)
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

function percentToLevel(percent) {
  const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  if (p <= 0) return 0;
  return Math.max(4, Math.round((p * 20) / 100));
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

function functionCommand(action, seconds, toyId) {
  const command = {
    command: 'Function',
    action,
    timeSec: action === 'Stop' ? 0 : Math.max(1, seconds),
    apiVer: 1,
    stopPrevious: 1
  };
  if (toyId && action !== 'Stop') command.toy = toyId;
  return command;
}

const SEND_GAP_MS = 200;

function clampLevel(value) {
  return Math.max(0, Math.min(20, value | 0));
}

function motorLevel(level) {
  const n = clampLevel(level);
  if (n <= 0) return 0;
  return Math.max(4, n);
}

function lerpSteps(from, to) {
  const start = motorLevel(from);
  const end = motorLevel(to);
  const steps = [];
  let level = start;
  steps.push(level);
  while (level !== end && steps.length < 8) {
    const diff = end - level;
    level += Math.sign(diff) * Math.min(4, Math.abs(diff));
    steps.push(level);
  }
  steps[steps.length - 1] = end;
  while (steps.length < 15) steps.push(end);
  return steps;
}

const followers = new Map();

function stopFollower(uid) {
  const state = followers.get(uid);
  if (!state) return;
  state.gen += 1;
  if (state.timer) clearTimeout(state.timer);
  followers.delete(uid);
}

function ensureFollower(uid) {
  let state = followers.get(uid);
  if (!state) {
    state = {
      gen: 1,
      lastSent: 0,
      target: 0,
      until: 0,
      sentAt: 0,
      playUntil: 0,
      busy: false,
      timer: null,
      lastResult: { code: 200, result: true }
    };
    followers.set(uid, state);
  }
  return state;
}

async function sendPattern(uid, connection, toyId, steps) {
  const pattern = {
    command: 'Pattern',
    rule: 'V:1;F:v;S:100#',
    strength: steps.join(';'),
    timeSec: Number((steps.length * 0.1).toFixed(1)),
    apiVer: 2
  };
  if (toyId) pattern.toy = toyId;
  return sendToyCommand(uid, connection, pattern);
}

function scheduleFlush(uid, delay) {
  const state = followers.get(uid);
  if (!state || state.timer || state.busy) return;
  const gap = Math.max(0, state.sentAt + SEND_GAP_MS - Date.now());
  const wait = Math.max(gap, delay || 0);
  state.timer = setTimeout(() => {
    state.timer = null;
    flushLevel(uid).catch((err) => console.error('Slider flush failed:', err.message));
  }, wait);
}

async function flushLevel(uid) {
  const state = followers.get(uid);
  if (!state || state.busy) return;
  if (Date.now() >= state.until || state.target === 0) return;
  const target = motorLevel(state.target);
  const same = target === state.lastSent;
  const holdLeft = (state.playUntil || 0) - Date.now();
  if (same && holdLeft > 500) {
    scheduleFlush(uid, holdLeft - 400);
    return;
  }
  if (!same && Date.now() - state.sentAt < SEND_GAP_MS) {
    scheduleFlush(uid);
    return;
  }

  const gen = state.gen;
  state.busy = true;
  const steps = same ? Array(15).fill(target) : lerpSteps(state.lastSent, target);
  try {
    const result = await sendPattern(uid, state.connection, state.toyId, steps);
    state.lastResult = result;
    if (!followers.get(uid) || state.gen !== gen) return;
    if (!commandOk(result)) {
      console.error('Slider pattern rejected:', result && result.code, result && result.message);
      state.sentAt = Date.now();
      return;
    }
    state.lastSent = target;
    state.sentAt = Date.now();
    state.playUntil = state.sentAt + steps.length * 100;
  } catch (err) {
    console.error('Slider pattern failed:', err.message);
    state.lastResult = { code: 500, message: err.message };
    state.sentAt = Date.now();
  } finally {
    const current = followers.get(uid);
    if (current && current.gen === gen) {
      current.busy = false;
      if (Date.now() < current.until && current.target !== 0) {
        const left = current.playUntil - Date.now();
        const changed = motorLevel(current.target) !== current.lastSent;
        scheduleFlush(uid, changed ? 0 : Math.max(0, left - 400));
      }
    }
  }
}

async function sendSmoothLevel(uid, connection, toyId, target, seconds) {
  if (target === 0) {
    const state = followers.get(uid);
    stopFollower(uid);
    if (state && state.lastSent === 0 && Date.now() - state.sentAt < 1000) {
      return { code: 200, result: true };
    }
    return sendToyCommand(uid, connection, functionCommand('Stop', 0, toyId));
  }

  const state = ensureFollower(uid);
  state.connection = connection;
  state.toyId = toyId || state.toyId;
  state.target = motorLevel(target);
  state.until = Date.now() + Math.max(1, seconds) * 1000;
  if (state.target === state.lastSent && state.playUntil - Date.now() > 500) {
    return { code: 200, result: true };
  }
  if (state.busy || Date.now() - state.sentAt < SEND_GAP_MS) {
    scheduleFlush(uid);
    return { code: 200, result: true };
  }
  await flushLevel(uid);
  return state.lastResult || { code: 200, result: true };
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

    const toys = await toysForSession(session);
    const local = localCommandUrl(session.connection);

    return res.json({ toys, local_command: local });
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
  <p>Drag the slider from 0 to 100. Power eases in small steps, and the page sends at most one update every fifth of a second.</p>
  <label for="toy">Toy</label>
  <select id="toy"><option value="">All connected toys</option></select>
  <label for="strength">Vibration 0–100: <span id="strengthVal">0</span></label>
  <input id="strength" type="range" min="0" max="100" step="1" value="0">
  <label for="duration">Seconds</label>
  <input id="duration" type="number" min="1" max="60" value="5">
  <button id="vibrate">Vibrate for those seconds</button>
    <button id="stop" class="secondary">Stop</button>
    <button id="disconnect" class="secondary">Disconnect</button>
  <p id="battery"></p>
  <p id="status">Loading toys…</p>
  <script>
    const uuid = ${JSON.stringify(slUuid)};
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
    let localCommand = "";

    function toyStep(percent) {
      const p = Math.max(0, Math.min(100, percent));
      if (p <= 0) return 0;
      return Math.max(4, Math.round((p * 20) / 100));
    }

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
        const level = desired;
        const step = toyStep(level);
        const left = level === 0 ? 0 : remaining();
        if (level > 0 && left <= 0) return;
        if (step === lastSent) {
          if (toyStep(desired) !== lastSent) queueSend();
          return;
        }
        lastSent = step;
        postCommand(commandBody(level, left)).catch((e) => {
          lastSent = -1;
          status.textContent = e.message || "Command failed.";
        });
        status.textContent = level === 0
          ? "Stopped."
          : ("Strength " + level + " of 100, step " + step + " of 20");
      }, 200);
    }

    strength.oninput = () => {
      const level = parseInt(strength.value, 10) || 0;
      strengthVal.textContent = String(level);
      desired = level;
      if (level > 0) beginSession();
      else stopClock();
        queueSend();
    };

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
        queueSend();
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
      if (selected) toySelect.value = selected;
      const withBattery = (toys || []).filter((toy) => toy.battery != null);
      batteryLine.textContent = withBattery.length
        ? withBattery.map((toy) => toy.name + "  " + toy.battery + "%").join(" | ")
        : "";
    }

    function parseLocalToys(data) {
      let payload = data && data.data && data.data.toys ? data.data.toys : (data && data.toys);
      if (!payload) return [];
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch (e) { return []; }
      }
      return Object.values(payload).map((toy) => {
        const raw = toy.battery != null ? toy.battery : toy.batt;
        const n = parseInt(raw, 10);
        return {
          id: toy.id,
          name: toy.nickName || toy.name || toy.id,
          type: toy.name || "toy",
          battery: Number.isNaN(n) ? null : Math.max(0, Math.min(100, n))
        };
      }).filter((toy) => toy.battery != null);
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
        const r = await fetch("/api/hud/toys/" + encodeURIComponent(uuid));
        const data = await r.json();
        if (!r.ok) {
          status.textContent = data.error || "Could not load toys.";
          return;
        }
        localCommand = data.local_command || "";
        showToys(data.toys);
        status.textContent = (data.toys && data.toys.length)
          ? "Drag the slider from 0 to 100. It eases through the toy's 20 steps."
          : "No toys reported yet. Keep Lovense Connect open and refresh.";
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
      queueSend();
    };
    document.getElementById("stop").onclick = () => {
      stopClock();
      strength.value = "0";
      strengthVal.textContent = "0";
      desired = 0;
      queueSend();
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
    loadToys().then(() => readBattery());
    setInterval(() => {
      fetch("/api/hud/status/" + encodeURIComponent(uuid))
        .then((r) => r.json())
        .then((data) => { if (data && data.toys) showToys(data.toys); })
        .catch(() => {});
    }, 20000);
  </script>
</body>
</html>`);
});

app.post('/api/webhook/lovense', async (req, res) => {
  const body = req.body || {};
  let uid = body.uid || body.userId || body.uuid;
  const utoken = body.utoken;
  const { domain, httpPort, httpsPort, wsPort, wssPort, platform, appType } = body;

  try {
    if (!uid && utoken) {
      const byToken = await db.query(
        'SELECT sl_uuid FROM active_sessions WHERE lovense_token = $1',
        [utoken]
      );
      uid = byToken.rows[0] && byToken.rows[0].sl_uuid;
    }
    if (!uid) {
      console.error('Lovense callback missing uid', Object.keys(body));
      return res.status(400).send('Missing uid.');
    }

    const userCheck = await db.query(
      'SELECT sl_http_url, lovense_token, status, toys, display_name FROM active_sessions WHERE sl_uuid = $1',
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
    const connection = { toys: mergedToys, domain, httpPort, httpsPort, wsPort, wssPort, platform, appType };
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

    watchBattery({
      sl_uuid: uid,
      status: 'connected',
      display_name: session.display_name
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
      battery: toyBattery(toy)
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

    let percent = parseInt(strength, 10);
    if (Number.isNaN(percent)) percent = 0;
    percent = Math.max(0, Math.min(100, percent));
    const level = percentToLevel(percent);
    let seconds = parseInt(duration, 10);
    if (Number.isNaN(seconds)) seconds = 0;
    seconds = Math.max(0, Math.min(60, seconds));
    const stopNow = stop === true || stop === 'true' || percent === 0;

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
