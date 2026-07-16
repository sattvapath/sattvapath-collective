# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Two-tier architecture

This repo ships two independently-deployed pieces:

1. **Static site** — the HTML/CSS/JS at the repo root, served by GitHub Pages at `sattvapathcollective.com` (see `CNAME`). No build step. Pushing to `main` deploys.
2. **Backend API** (`backend/`) — a Node 20 + Express + PostgreSQL service that runs on the production VPS at `/opt/sattva-api/`, managed by systemd (`sattva-api.service`). Nginx proxies `sattvapathcollective.com/api/*` → `127.0.0.1:3000`. Deploys are manual (copy `backend/` to the server, `npm install --omit=dev`, `systemctl restart sattva-api`). DB credentials live at `/etc/sattva/db.env` on the server, not in this repo.

Because the two tiers deploy separately, a change that spans both (e.g. a new endpoint + a page that calls it) is only fully live after **both** the site push and the backend deploy.

## No build, no tests, no linter

There is no npm/webpack/etc. build pipeline for the static site and no test suite anywhere. The `Makefile` and `scripts/setup-codex.ps1` are legacy Codex-CLI setup — ignore them for site/backend work. Verification is manual:

- Site: open the HTML files in a browser, or `python3 -m http.server` from the repo root.
- Backend locally: `cd backend && npm install && PGHOST=... PGDATABASE=sattva PGUSER=... PGPASSWORD=... node server.js` then `curl http://127.0.0.1:3000/api/health`.
- Schema changes: `psql sattva -f backend/schema.sql` — the file is written to be re-runnable (uses `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP TRIGGER IF EXISTS` before create).

## Frontend layout

Every public page is a standalone HTML file that loads `assets/styles.css` + `assets/main.js`. There is no router and no template system — shared markup (header nav, footer, social icons) is copy-pasted per page. When updating navigation or the footer, edit every `*.html` file at the repo root.

Two pages are exceptions and are self-contained (their own inline `<style>` and `<script>` — do **not** rely on `assets/main.js` running inside them):

- `admin.html` (~2000 lines) — the admin control panel.
- `register.html` (~2100 lines) — the featured Sattva Path Retreat registration form.

`event-register.html` is the generic form for other events; `payment-success.html` / `payment-cancel.html` are Stripe redirect targets.

### Content hydration pattern (`assets/main.js`)

Text and images on public pages are made editable via three DOM hooks:

- `data-content="key"` on any element — `applySiteContent()` fetches `/api/content` (a `{key: value}` map from the `site_content` table) and writes it into the element. Elements with class `body-copy` get their value split on blank lines and rendered as `<p>...</p>`; everything else is set via `textContent`. Never inject HTML through this path — the server also stores plain text (`schema.sql:66`).
- `data-image="key"` — same lookup, sets `img.src`.
- `data-featured-retreat="title|date|location|age|description|price|register-btn|closed-notice"` — hydrated from `/api/events/sattva-path-retreat-2026` so the retreat block on the homepage / retreat page reflects the current admin-edited event.

When you add a new editable text block, all you need to do is add `data-content="section.field"` in the HTML. The admin inline editor (`initInlineEdit`) attaches pencil overlays to every `[data-content]` element the moment `/api/admin/me` returns a signed-in user, so no admin-side wiring is required.

### Emotion board ("What's on Your Heart") ownership

Posts are owned by a per-browser UUID stored in `localStorage["sattva-client-id"]` (`assets/main.js:30`) and sent as an `X-Client-Id` header on POST/PATCH/DELETE. The server matches ownership on `client_id`. Do not switch to a server-issued token without migrating existing rows — anonymous posters would lose the ability to edit or delete their own past posts.

### Admin panel duality

`admin.html` writes through the API but **also** mirrors data into `localStorage` under `sattva-events`, `sattva-emotions`, `sattva-site-content`, etc. (see `refreshApiCaches()` around line 877). That mirror exists because legacy read paths in the file still expect the old localStorage shape. When adding a new admin feature, prefer going through the API directly rather than growing the legacy cache; only mirror if an existing renderer requires it.

## Backend layout (`backend/server.js`)

One file, roughly organized by resource:

- `admin_users` / `admin_sessions` — bcrypt password + opaque cookie token in `sattva_sid` (14-day TTL). `requireAdmin` middleware enforces auth on `/api/admin/*`.
- `events` — CRUD; only `Posted`/`Closed` visible publicly. Seed row for `sattva-path-retreat-2026` in `schema.sql`.
- `emotions` — public board with owner-scoped edit/delete via `X-Client-Id`, admin hide/response/delete.
- `registrations` — public POST creates `pending`; admin can flip `payment_status`. Stripe fills it in automatically for card payments.
- `contact_inquiries` — public POST + admin triage.
- `site_content` — free-form `key → value` used by the frontend hydration described above.

### Stripe integration — critical ordering

The webhook handler at `POST /api/stripe-webhook` **must** be registered before `app.use(express.json())` because signature verification needs the raw body. It has its own `express.raw({ type: 'application/json' })` parser (`server.js:26`). If you refactor the middleware stack, keep the webhook route first or Stripe events will start 400ing with "no signatures found matching the expected signature."

Payment flow: register → `POST /api/registrations` returns `id` → `POST /api/checkout-session` with that `id` returns a Stripe hosted-checkout URL → user pays → webhook (`checkout.session.completed`) flips `payment_status='paid'` → success page polls `GET /api/checkout-status?session_id=...`.

Stripe is **optional**: if `STRIPE_SECRET_KEY` is unset the server still boots but checkout endpoints return `503 stripe_not_configured`. Payment-method selection (card, US bank, etc.) is controlled entirely from the Stripe dashboard — do not pass `payment_method_types` or `automatic_payment_methods` to `checkout.sessions.create` (a prior fix, `4ef71a1`, removed an invalid version of the latter).

### Env vars

`PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PORT STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET SITE_BASE_URL` — all read directly from `process.env`. Server binds to `127.0.0.1` only; nginx is the public surface.

### Rate limiting

`rateLimit(key, maxPerMin)` is an in-memory `Map` per IP. Fine for a single-process deploy; if the backend is ever scaled horizontally this needs a shared store.

## Repository housekeeping

- `.agents/`, `.codex/`, `_bmad/`, `_bmad-output/`, `.uv-cache/`, `.uv-python/`, `scripts/setup-codex.ps1`, `codex.cmd`, `fix-codex-command.ps1`, `AGENTS.md`, `Makefile` — leftover Codex/BMAD tooling. Not part of the site or backend; leave alone unless the user asks.
- `extracted-email/` — reference material, not shipped.
- Do not commit unless the user explicitly asks (per `AGENTS.md`, still the working norm).
