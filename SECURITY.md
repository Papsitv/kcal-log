# Security Policy

## Supported Version

The latest version on the `main` branch is the supported version.

## Reporting a Vulnerability

Please do not publish credentials, personal data, or exploit details in a public issue.

Report suspected vulnerabilities privately to the repository owner through GitHub's private security reporting feature, when available.

If a secret is exposed, rotate or revoke it immediately and then report the incident.

## Secrets and Personal Data

Never commit:
- API keys or access tokens
- SMTP credentials
- payment-provider credentials
- `.env` files
- customer or buyer records
- generated unlock-code databases
- private keys or certificates

Local unlock-code data belongs in `backend/codes.json`, which is intentionally ignored by Git.
