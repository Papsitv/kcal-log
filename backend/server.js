const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'codes.json');
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 32) {
  throw new Error('ADMIN_TOKEN must be set to a random value of at least 32 characters.');
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

const SMTP_HOST = process.env.SMTP_HOST || null;
const SMTP_PORT = process.env.SMTP_PORT || '587';
const SMTP_USER = process.env.SMTP_USER || null;
const SMTP_PASS = process.env.SMTP_PASS || null;
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || null;

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  );
  next();
});

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-admin-token'],
  maxAge: 600
}));

app.use(express.json({ limit: '10kb' }));

const rateBuckets = new Map();
function rateLimit({ windowMs, max, message }) {
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({ error: message });
    }
    next();
  };
}

setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.start < cutoff) rateBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

async function readCodes() {
  try {
    const txt = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(txt || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeCodes(list) {
  await fs.writeFile(DATA_FILE, JSON.stringify(list, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateCode() {
  return crypto.randomBytes(16).toString('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token');
  if (!token || !safeEqual(token, ADMIN_TOKEN)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function cleanDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) return 7;
  return Math.min(30, Math.max(1, Math.floor(days)));
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/generate',
  rateLimit({ windowMs: 60 * 1000, max: 30, message: 'Too many admin requests.' }),
  requireAdmin,
  async (req, res, next) => {
    try {
      const { requestId } = req.body || {};
      const code = generateCode();
      const hash = hashCode(code);
      const now = Date.now();
      const expiresAt = now + cleanDays(req.body?.expiresInDays) * 24 * 60 * 60 * 1000;

      const entry = {
        id: uuidv4(),
        hash,
        buyerName: cleanText(req.body?.buyerName, 120),
        buyerPhone: cleanText(req.body?.buyerPhone, 40),
        amount: cleanText(req.body?.amount, 40),
        createdAt: now,
        expiresAt,
        used: false,
        usedAt: null
      };

      const list = await readCodes();
      list.push(entry);

      if (requestId) {
        const reqEntry = list.find(e => e.id === requestId && e.status === 'pending');
        if (reqEntry) {
          reqEntry.status = 'fulfilled';
          reqEntry.fulfilledAt = Date.now();
          reqEntry.generatedCodeId = entry.id;
        }
      }

      await writeCodes(list);
      res.json({ code, id: entry.id, expiresAt });
    } catch (err) {
      next(err);
    }
  }
);

app.post('/api/request',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many purchase requests. Try again later.' }),
  async (req, res, next) => {
    try {
      const name = cleanText(req.body?.name, 120);
      const phone = cleanText(req.body?.phone, 40);
      const ref = cleanText(req.body?.ref, 120);
      const amount = cleanText(req.body?.amount, 40);

      if (!name || !ref) {
        return res.status(400).json({ error: 'name and transaction reference are required' });
      }

      const list = await readCodes();
      const reqEntry = {
        id: uuidv4(),
        buyerName: name,
        buyerPhone: phone,
        amount,
        transactionRef: ref,
        status: 'pending',
        createdAt: Date.now()
      };
      list.push(reqEntry);
      await writeCodes(list);

      if (SMTP_HOST && SMTP_USER && SMTP_PASS && ALERT_EMAIL_TO) {
        try {
          const nodemailer = require('nodemailer');
          const transporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: Number(SMTP_PORT) || 587,
            secure: Number(SMTP_PORT) === 465,
            auth: { user: SMTP_USER, pass: SMTP_PASS }
          });
          const mailBody =
            `New purchase request:\nName: ${name}\nPhone: ${phone || '(not provided)'}\nAmount: ${amount || '(not provided)'}\nTransaction ref: ${ref}\n`;
          await transporter.sendMail({
            from: SMTP_USER,
            to: ALERT_EMAIL_TO,
            subject: 'kcal-log purchase request',
            text: mailBody
          });
        } catch (err) {
          console.error('email send failed:', err.message);
        }
      }

      res.json({ ok: true, id: reqEntry.id });
    } catch (err) {
      next(err);
    }
  }
);

app.post('/api/verify',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 30, message: 'Too many verification attempts. Try again later.' }),
  async (req, res, next) => {
    try {
      const code = cleanText(req.body?.code, 128);
      if (!code) return res.status(400).json({ error: 'code required' });

      const hash = hashCode(code);
      const list = await readCodes();
      const entry = list.find(e => e.hash === hash);

      if (!entry) return res.status(404).json({ error: 'invalid code' });
      if (entry.used) return res.status(400).json({ error: 'code already used' });
      if (!entry.expiresAt || Date.now() > entry.expiresAt) {
        return res.status(400).json({ error: 'code expired' });
      }

      entry.used = true;
      entry.usedAt = Date.now();
      await writeCodes(list);

      res.json({ ok: true, id: entry.id });
    } catch (err) {
      next(err);
    }
  }
);

app.get('/api/codes',
  rateLimit({ windowMs: 60 * 1000, max: 30, message: 'Too many admin requests.' }),
  requireAdmin,
  async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await readCodes());
    } catch (err) {
      next(err);
    }
  }
);

app.use((err, req, res, next) => {
  console.error('request error:', err.message);
  if (err.message === 'Origin not allowed by CORS') {
    return res.status(403).json({ error: 'origin not allowed' });
  }
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`kcal-log backend listening on port ${PORT}`);
  console.log('ADMIN_TOKEN is configured from the environment.');
  console.log(`CORS allowlist entries: ${allowedOrigins.length}`);
});
