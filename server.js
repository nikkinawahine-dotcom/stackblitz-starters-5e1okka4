require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Initialize connection to your Neon cloud database using your hidden .env string
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test page to confirm both the web server and database connection work
app.get('/', async (req, res) => {
  try {
    // Quickly check the time on your cloud database to prove it can communicate
    const dbTest = await db.query('SELECT NOW()');
    res.send(`Your Bridge Server is online and successfully connected to Neon Database! Time: ${dbTest.rows[0].now}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server is up, but failed to connect to the database. Check your .env file!");
  }
});

// ==========================================
// API ROUTE: HUD REQUESTS A PAIRING SESSION
// ==========================================
app.post('/api/hud/register', async (req, res) => {
  const { sl_uuid, sl_http_url } = req.body;

  // Make sure Second Life actually sent us the required avatar information
  if (!sl_uuid || !sl_http_url) {
    return res.status(400).json({ error: "Missing avatar UUID or HTTP URL data." });
  }

  try {
    // Save or update the user session in your Neon database, setting it to 'pending'
    await db.query(
      `INSERT INTO active_sessions (sl_uuid, sl_http_url, status) 
       VALUES ($1, $2, 'pending') 
       ON CONFLICT (sl_uuid) DO UPDATE SET sl_http_url = $2, status = 'pending'`,
      [sl_uuid, sl_http_url]
    );

    // Send a success confirmation back to the Second Life HUD
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
  // 'uid' will match the sl_uuid we send Lovense later!

  try {
    // 1. Fetch their saved Second Life HUD URL from your Neon database
    const userCheck = await db.query('SELECT sl_http_url FROM active_sessions WHERE sl_uuid = \$1', [uid]);
    
    if (userCheck.rows.length === 0) {
      return res.status(404).send("User session not found in database.");
    }
    
    const sl_url = userCheck.rows[0].sl_http_url;

    // 2. Update their database record with their active Lovense token and toy data
    await db.query(
      `UPDATE active_sessions 
       SET lovense_token = $1, status = 'connected', toys = $2 
       WHERE sl_uuid = $3`,
      [token, JSON.stringify(toys), uid]
    );

    // 3. Fire an HTTP request straight into Second Life to tell the HUD they are linked!
    await fetch(sl_url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: "CONNECTED|Successfully linked your Lovense toy!"
    });

    // Lovense requires your server to send back a 200 OK status to confirm receipt
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
  const { wearer_uuid, strength, duration } = req.body; // strength: 0-20, duration in seconds

  if (!wearer_uuid || strength === undefined) {
    return res.status(400).json({ error: "Missing wearer_uuid or strength level." });
  }

  try {
    // 1. Look up the wearer's secret Lovense session token from your Neon database
    const userCheck = await db.query(
      "SELECT lovense_token FROM active_sessions WHERE sl_uuid = \$1 AND status = 'connected'", 
      [wearer_uuid]
    );
    
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "Toy is not connected or session expired." });
    }

    const targetToken = userCheck.rows[0].lovense_token;

    // 2. Forward the command securely to the Lovense Cloud API using your hidden developer token
    const commandResponse = await fetch('https://lovense.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: process.env.LOVENSE_DEVELOPER_TOKEN, // Will be stored safely on Render
        uid: wearer_uuid,
        vibrate: parseInt(strength),
        time: parseInt(duration) || 5
      })
    });

    const commandData = await commandResponse.json();
    return res.json({ success: commandData.code === 200 });
  } catch (err) {
    console.error("Vibration execution error:", err);
    res.status(500).json({ error: "Failed to transmit vibe command." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Database-connected server is listening on port ${PORT}`);
});
