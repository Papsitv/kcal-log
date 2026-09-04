const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
const DATA_FILE = path.join(__dirname, 'codes.json');
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-token-change-me';
const SMTP_HOST = process.env.SMTP_HOST || null;
const SMTP_PORT = process.env.SMTP_PORT || null;
const SMTP_USER = process.env.SMTP_USER || null;
const SMTP_PASS = process.env.SMTP_PASS || null;
// where to send buyer alerts — defaults to the seller email provided
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || 'lealdennis110@gmail.com';

app.use(cors());
app.use(bodyParser.json());

// Serve static files from the backend folder (admin.html, README, etc.)
app.use(express.static(path.join(__dirname)));

// Redirect root to admin UI for convenience
app.get('/', (req, res) => {
  res.redirect('/admin.html');
});

async function readCodes() {
  try {
    const txt = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(txt || '[]');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeCodes(list) {
  await fs.writeFile(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateCode() {
  // 16 bytes -> base64url ~22 chars
  return crypto.randomBytes(16).toString('base64url');
}

// Middleware to protect admin endpoints
function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || req.query.token;
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Generate a one-time code (admin only)
app.post('/api/generate', requireAdmin, async (req, res) => {
  const { buyerName, buyerPhone, amount, expiresInDays } = req.body || {};
  const { requestId } = req.body || {};
  const code = generateCode();
  const hash = hashCode(code);
  const now = Date.now();
  const expiresAt = now + ((expiresInDays || 7) * 24 * 60 * 60 * 1000);

  const entry = {
    id: uuidv4(),
    hash,
    buyerName: buyerName || null,
    buyerPhone: buyerPhone || null,
    amount: amount || null,
    createdAt: now,
    expiresAt,
    used: false,
    usedAt: null
  };

  const list = await readCodes();
  list.push(entry);
  // If this generate call is tied to a pending request, mark it fulfilled
  if (requestId) {
    const reqEntry = list.find(e => e.id === requestId && e.status === 'pending');
    if (reqEntry) {
      reqEntry.status = 'fulfilled';
      reqEntry.fulfilledAt = Date.now();
      reqEntry.generatedCodeId = entry.id;
    }
  }
  await writeCodes(list);

  // Return the plain code to admin (do NOT expose publicly)
  res.json({ code, id: entry.id, expiresAt });
});

// Buyer requests endpoint (creates a pending request and optionally emails seller)
app.post('/api/request', async (req, res) => {
  const { name, phone, ref, amount } = req.body || {};
  const list = await readCodes();
  // store as a pending request entry (not yet containing hash/code)
  const reqEntry = {
    id: uuidv4(),
    buyerName: name || null,
    buyerPhone: phone || null,
    amount: amount || null,
    transactionRef: ref || null,
    status: 'pending',
    createdAt: Date.now()
  };
  // store pending requests in codes file alongside codes (we'll append)
  list.push(reqEntry);
  await writeCodes(list);

  // send optional email alert to seller if SMTP configured
  if (SMTP_HOST && ALERT_EMAIL_TO) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({ host: SMTP_HOST, port: parseInt(SMTP_PORT||587,10), secure: false, auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined });
      const mailBody = `New purchase request:\nName: ${name}\nPhone: ${phone}\nAmount: ${amount}\nTransaction ref: ${ref}\nAdmin UI: http://localhost:${PORT}/admin.html`;
      await transporter.sendMail({ from: SMTP_USER || 'no-reply@example.com', to: ALERT_EMAIL_TO, subject: 'kcal-log purchase request', text: mailBody });
    } catch (e) {
      console.error('email send failed', e);
    }
  }

  res.json({ ok: true, id: reqEntry.id });
});

// Verify a code (called by buyer client)
app.post('/api/verify', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });
  const hash = hashCode(code);
  const list = await readCodes();
  const entry = list.find(e => e.hash === hash);
  if (!entry) return res.status(404).json({ error: 'invalid code' });
  if (entry.used) return res.status(400).json({ error: 'code already used' });
  if (Date.now() > entry.expiresAt) return res.status(400).json({ error: 'code expired' });

  // mark used
  entry.used = true;
  entry.usedAt = Date.now();
  await writeCodes(list);

  res.json({ ok: true, id: entry.id });
});

// Admin: list codes
app.get('/api/codes', requireAdmin, async (req, res) => {
  const list = await readCodes();
  res.json(list);
});

app.listen(PORT, () => {
  console.log(`kcal-log backend listening on http://localhost:${PORT}`);
  console.log(`Set ADMIN_TOKEN env to a secure value before using in production.`);
  console.log(`Email alerts will be sent to: ${ALERT_EMAIL_TO} (requires SMTP_HOST/USER/PASS if sending)`);
});
