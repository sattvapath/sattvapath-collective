// Sattva Path Collective API
// Node 20 + Express + node-postgres + bcrypt. Single file for simplicity.
// Env: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PORT (default 3000)

const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const pool = new Pool();

// Stripe is optional — if STRIPE_SECRET_KEY is not set, checkout endpoints
// return a clear error but the server still runs (Zelle-only mode).
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET ? require('stripe')(STRIPE_SECRET) : null;
const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://sattvapathcollective.com';

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
    `INSERT INTO events (id, type, status, title, date, location, price, age, description, fields)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     RETURNING *`,
    [e.id, e.type, e.status, e.title, e.date, e.location, e.price || '', e.age || '',
     e.description, JSON.stringify(e.fields || [])]
  );
  res.status(201).json(r.rows[0]);
});

app.patch('/api/admin/events/:id', requireAdmin, async (req, res) => {
  const e = req.body || {};
  const r = await pool.query(
    `UPDATE events SET
        type        = COALESCE($2, type),
        status      = COALESCE($3, status),
        title       = COALESCE($4, title),
        date        = COALESCE($5, date),
        location    = COALESCE($6, location),
        price       = COALESCE($7, price),
        age         = COALESCE($8, age),
        description = COALESCE($9, description),
        fields      = COALESCE($10::jsonb, fields)
      WHERE id = $1
      RETURNING *`,
    [req.params.id, e.type, e.status, e.title, e.date, e.location, e.price, e.age,
     e.description, e.fields ? JSON.stringify(e.fields) : null]
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

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
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
                'admin_notes','payment_notes','participants','accommodation_details'];
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [cols.join(',')];
  for (const row of r.rows) lines.push(cols.map((c) => esc(row[c])).join(','));
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
