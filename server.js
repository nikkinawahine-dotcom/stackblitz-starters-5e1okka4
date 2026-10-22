require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Establish secure access parameters to cloud storage
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Primary validation pathway
app.get('/', async (req, res) => {
  try {
    const dbTest = await db.query('SELECT NOW()');
    res.send(`Your Bridge Server is online and successfully connected to Neon Database! Time: ${dbTest.rows[0].now}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server is up, but failed to connect to the database. Check your .env file!");
  }
});

// ==========================================
// API ROUTE: HUD REGISTER SESSION PATHWAY
// ==========================================
app.post('/api/hud/register', async (req, res) => {
  const { sl_uuid, sl_http_url } = req.body;

  if (!sl_uuid || !sl_http_url) {
    return res.status(400).json({ error: "Missing avatar UUID or HTTP URL data." });
  }

  try {
    await db.query(
      `INSERT INTO active_sessions (sl_uuid, sl_http_url, status) 
       VALUES ($1, $2, 'pending') 
       ON CONFLICT (sl_uuid) DO UPDATE SET sl_http_url = $2, status = 'pending'`,
      [sl_uuid, sl_http_url]
    );

    return res.json({ 
      success: true, 
      message: "Session registered in database. Ready for Lovense link!" 
    });
    
  } catch (err) {
    console.error("Database registration error:", err);
    res.status(500).json({ error: "Server encountered a database error during registration." });
  }
});

// ==========================================
// API ROUTE: LOVENSE CLOUD WEBHOOK CALLBACK
// ==========================================
app.post('/api/webhook/lovense', async (req, res) => {
  const { uid, token, status, toys } = req.body; 

  try {
    const userCheck = await db.query('SELECT sl_http_url FROM active_sessions WHERE sl_uuid = \$1', [uid]);
    
    if (userCheck.rows.length === 0) {
      return res.status(404).send("User session not found in database.");
    }
    
    const sl_url = userCheck.rows[0].sl_http_url;

    await db.query(
      `UPDATE active_sessions 
       SET lovense_token = $1, status = 'connected', toys = $2 
       WHERE sl_uuid = $3`,
      [token, JSON.stringify(toys), uid]
    );

    await fetch(sl_url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: "CONNECTED|Successfully linked your Lovense toy!"
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("Lovense Webhook Error:", err);
    res.sendStatus(500);
  }
});

// ==========================================
// API ROUTE: HUD TRIGGERS A VIBRATION COMMAND
// ==========================================
app.post('/api/hud/vibrate', async (req, res) => {
  const { wearer_uuid, strength, duration } = req.body; 

  if (!wearer_uuid || strength === undefined) {
    return res.status(400).json({ error: "Missing wearer_uuid or strength level." });
  }

  try {
    const userCheck = await db.query(
      "SELECT lovense_token FROM active_sessions WHERE sl_uuid = \$1 AND status = 'connected'", 
      [wearer_uuid]
    );
    
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "Toy is not connected or session expired." });
    }

    const targetToken = userCheck.rows[0].lovense_token;
    const devToken = process.env.LOVENSE_DEVELOPER_TOKEN ? process.env.LOVENSE_DEVELOPER_TOKEN.trim() : "";

    const commandResponse = await fetch('https://lovense.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        developerToken: devToken,
        token: targetToken,
        uid: wearer_uuid,
        command: "Vibrate",
        apiVer: 2,
        params: {
          vibrate: parseInt(strength),
          time: parseInt(duration) || 5
        }
      })
    });

    const commandData = await commandResponse.json();
    return res.json({ success: commandData.code === 200 });
  } catch (err) {
    console.error("Vibration execution error:", err);
    res.status(500).json({ error: "Failed to transmit vibe command." });
  }
});

// ==========================================
// API ROUTE: INTERACTION GATEWAY HANDSHAKE (LSL LINK)
// ==========================================
app.post('/api/hud/connect/:uuid', async (req, res) => {
  const wearer_uuid = req.params.uuid;
  const devToken = process.env.LOVENSE_DEVELOPER_TOKEN ? process.env.LOVENSE_DEVELOPER_TOKEN.trim() : "";

  try {
    const params = new URLSearchParams();
    params.append('token', devToken);
    params.append('uid', wearer_uuid);
    params.append('uname', 'SL_User');
    params.append('type', 'vcloud');
    params.append('v', '2');

    const response = await fetch('https://lovense-api.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    const rawText = await response.text();
    
    if (rawText.trim().startsWith("<")) {
      return res.status(400).send("Lovense Gateway returned HTML layout instead of raw parameters.");
    }

    const data = JSON.parse(rawText);
    if (data.result === true || data.code === 0 || data.code === 200) {
      const qrTarget = data.data ? data.data.qr : null;
      if (qrTarget) {
        // We directly pass the raw URL string back to the LSL engine to map it instantly
        return res.status(200).send(qrTarget);
      }
    }
    res.status(400).send("Gateway execution returned error data processing the token.");
  } catch (err) {
    console.error("Server Route Error:", err);
    res.status(500).send("Failed to retrieve a solid token allocation pathway.");
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Bridge initialization stable and completely responsive.");
});
