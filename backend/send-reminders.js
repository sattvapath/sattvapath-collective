// Sattva Path reminder emails — event-driven (item 7b).
// Runs periodically (every 10 min) via systemd timer sattva-reminders.timer.
// Reads env from /etc/sattva/db.env (same as sattva-api).
//
// For each event with a future event_datetime, checks whether the 24h or
// 1h reminder target time is inside the send window (±WINDOW_MIN of now).
// If so, finds recipients who haven't been sent that reminder yet, sends
// the email built from event fields (title, date, location, zoom_link,
// email_extra), and stamps the sent-at column. Recipients live in
// webinar_registrations when event.type = 'Webinar' and in registrations
// (payment_status='paid') otherwise.
//
// Confirmation emails (on registration) are still built by server.js for
// now; stage B will unify them here too.

const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `Sattva Path Collective <${SMTP_USER}>` : '');

if (!SMTP_USER || !SMTP_PASS) {
  console.error('SMTP not configured (SMTP_USER/SMTP_PASS unset) — reminders skipped.');
  process.exit(0);
}

const pool = new Pool();
const mailer = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

// Timer fires every 10 min, so a 10-min half-window guarantees exactly one hit
// for each reminder target time.
const WINDOW_MIN = 10;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function buildReminderEmail(event, registration, hoursOut) {
  const isOnline = !!(event.zoom_link && event.zoom_link.trim());
  const safeName = escapeHtml(registration.name);
  const eventTitle = event.title;
  const eventWhen = event.date; // freeform human-readable date string
  const eventWhere = event.location || '';
  const zoomLink = (event.zoom_link || '').trim();
  const emailExtra = (event.email_extra || '').trim();

  let subject, introSoft, introExact, joinBlockHtml, joinBlockText;

  if (hoursOut === 24) {
    subject = `Reminder: ${eventTitle} is tomorrow — ${eventWhen}`;
    introSoft = 'tomorrow';
    introExact = eventWhen;
  } else {
    subject = isOnline
      ? `Starting in about an hour — join Zoom for ${eventTitle}`
      : `${eventTitle} starts in about an hour`;
    introSoft = 'in about an hour';
    introExact = eventWhen;
  }

  if (isOnline) {
    joinBlockHtml = `
      <p><strong>Join the Zoom room:</strong><br>
         <a href="${zoomLink}">${escapeHtml(zoomLink)}</a></p>`;
    joinBlockText = `Join the Zoom room:\n${zoomLink}`;
  } else if (eventWhere) {
    joinBlockHtml = `<p><strong>Location:</strong> ${escapeHtml(eventWhere)}</p>`;
    joinBlockText = `Location: ${eventWhere}`;
  } else {
    joinBlockHtml = '';
    joinBlockText = '';
  }

  const extraHtml = emailExtra
    ? `<p>${escapeHtml(emailExtra).replace(/\n/g, '<br>')}</p>`
    : '';
  const extraText = emailExtra ? `\n${emailExtra}` : '';

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif; color:#253027; line-height:1.55; font-size:15px;">
  <p>Hi ${safeName},</p>
  <p>Quick reminder: <strong>${escapeHtml(eventTitle)}</strong> is <strong>${introSoft}</strong> &mdash; ${escapeHtml(introExact)}.</p>
  ${joinBlockHtml}
  ${extraHtml}
  <p>See you there!</p>
  <p style="color:#5f6d61; font-size:13px; margin-top:24px;">&mdash; Sattva Path Collective</p>
</div>`.trim();

  const text = [
    `Hi ${registration.name},`,
    ``,
    `Quick reminder: ${eventTitle} is ${introSoft} — ${introExact}.`,
    ``,
    joinBlockText,
    extraText,
    ``,
    `See you there!`,
    ``,
    `— Sattva Path Collective`
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

// Returns the array of pending recipients for this event + reminder kind.
// Normalises the two source tables to a common { id, name, email } shape.
async function findRecipients(event, sentAtColumn) {
  if (event.type === 'Webinar') {
    const r = await pool.query(
      `SELECT id, name, email
         FROM webinar_registrations
        WHERE event_slug = $1 AND ${sentAtColumn} IS NULL`,
      [event.id]
    );
    return { rows: r.rows, table: 'webinar_registrations' };
  }
  const r = await pool.query(
    `SELECT id, contact_name AS name, contact_email AS email
       FROM registrations
      WHERE event_id = $1
        AND payment_status = 'paid'
        AND ${sentAtColumn} IS NULL`,
    [event.id]
  );
  return { rows: r.rows, table: 'registrations' };
}

async function processEventReminder(event, hoursOut, sentAtColumn) {
  const now = new Date();
  const target = new Date(new Date(event.event_datetime).getTime() - hoursOut * 60 * 60 * 1000);
  const diffMin = (now - target) / 60000;

  if (now > new Date(event.event_datetime)) return;         // event already started
  if (Math.abs(diffMin) > WINDOW_MIN) return;               // not in send window

  const { rows, table } = await findRecipients(event, sentAtColumn);
  if (!rows.length) return;
  console.log(`[${event.id}] ${hoursOut}h reminder: ${rows.length} recipient(s)`);

  for (const reg of rows) {
    try {
      const em = buildReminderEmail(event, reg, hoursOut);
      await mailer.sendMail({
        from: SMTP_FROM,
        to: reg.email,
        subject: em.subject,
        html: em.html,
        text: em.text
      });
      await pool.query(
        `UPDATE ${table} SET ${sentAtColumn} = NOW() WHERE id = $1`,
        [reg.id]
      );
      console.log(`  sent to ${reg.email}`);
    } catch (err) {
      console.error(`  failed to ${reg.email}: ${err.message}`);
      // Deliberately don't mark sent_at so the next timer run retries.
    }
  }
}

(async () => {
  try {
    const events = await pool.query(
      `SELECT id, type, status, title, date, location, zoom_link, email_extra, event_datetime
         FROM events
        WHERE event_datetime IS NOT NULL
          AND event_datetime > NOW()
          AND status IN ('Posted', 'Closed')`
    );

    if (!events.rows.length) {
      console.log('No upcoming events with event_datetime set.');
      return;
    }

    for (const event of events.rows) {
      await processEventReminder(event, 24, 'reminder_24h_sent_at');
      await processEventReminder(event, 1, 'reminder_1h_sent_at');
    }
  } catch (err) {
    console.error('Reminder job error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
