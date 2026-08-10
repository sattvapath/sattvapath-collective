// Sattva Path Collective API
// Node 20 + Express + node-postgres + bcrypt. Single file for simplicity.
// Env: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PORT (default 3000)

const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.PORT || 3000);
const pool = new Pool();

// Stripe is optional — if STRIPE_SECRET_KEY is not set, checkout endpoints
// return a clear error but the server still runs.
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET ? require('stripe')(STRIPE_SECRET) : null;
const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://sattvapathcollective.com';

// SMTP for outbound email. Server boots without it; endpoints that need it
// still save data and return success, but flag email_status='failed'.
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `Sattva Path Collective <${SMTP_USER}>` : '');
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || SMTP_USER;
const mailer = (SMTP_USER && SMTP_PASS) ? nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
}) : null;
if (!mailer) console.warn('SMTP not configured (SMTP_USER/SMTP_PASS unset) — outbound email disabled.');

const app = express();
app.set('trust proxy', 'loopback');

// The Stripe webhook needs the raw body to verify the signature, so mount
// it BEFORE the JSON parser and give it its own raw parser.
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'stripe_not_configured' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature check failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      const regId = session.metadata?.registration_id;
      if (regId) {
        await pool.query(
          `UPDATE registrations SET
              payment_status    = 'paid',
              payment_method    = 'stripe',
              stripe_session_id = $2,
              stripe_payment_id = $3,
              stripe_paid_at    = NOW()
            WHERE id = $1`,
          [regId, session.id, session.payment_intent || '']
        );
      }
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const session = event.data.object;
      const regId = session.metadata?.registration_id;
      if (regId) {
        await pool.query(
          `UPDATE registrations SET
              stripe_session_id = COALESCE(NULLIF(stripe_session_id, ''), $2)
            WHERE id = $1 AND payment_status = 'pending'`,
          [regId, session.id]
        );
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook handler error:', err);
    res.status(500).send('handler_error');
  }
});

app.use(express.json({ limit: '128kb' }));
app.use(cookieParser());

// ---------------- helpers ----------------

const SESSION_COOKIE = 'sattva_sid';
const SESSION_TTL_HOURS = 24 * 14;

function randomToken(n = 32) {
  return crypto.randomBytes(n).toString('base64url');
}

async function getAdminBySession(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const r = await pool.query(
    `SELECT a.id, a.username, a.role, s.expires_at
       FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id
      WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token]
  );
  if (!r.rows[0]) return null;
  pool.query(`UPDATE admin_sessions SET last_seen = NOW() WHERE token = $1`, [token]).catch(() => {});
  return r.rows[0];
}

function requireAdmin(req, res, next) {
  getAdminBySession(req).then((admin) => {
    if (!admin) return res.status(401).json({ error: 'not_authenticated' });
    req.admin = admin;
    next();
  }).catch((err) => {
    console.error('auth error', err);
    res.status(500).json({ error: 'server_error' });
  });
}

// naive in-memory rate limit for public POSTs
const rate = new Map(); // key -> [{ ts }]
function rateLimit(key, maxPerMin) {
  const now = Date.now();
  const arr = (rate.get(key) || []).filter((x) => now - x < 60_000);
  if (arr.length >= maxPerMin) return false;
  arr.push(now);
  rate.set(key, arr);
  return true;
}

// ---------------- health ----------------

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// ---------------- events (public) ----------------

app.get('/api/events', async (req, res) => {
  const type = req.query.type;
  const params = [];
  let where = `status IN ('Posted','Closed')`;
  if (type) { params.push(type); where += ` AND type = $${params.length}`; }
  const r = await pool.query(
    `SELECT id, type, status, title, date, location, price, age, description, fields
       FROM events
      WHERE ${where}
      ORDER BY (status='Posted') DESC, updated_at DESC`,
    params
  );
  res.json(r.rows);
});

app.get('/api/events/:id', async (req, res) => {
  const r = await pool.query(
    `SELECT id, type, status, title, date, location, price, age, description, fields
       FROM events WHERE id = $1 AND status IN ('Posted','Closed')`,
    [req.params.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

// ---------------- events (admin) ----------------

app.get('/api/admin/events', requireAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT id, type, status, title, date, location, price, age, description, fields,
            event_datetime, zoom_link, email_extra,
            created_at, updated_at
       FROM events
      ORDER BY updated_at DESC`
  );
  res.json(r.rows);
});

app.post('/api/admin/events', requireAdmin, async (req, res) => {
  const e = req.body || {};
  if (!e.id || !e.type || !e.status || !e.title || !e.date || !e.location || !e.description) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const r = await pool.query(
    `INSERT INTO events
       (id, type, status, title, date, location, price, age, description, fields,
        event_datetime, zoom_link, email_extra)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
     RETURNING *`,
    [e.id, e.type, e.status, e.title, e.date, e.location, e.price || '', e.age || '',
     e.description, JSON.stringify(e.fields || []),
     e.event_datetime || null, e.zoom_link || '', e.email_extra || '']
  );
  res.status(201).json(r.rows[0]);
});

app.patch('/api/admin/events/:id', requireAdmin, async (req, res) => {
  const e = req.body || {};
  // event_datetime uses a special sentinel: undefined = don't touch,
  // null = clear it, string = set it. zoom_link/email_extra use plain
  // COALESCE (undefined => don't touch; empty string overwrites).
  const r = await pool.query(
    `UPDATE events SET
        type           = COALESCE($2, type),
        status         = COALESCE($3, status),
        title          = COALESCE($4, title),
        date           = COALESCE($5, date),
        location       = COALESCE($6, location),
        price          = COALESCE($7, price),
        age            = COALESCE($8, age),
        description    = COALESCE($9, description),
        fields         = COALESCE($10::jsonb, fields),
        event_datetime = CASE WHEN $11::text = '__unchanged__' THEN event_datetime
                              WHEN $11::text = '__clear__'     THEN NULL
                              ELSE $11::timestamptz END,
        zoom_link      = COALESCE($12, zoom_link),
        email_extra    = COALESCE($13, email_extra)
      WHERE id = $1
      RETURNING *`,
    [req.params.id, e.type, e.status, e.title, e.date, e.location, e.price, e.age,
     e.description, e.fields ? JSON.stringify(e.fields) : null,
     e.event_datetime === undefined ? '__unchanged__'
       : (e.event_datetime === null || e.event_datetime === '') ? '__clear__'
       : e.event_datetime,
     e.zoom_link, e.email_extra]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

app.delete('/api/admin/events/:id', requireAdmin, async (req, res) => {
  const r = await pool.query(`DELETE FROM events WHERE id = $1`, [req.params.id]);
  res.json({ deleted: r.rowCount });
});

// ---------------- emotions (public) ----------------

app.get('/api/emotions', async (req, res) => {
  const from = req.query.from; // ISO date string; if set, only >= from
  const params = [];
  let where = `status != 'Hidden'`;
  if (from) { params.push(from); where += ` AND created_at >= $${params.length}`; }
  const r = await pool.query(
    `SELECT id, client_id, status, name, word, message,
            host_response_preference, community_response_preference,
            public_response, community_replies, created_at
       FROM emotions WHERE ${where} ORDER BY created_at DESC`,
    params
  );
  // Never leak email publicly
  res.json(r.rows);
});

app.post('/api/emotions', async (req, res) => {
  const clientId = String(req.get('X-Client-Id') || '').slice(0, 128);
  if (!clientId) return res.status(400).json({ error: 'client_id_required' });
  const ip = req.ip || 'unknown';
  if (!rateLimit(`post:${ip}`, 5)) return res.status(429).json({ error: 'rate_limited' });
  const e = req.body || {};
  if (!e.word || !e.host_response_preference || !e.community_response_preference) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const r = await pool.query(
    `INSERT INTO emotions (
        client_id, name, word, message,
        host_response_preference, community_response_preference, email)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [clientId, e.name || '', e.word, e.message || '',
     e.host_response_preference, e.community_response_preference, e.email || '']
  );
  res.status(201).json(r.rows[0]);
});

app.patch('/api/emotions/:id', async (req, res) => {
  const clientId = String(req.get('X-Client-Id') || '');
  if (!clientId) return res.status(401).json({ error: 'client_id_required' });
  const e = req.body || {};
  const r = await pool.query(
    `UPDATE emotions SET
        name    = COALESCE($3, name),
        word    = COALESCE($4, word),
        message = COALESCE($5, message),
        host_response_preference      = COALESCE($6, host_response_preference),
        community_response_preference = COALESCE($7, community_response_preference),
        email   = COALESCE($8, email)
      WHERE id = $1 AND client_id = $2
      RETURNING *`,
    [req.params.id, clientId, e.name, e.word, e.message,
     e.host_response_preference, e.community_response_preference, e.email]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_not_owner' });
  res.json(r.rows[0]);
});

app.delete('/api/emotions/:id', async (req, res) => {
  const clientId = String(req.get('X-Client-Id') || '');
  if (!clientId) return res.status(401).json({ error: 'client_id_required' });
  const r = await pool.query(
    `DELETE FROM emotions WHERE id = $1 AND client_id = $2`,
    [req.params.id, clientId]
  );
  res.json({ deleted: r.rowCount });
});

app.post('/api/emotions/:id/reply', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!rateLimit(`reply:${ip}`, 10)) return res.status(429).json({ error: 'rate_limited' });
  const { name, message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message_required' });
  const reply = { id: crypto.randomUUID(), createdAt: new Date().toISOString(),
                  name: (name || '').slice(0, 120), message: String(message).slice(0, 2000) };
  const r = await pool.query(
    `UPDATE emotions
        SET community_replies = community_replies || $2::jsonb
      WHERE id = $1
        AND status != 'Hidden'
        AND community_response_preference = 'Community may respond'
      RETURNING community_replies`,
    [req.params.id, JSON.stringify(reply)]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found_or_closed' });
  res.json({ reply });
});

// ---------------- emotions (admin) ----------------

app.post('/api/admin/emotions/:id/hide', requireAdmin, async (req, res) => {
  const r = await pool.query(
    `UPDATE emotions SET status = CASE WHEN status='Hidden' THEN 'Posted' ELSE 'Hidden' END
      WHERE id = $1 RETURNING id, status`,
    [req.params.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

app.post('/api/admin/emotions/:id/response', requireAdmin, async (req, res) => {
  const response = String((req.body?.response ?? '')).slice(0, 4000);
  const r = await pool.query(
    `UPDATE emotions SET public_response = $2 WHERE id = $1 RETURNING id, public_response`,
    [req.params.id, response]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

app.delete('/api/admin/emotions/:id', requireAdmin, async (req, res) => {
  const r = await pool.query(`DELETE FROM emotions WHERE id = $1`, [req.params.id]);
  res.json({ deleted: r.rowCount });
});

// ---------------- contact inquiries (public post) ----------------

app.post('/api/contact', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!rateLimit(`contact:${ip}`, 3)) return res.status(429).json({ error: 'rate_limited' });
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 200);
  const email = String(b.email || '').trim().slice(0, 200);
  const subject = String(b.subject || '').trim().slice(0, 200);
  const message = String(b.message || '').trim().slice(0, 8000);
  const sourcePage = String(b.source_page || 'contact').trim().slice(0, 60);
  if (!name || !email || !message) return res.status(400).json({ error: 'missing_fields' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });
  const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
  const r = await pool.query(
    `INSERT INTO contact_inquiries (name, email, subject, message, source_page, ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
    [name, email, subject, message, sourcePage, ipHash]
  );
  res.status(201).json({ id: r.rows[0].id, created_at: r.rows[0].created_at });
});

// ---------------- contact inquiries (admin) ----------------

app.get('/api/admin/inquiries', requireAdmin, async (req, res) => {
  const params = [];
  const conditions = [];
  if (req.query.status) { params.push(req.query.status); conditions.push(`status = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const r = await pool.query(
    `SELECT * FROM contact_inquiries ${where} ORDER BY created_at DESC`,
    params
  );
  res.json(r.rows);
});

app.get('/api/admin/inquiries.csv', requireAdmin, async (req, res) => {
  const r = await pool.query(`SELECT * FROM contact_inquiries ORDER BY created_at DESC`);
  const cols = ['id','created_at','status','name','email','subject','message','source_page','admin_notes'];
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [cols.join(',')];
  for (const row of r.rows) lines.push(cols.map((c) => esc(row[c])).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="inquiries-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(lines.join('\n'));
});

app.patch('/api/admin/inquiries/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const r = await pool.query(
    `UPDATE contact_inquiries SET
        status      = COALESCE($2, status),
        admin_notes = COALESCE($3, admin_notes)
      WHERE id = $1 RETURNING *`,
    [req.params.id, b.status, b.admin_notes]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

app.delete('/api/admin/inquiries/:id', requireAdmin, async (req, res) => {
  const r = await pool.query(`DELETE FROM contact_inquiries WHERE id = $1`, [req.params.id]);
  res.json({ deleted: r.rowCount });
});

// ---------------- reviews (public) ----------------

app.get('/api/reviews', async (req, res) => {
  const r = await pool.query(
    `SELECT id, name, rating, experience, body, location, created_at
       FROM reviews WHERE status = 'approved' ORDER BY created_at DESC LIMIT 200`
  );
  res.json(r.rows);
});

app.post('/api/reviews', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!rateLimit(`reviews:${ip}`, 3)) return res.status(429).json({ error: 'rate_limited' });
  const b = req.body || {};
  // Honeypot: bots fill this hidden field; silently accept but never save.
  if (b.website && String(b.website).trim() !== '') return res.status(201).json({ id: 'accepted' });
  const name = String(b.name || '').trim().slice(0, 100);
  const email = String(b.email || '').trim().slice(0, 200);
  const rating = Number(b.rating);
  const experience = String(b.experience || '').trim().slice(0, 100);
  const body = String(b.body || '').trim().slice(0, 4000);
  const location = String(b.location || '').trim().slice(0, 100);
  if (!name || !body) return res.status(400).json({ error: 'missing_fields' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'invalid_rating' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });
  const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
  const r = await pool.query(
    `INSERT INTO reviews (name, email, rating, experience, body, location, ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [name, email, rating, experience, body, location, ipHash]
  );
  res.status(201).json({ id: r.rows[0].id, created_at: r.rows[0].created_at });
});

// ---------------- reviews (admin) ----------------

app.get('/api/admin/reviews', requireAdmin, async (req, res) => {
  const params = [];
  const conditions = [];
  if (req.query.status) { params.push(req.query.status); conditions.push(`status = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const r = await pool.query(`SELECT * FROM reviews ${where} ORDER BY created_at DESC`, params);
  res.json(r.rows);
});

app.patch('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const r = await pool.query(
    `UPDATE reviews SET
        status      = COALESCE($2, status),
        admin_notes = COALESCE($3, admin_notes)
      WHERE id = $1 RETURNING *`,
    [req.params.id, b.status, b.admin_notes]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  const r = await pool.query(`DELETE FROM reviews WHERE id = $1`, [req.params.id]);
  res.json({ deleted: r.rowCount });
});

// ---------------- webinar registrations (public post) ----------------

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Human-readable "Thursday, August 13, 2026 at 6:30 PM PDT" from any ISO/Date.
function formatEventWhen(dt) {
  if (!dt) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: 'America/Los_Angeles', timeZoneName: 'short'
    }).format(new Date(dt)).replace(/,\s(\d+:\d+\s[AP]M)/, ' at $1');
  } catch { return String(dt); }
}

// Event-driven confirmation email — replaces the old hardcoded webinar body
// (item 7b, Stage B). Reads title, date, zoom_link, location, email_extra
// from the event row. isOnline = has a link (Zoom or Teams URL).
function eventConfirmationEmail(event, { name, email, phone }) {
  const safeName  = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safePhone = phone ? escapeHtml(phone) : '(not provided)';
  const isOnline  = !!(event && event.zoom_link && event.zoom_link.trim());
  const title     = (event && event.title) || 'the session';
  const when      = (event && event.event_datetime) ? formatEventWhen(event.event_datetime) : (event && event.date) || '';
  const where     = (event && event.location) || '';
  const link      = (event && event.zoom_link || '').trim();
  const extra     = (event && event.email_extra || '').trim();

  const joinRowHtml = isOnline
    ? `<li>Join link: <a href="${link}">${escapeHtml(link)}</a></li>`
    : (where ? `<li>Location: ${escapeHtml(where)}</li>` : '');
  const joinRowText = isOnline
    ? `  Link:  ${link}`
    : (where ? `  Where: ${where}` : '');
  const extraHtml = extra ? `<p>${escapeHtml(extra).replace(/\n/g, '<br>')}</p>` : '';
  const extraText = extra ? `\n${extra}\n` : '';

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif; color:#253027; line-height:1.55; font-size:15px;">
  <p>Hi ${safeName},</p>
  <p>Thank you for registering for <strong>${escapeHtml(title)}</strong>!</p>
  <p><strong>Your registration details:</strong></p>
  <ul>
    <li>Name: ${safeName}</li>
    <li>Email: <a href="mailto:${safeEmail}">${safeEmail}</a></li>
    <li>Phone: ${safePhone}</li>
  </ul>
  <p><strong>Event details:</strong></p>
  <ul>
    ${when ? `<li>When: ${escapeHtml(when)}</li>` : ''}
    <li>Host: Nirupama Gupta</li>
    ${joinRowHtml}
  </ul>
  ${extraHtml}
  <p>${isOnline ? 'Save this link' : 'See you'} &mdash; we&rsquo;ll also send a reminder before the session. See you there!</p>
  <p style="color:#5f6d61; font-size:13px; margin-top:24px;">&mdash; Sattva Path Collective</p>
</div>`.trim();

  const text = [
    `Hi ${name},`,
    ``,
    `Thank you for registering for ${title}!`,
    ``,
    `Your registration details:`,
    `  Name:  ${name}`,
    `  Email: ${email}`,
    `  Phone: ${phone || '(not provided)'}`,
    ``,
    `Event details:`,
    when ? `  When:  ${when}` : null,
    `  Host:  Nirupama Gupta`,
    joinRowText || null,
    extraText,
    isOnline ? "Save this link — we'll also send a reminder before the session. See you there!"
             : "See you there — we'll also send a reminder before the session.",
    ``,
    `— Sattva Path Collective`
  ].filter((v) => v !== null && v !== undefined).join('\n');

  return {
    subject: `You're registered — ${title}`,
    html, text
  };
}

function webinarNotificationEmail({ name, email, phone, message, id, created_at }) {
  const rows = [
    ['Name', name],
    ['Email', email],
    ['Phone', phone || '(none)'],
    ['Message', message || '(none)'],
    ['Registered', new Date(created_at).toISOString()],
    ['ID', id]
  ];
  const html = `
<div style="font-family:Arial,Helvetica,sans-serif; color:#253027; font-size:14px;">
  <p><strong>New webinar registration</strong></p>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse; border:1px solid #ddd;">
    ${rows.map(([k, v]) => `<tr><td style="border:1px solid #ddd; background:#f7f5ef;"><strong>${escapeHtml(k)}</strong></td><td style="border:1px solid #ddd;">${escapeHtml(v)}</td></tr>`).join('')}
  </table>
</div>`.trim();
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  return { subject: `New webinar registration: ${name}`, html, text };
}

async function sendWebinarEmails(event, reg) {
  if (!mailer) throw new Error('smtp_not_configured');
  const conf = eventConfirmationEmail(event, reg);
  const notif = webinarNotificationEmail(reg);
  await mailer.sendMail({
    from: SMTP_FROM,
    to: reg.email,
    subject: conf.subject,
    html: conf.html,
    text: conf.text,
    replyTo: NOTIFY_EMAIL || SMTP_USER
  });
  if (NOTIFY_EMAIL) {
    await mailer.sendMail({
      from: SMTP_FROM,
      to: NOTIFY_EMAIL,
      subject: (event && event.title) ? `New registration for ${event.title}: ${reg.name}` : notif.subject,
      html: notif.html,
      text: notif.text,
      replyTo: reg.email
    });
  }
}

app.post('/api/webinar-register', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!rateLimit(`webinar:${ip}`, 5)) return res.status(429).json({ error: 'rate_limited' });
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 200);
  const email = String(b.email || '').trim().slice(0, 200);
  const phone = String(b.phone || '').trim().slice(0, 60);
  const message = String(b.message || '').trim().slice(0, 4000);
  const eventSlug = String(b.event_slug || 'free-webinar').trim().slice(0, 80);
  if (!name || !email) return res.status(400).json({ error: 'missing_fields' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });

  // Look up the event so the confirmation email + admin notification can
  // reflect the specific session (title, datetime, zoom_link). If the slug
  // doesn't match a row (e.g. legacy 'free-webinar' shorthand), we still
  // save the registration and fall back to a generic email body.
  const eventQ = await pool.query(
    `SELECT id, type, title, date, location, zoom_link, email_extra, event_datetime
       FROM events WHERE id = $1`,
    [eventSlug]
  );
  const event = eventQ.rows[0] || null;

  const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
  const insert = await pool.query(
    `INSERT INTO webinar_registrations (event_slug, name, email, phone, message, ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
    [eventSlug, name, email, phone, message, ipHash]
  );
  const reg = { id: insert.rows[0].id, created_at: insert.rows[0].created_at, name, email, phone, message };
  try {
    await sendWebinarEmails(event, reg);
    await pool.query(`UPDATE webinar_registrations SET email_status='sent' WHERE id=$1`, [reg.id]);
    res.status(201).json({ id: reg.id, email_status: 'sent' });
  } catch (err) {
    console.error('Webinar email send failed:', err.message);
    await pool.query(
      `UPDATE webinar_registrations SET email_status='failed', email_error=$2 WHERE id=$1`,
      [reg.id, String(err.message || err).slice(0, 500)]
    );
    // Still 201 — the seat IS reserved. Client shows thank-you either way.
    res.status(201).json({ id: reg.id, email_status: 'failed' });
  }
});

// ---------------- webinar registrations (admin) ----------------

app.get('/api/admin/webinar-registrations', requireAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT id, event_slug, name, email, phone, message, email_status, email_error, created_at
       FROM webinar_registrations
      ORDER BY created_at DESC`
  );
  res.json(r.rows);
});

// ---------------- site content (public read) ----------------

app.get('/api/content', async (req, res) => {
  const r = await pool.query(`SELECT key, value FROM site_content`);
  const map = {};
  for (const row of r.rows) map[row.key] = row.value;
  res.json(map);
});

// ---------------- site content (admin write) ----------------

app.patch('/api/admin/content', requireAdmin, async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || typeof key !== 'string' || key.length > 200) return res.status(400).json({ error: 'invalid_key' });
  if (typeof value !== 'string') return res.status(400).json({ error: 'invalid_value' });
  if (value.length > 20000) return res.status(400).json({ error: 'value_too_long' });
  const r = await pool.query(
    `INSERT INTO site_content (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
     RETURNING key, value, updated_at`,
    [key, value]
  );
  res.json(r.rows[0]);
});

app.post('/api/admin/content/bulk-import', requireAdmin, async (req, res) => {
  const map = req.body?.content;
  if (!map || typeof map !== 'object') return res.status(400).json({ error: 'invalid_body' });
  const entries = Object.entries(map).filter(([k, v]) => typeof k === 'string' && typeof v === 'string');
  if (!entries.length) return res.json({ imported: 0 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of entries) {
      if (key.length > 200 || value.length > 20000) continue;
      await client.query(
        `INSERT INTO site_content (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value]
      );
    }
    await client.query('COMMIT');
    res.json({ imported: entries.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

// ---------------- registrations (public) ----------------

// Max occupancy per room, keyed by the room LABEL the register form
// stores in accommodation_details.rooms[].room (e.g. "Lakeside 1").
// Mirrors the ROOMS catalog in register.html — update both if the retreat
// center changes capacity.
const RETREAT_ROOM_MAX_OCCUPANCY = {
  'Hillside Apartment': 5,
  'Casita 1': 2, 'Casita 2': 2, 'Casita 3': 2, 'Casita 4': 2,
  'Casita 5': 2, 'Casita 6': 2, 'Casita 7': 2, 'Casita 8': 2,
  'Lodge 1': 2, 'Lodge 2': 2, 'Lodge 3': 2, 'Lodge 4': 2,
  'Lodge 5': 2, 'Lodge 6': 2, 'Lodge 7': 2, 'Lodge 8': 2,
};
const RETREAT_EVENT_ID = 'sattva-path-retreat-2026';

// Aggregate spots-taken per room across all registrations for an event.
// 'paid' rows are hard-taken; 'pending' rows within 30 min are a soft hold
// so a room stays reserved while a registrant is still in checkout.
async function getRoomSpotsTaken(eventId) {
  const q = `
    SELECT (elem->>'room') AS room_id,
           SUM(COALESCE(NULLIF(elem->>'spots','')::int, 0))::int AS spots_taken
      FROM (
        SELECT accommodation_details->'rooms' AS rooms
          FROM registrations
         WHERE event_id = $1
           AND ( payment_status = 'paid'
              OR (payment_status = 'pending' AND created_at > NOW() - INTERVAL '30 minutes') )
           AND jsonb_typeof(accommodation_details->'rooms') = 'array'
      ) r,
      LATERAL jsonb_array_elements(r.rooms) AS elem
     WHERE COALESCE(elem->>'room','') <> ''
     GROUP BY room_id`;
  const result = await pool.query(q, [eventId]);
  const out = {};
  for (const row of result.rows) out[row.room_id] = Number(row.spots_taken) || 0;
  return out;
}

app.get('/api/retreat/room-availability', async (req, res) => {
  const eventId = String(req.query.event_id || '').slice(0, 100);
  if (!eventId) return res.status(400).json({ error: 'missing_event_id' });
  try {
    const spotsTaken = await getRoomSpotsTaken(eventId);
    res.json({ event_id: eventId, spots_taken: spotsTaken });
  } catch (err) {
    console.error('room-availability error:', err?.message || err);
    res.status(500).json({ error: 'availability_lookup_failed' });
  }
});

app.post('/api/registrations', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!rateLimit(`reg:${ip}`, 5)) return res.status(429).json({ error: 'rate_limited' });
  const r = req.body || {};
  if (!r.contact_name || !r.contact_email || !r.contact_phone) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const eventId = r.event_id || null;
  const participants = Array.isArray(r.participants) ? r.participants : [];
  const accommodationDetails = r.accommodation_details && typeof r.accommodation_details === 'object'
    ? r.accommodation_details : {};

  // For the retreat, every participant must include the currently-required fields.
  // Guards against stale/cached versions of register.html that omit newer fields
  // (gender, shirtSize were added 2026-07-24).
  if (eventId === RETREAT_EVENT_ID && participants.length) {
    const REQUIRED_PARTICIPANT_FIELDS = [
      'firstName', 'lastName', 'age', 'gender', 'shirtSize',
      'email', 'phone', 'emergencyName', 'emergencyPhone',
    ];
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i] || {};
      const missing = REQUIRED_PARTICIPANT_FIELDS.filter((k) => !String(p[k] || '').trim());
      if (missing.length) {
        return res.status(400).json({
          error: 'missing_participant_fields',
          participant: i + 1,
          fields: missing,
          hint: 'Your registration page may be out of date. Hard-refresh (Ctrl+Shift+R) and re-submit.',
        });
      }
    }
  }

  // For the retreat, reject if requested rooms would exceed remaining capacity.
  if (eventId === RETREAT_EVENT_ID && Array.isArray(accommodationDetails.rooms) && accommodationDetails.rooms.length) {
    const requested = {};
    for (const item of accommodationDetails.rooms) {
      const rid = String(item?.room || '');
      const spots = Number(item?.spots) || 0;
      if (!rid || spots <= 0) continue;
      requested[rid] = (requested[rid] || 0) + spots;
    }
    if (Object.keys(requested).length) {
      const taken = await getRoomSpotsTaken(eventId);
      for (const [rid, req] of Object.entries(requested)) {
        const max = RETREAT_ROOM_MAX_OCCUPANCY[rid];
        if (max == null) continue;
        const already = taken[rid] || 0;
        if (already + req > max) {
          return res.status(409).json({
            error: 'room_unavailable',
            room: rid,
            spots_available: Math.max(0, max - already),
            spots_requested: req,
          });
        }
      }
    }
  }

  const inserted = await pool.query(
    `INSERT INTO registrations (
        event_id, contact_name, contact_email, contact_phone,
        participant_count, participants, accommodation, accommodation_details,
        dietary_notes, emergency_name, emergency_phone,
        fee_type, fee_per_person, retreat_fee_total, lodging_total, total_amount,
        liability_accepted, source)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id, created_at`,
    [
      eventId,
      String(r.contact_name).slice(0, 200),
      String(r.contact_email).slice(0, 200),
      String(r.contact_phone).slice(0, 60),
      Number(r.participant_count || participants.length || 1),
      JSON.stringify(participants),
      String(r.accommodation || '').slice(0, 200),
      JSON.stringify(accommodationDetails),
      String(r.dietary_notes || '').slice(0, 2000),
      String(r.emergency_name || '').slice(0, 200),
      String(r.emergency_phone || '').slice(0, 60),
      String(r.fee_type || '').slice(0, 40),
      Number(r.fee_per_person || 0),
      Number(r.retreat_fee_total || 0),
      Number(r.lodging_total || 0),
      Number(r.total_amount || 0),
      Boolean(r.liability_accepted),
      String(r.source || 'website').slice(0, 40),
    ]
  );
  res.status(201).json({ id: inserted.rows[0].id, created_at: inserted.rows[0].created_at });
});

// ---------------- Stripe Checkout (public) ----------------

app.post('/api/checkout-session', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'stripe_not_configured' });
  try {
    const ip = req.ip || 'unknown';
    if (!rateLimit(`checkout:${ip}`, 10)) return res.status(429).json({ error: 'rate_limited' });
    const { registration_id } = req.body || {};
    if (!registration_id) return res.status(400).json({ error: 'missing_registration_id' });

    const r = await pool.query(
      `SELECT id, contact_name, contact_email, total_amount, participant_count,
              event_id, payment_status
         FROM registrations WHERE id = $1`,
      [registration_id]
    );
    const reg = r.rows[0];
    if (!reg) return res.status(404).json({ error: 'registration_not_found' });
    if (reg.payment_status === 'paid') return res.status(409).json({ error: 'already_paid' });
    const amountCents = Math.round(Number(reg.total_amount || 0) * 100);
    if (amountCents < 50) return res.status(400).json({ error: 'invalid_amount' });

    // For Checkout Sessions, payment methods enabled in the Stripe dashboard
    // (Settings -> Payment methods) show up automatically. No need to list them.
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: reg.contact_email,
      client_reference_id: reg.id,
      metadata: { registration_id: reg.id, event_id: reg.event_id || '' },
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Sattva Path Retreat registration (${reg.participant_count} ${reg.participant_count === 1 ? 'person' : 'people'})`,
            description: `Registration for ${reg.contact_name}`,
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      }],
      success_url: `${SITE_BASE_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_BASE_URL}/payment-cancel.html?registration_id=${reg.id}`,
    });

    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('checkout-session error:', err?.message || err);
    res.status(500).json({ error: err?.message || 'checkout_failed' });
  }
});

// Small public endpoint for the success page to confirm the outcome
// without exposing all registration data.
app.get('/api/checkout-status', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'missing_session_id' });
  const r = await pool.query(
    `SELECT id, contact_name, total_amount, payment_status, stripe_paid_at
       FROM registrations WHERE stripe_session_id = $1`,
    [session_id]
  );
  const reg = r.rows[0];
  if (!reg) return res.json({ status: 'processing' });
  res.json({
    status: reg.payment_status,
    contact_name: reg.contact_name,
    total_amount: reg.total_amount,
    paid_at: reg.stripe_paid_at,
  });
});

// ---------------- registrations (admin) ----------------

app.get('/api/admin/registrations', requireAdmin, async (req, res) => {
  const params = [];
  const conditions = [];
  if (req.query.event_id) { params.push(req.query.event_id); conditions.push(`event_id = $${params.length}`); }
  if (req.query.status)   { params.push(req.query.status);   conditions.push(`payment_status = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const r = await pool.query(
    `SELECT * FROM registrations ${where} ORDER BY created_at DESC`,
    params
  );
  res.json(r.rows);
});

app.get('/api/admin/registrations.csv', requireAdmin, async (req, res) => {
  const r = await pool.query(`SELECT * FROM registrations ORDER BY created_at DESC`);
  const cols = ['id','event_id','created_at','payment_status','contact_name','contact_email','contact_phone',
                'participant_count','accommodation','fee_type','fee_per_person','retreat_fee_total',
                'lodging_total','total_amount','emergency_name','emergency_phone','dietary_notes',
                'genders','shirt_sizes',
                'admin_notes','payment_notes','participants','accommodation_details'];
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [cols.join(',')];
  for (const row of r.rows) {
    const parts = Array.isArray(row.participants) ? row.participants : [];
    row.genders = parts.map((p) => p?.gender || '').filter(Boolean).join(', ');
    row.shirt_sizes = parts.map((p) => p?.shirtSize || '').filter(Boolean).join(', ');
    lines.push(cols.map((c) => esc(row[c])).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="registrations-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(lines.join('\n'));
});

app.patch('/api/admin/registrations/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const r = await pool.query(
    `UPDATE registrations SET
        payment_status = COALESCE($2, payment_status),
        payment_notes  = COALESCE($3, payment_notes),
        admin_notes    = COALESCE($4, admin_notes)
      WHERE id = $1
      RETURNING *`,
    [req.params.id, b.payment_status, b.payment_notes, b.admin_notes]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

app.delete('/api/admin/registrations/:id', requireAdmin, async (req, res) => {
  const r = await pool.query(`DELETE FROM registrations WHERE id = $1`, [req.params.id]);
  res.json({ deleted: r.rowCount });
});

// ---------------- admin auth ----------------

app.post('/api/admin/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!rateLimit(`login:${ip}`, 8)) return res.status(429).json({ error: 'rate_limited' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing_fields' });
  const r = await pool.query(
    `SELECT id, password_hash, role FROM admin_users WHERE username = $1`, [username]
  );
  const row = r.rows[0];
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = randomToken();
  await pool.query(
    `INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)`,
    [token, row.id, String(SESSION_TTL_HOURS)]
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'lax',
    maxAge: SESSION_TTL_HOURS * 3600 * 1000, path: '/',
  });
  res.json({ ok: true, user: { username, role: row.role } });
});

app.post('/api/admin/logout', async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await pool.query(`DELETE FROM admin_sessions WHERE token = $1`, [token]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, async (req, res) => {
  res.json({ user: { username: req.admin.username, role: req.admin.role } });
});

app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'missing_fields' });
  if (String(new_password).length < 8) return res.status(400).json({ error: 'password_too_short' });
  const r = await pool.query(`SELECT password_hash FROM admin_users WHERE id = $1`, [req.admin.id]);
  const row = r.rows[0];
  if (!row || !(await bcrypt.compare(current_password, row.password_hash))) {
    return res.status(401).json({ error: 'invalid_current_password' });
  }
  const hash = await bcrypt.hash(new_password, 12);
  await pool.query(`UPDATE admin_users SET password_hash = $2 WHERE id = $1`, [req.admin.id, hash]);
  // Invalidate every other session so a stolen cookie is neutralized.
  const currentToken = req.cookies?.[SESSION_COOKIE];
  await pool.query(`DELETE FROM admin_sessions WHERE admin_id = $1 AND token <> $2`, [req.admin.id, currentToken]);
  res.json({ ok: true });
});

// ---------------- 404 catchall ----------------

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Sattva API listening on 127.0.0.1:${PORT}`);
});
