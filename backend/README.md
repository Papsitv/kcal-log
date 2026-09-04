kcal-log backend
================

This is a minimal Node/Express backend to generate and verify one-time unlock codes for the `kcal-log` static front-end.

Setup
-----

1. Install dependencies:

```bash
cd backend
npm install
```

2. Set a secure admin token (used to protect code generation and listing):

```bash
export ADMIN_TOKEN="a-strong-secret"
# On Windows (PowerShell)
$env:ADMIN_TOKEN = 'a-strong-secret'
```

3. Start the server:

```bash
npm start
```

By default the server listens on port `3000`.

Email alerts
------------

This backend can send an email alert to notify the seller when a buyer submits a purchase request.

- Required environment variables to actually send email via SMTP:

```bash
export SMTP_HOST=smtp.example.com
export SMTP_PORT=587
export SMTP_USER=you@example.com
export SMTP_PASS=yourpassword
export ALERT_EMAIL_TO=lealdennis110@gmail.com
# On Windows (PowerShell)
$env:SMTP_HOST = 'smtp.example.com'
$env:SMTP_PORT = '587'
$env:SMTP_USER = 'you@example.com'
$env:SMTP_PASS = 'yourpassword'
$env:ALERT_EMAIL_TO = 'lealdennis110@gmail.com'
```

If `ALERT_EMAIL_TO` is not set, the backend defaults to `lealdennis110@gmail.com`.

When SMTP variables are set and the server is running, POSTing to `/api/request` will store the pending request and attempt to email the seller with buyer details and a link to the admin UI.

API
---

- POST `/api/generate` (admin only)
  - Headers: `x-admin-token: <ADMIN_TOKEN>`
  - Body JSON: `{ "buyerName": "...", "buyerPhone": "...", "amount": "...", "expiresInDays": 7 }`
  - Response: `{ "code": "<plain-code>", "id": "...", "expiresAt": 12345 }`

- Admin UI: open `backend/admin.html` in a browser while the backend is running. The page lets you paste your `ADMIN_TOKEN`, generate codes, and list existing codes.

- POST `/api/verify` (public)
  - Body JSON: `{ "code": "..." }`
  - Response: `{ "ok": true, "id": "..." }` or 4xx error with `{ error: '...' }`

- GET `/api/codes` (admin only)
  - Lists stored code entries (hashed). Use to audit codes.

Storage
-------

Codes are stored in `codes.json` in the backend folder as a JSON array. Codes are stored as SHA-256 hashes — the plain code is only returned once from the `/api/generate` endpoint.

Security notes
--------------
- Use a strong `ADMIN_TOKEN` in production and run the backend on a private/secure host.
- This scaffold is intentionally small. For production use, consider adding TLS, authentication, rate-limiting, logging, and moving storage to a database.
