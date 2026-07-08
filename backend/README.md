# Sattva Path API

Node/Express + PostgreSQL backend for the Sattva Path Collective site.

Runs on the production server at `/opt/sattva-api/` (deployed manually from this folder).
Systemd service: `sattva-api.service`.
Database: `sattva`, user `sattva_app`, credentials at `/etc/sattva/db.env` (root-only).
Nginx proxies `sattvapathcollective.com/api/*` to `127.0.0.1:3000`.

## Endpoints

Public:
- `GET  /api/events` — list posted+closed events (optional `?type=Retreat|Meditation|Kirtan/Bhajan`)
- `GET  /api/events/:id`
- `GET  /api/emotions` — list posted emotions (optional `?from=<iso>` cutoff)
- `POST /api/emotions` — new post (needs `X-Client-Id` header)
- `PATCH /api/emotions/:id` — edit own post (matched by `X-Client-Id`)
- `DELETE /api/emotions/:id` — delete own post
- `POST /api/emotions/:id/reply` — community reply

Admin (require `sattva_sid` cookie):
- `POST /api/admin/login`  `{ username, password }`
- `POST /api/admin/logout`
- `GET  /api/admin/me`
- `GET/POST/PATCH/DELETE /api/admin/events[...]`
- `POST /api/admin/emotions/:id/hide` — toggle hide
- `POST /api/admin/emotions/:id/response` — set host response
- `DELETE /api/admin/emotions/:id` — admin delete
