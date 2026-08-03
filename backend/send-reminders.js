// Sattva Path reminder emails
// Run periodically (every 10 min) via systemd timer sattva-reminders.timer.
// Reads env from /etc/sattva/db.env (same as sattva-api).
//
// Current scope (item 7a): hardcoded to the Aug 9 free webinar.
// Item 7b will generalize this to iterate all events with a future
// event_datetime from the `events` table.

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

// Aug 9, 2026 at 10:30 AM PDT (UTC-7 in August) = 17:30 UTC.
const WEBINAR = {
  slug: 'free-webinar-2026-08-09',
  title: 'Free Meditation Webinar',
  host: 'Dr. Nirupama Gupta',
  humanDate: 'Sunday, August 9',
  humanTime: '10:30 AM PST',
  zoomUrl: 'https://epikso.zoom.us/j/6558586811',
  startAtUTC: new Date('2026-08-09T17:30:00Z')
};

// Send reminders whose target time is within ±WINDOW_MIN of "now".
// Timer fires every 10 min, so a 10-min half-window guarantees exactly one hit.
const WINDOW_MIN = 10;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function reminderEmail(reg, hoursOut) {
  const safeName = escapeHtml(reg.name);
  const whenSoft = hoursOut === 24 ? 'tomorrow' : 'in about an hour';
  const whenExact = hoursOut === 24
    ? `${WEBINAR.humanDate} at ${WEBINAR.humanTime}`
    : `${WEBINAR.humanTime} today`;
  const subject = hoursOut === 24
    ? `Reminder: your webinar is tomorrow — ${WEBINAR.humanDate} at ${WEBINAR.humanTime}`
    : `Starting in about an hour — your webinar Zoom link`;
  const html = `
<div style="font-family:Arial,Helvetica,sans-serif; color:#253027; line-height:1.55; font-size:15px;">
  <p>Hi ${safeName},</p>
  <p>Quick reminder: the free live meditation webinar with ${WEBINAR.host} is <strong>${whenSoft}</strong> &mdash; ${whenExact}.</p>
  <p><strong>Join the Zoom room:</strong><br>
     <a href="${WEBINAR.zoomUrl}">${WEBINAR.zoomUrl}</a></p>
  <p>Find a quiet spot, put on headphones if you have them, and we&rsquo;ll see you there.</p>
  <p style="color:#5f6d61; font-size:13px; margin-top:24px;">&mdash; Sattva Path Collective</p>
</div>`.trim();
  const text = [
    `Hi ${reg.name},`,
    ``,
    `Quick reminder: the free live meditation webinar with ${WEBINAR.host} is ${whenSoft} — ${whenExact}.`,
    ``,
    `Join the Zoom room:`,
    `${WEBINAR.zoomUrl}`,
    ``,
    `Find a quiet spot, put on headphones if you have them, and we'll see you there.`,
    ``,
    `— Sattva Path Collective`
  ].join('\n');
  return { subject, html, text };
}

async function processReminder(hoursOut, columnName) {
  const now = new Date();
  const target = new Date(WEBINAR.startAtUTC.getTime() - hoursOut * 60 * 60 * 1000);
  const diffMinutes = (now - target) / 60000;

  if (now > WEBINAR.startAtUTC) {
    console.log(`Event already started; skipping ${hoursOut}h reminder.`);
    return;
  }
  if (Math.abs(diffMinutes) > WINDOW_MIN) {
    console.log(`Not in ${hoursOut}h send window (offset from target: ${diffMinutes.toFixed(1)} min).`);
    return;
  }

  const q = await pool.query(
    `SELECT id, name, email
       FROM webinar_registrations
      WHERE event_slug = $1
        AND ${columnName} IS NULL`,
    [WEBINAR.slug]
  );
  console.log(`${hoursOut}h reminder: ${q.rows.length} pending recipient(s).`);

  for (const reg of q.rows) {
    try {
      const em = reminderEmail(reg, hoursOut);
      await mailer.sendMail({
        from: SMTP_FROM,
        to: reg.email,
        subject: em.subject,
        html: em.html,
        text: em.text
      });
      await pool.query(
        `UPDATE webinar_registrations SET ${columnName} = NOW() WHERE id = $1`,
        [reg.id]
      );
      console.log(`  sent ${hoursOut}h reminder to ${reg.email}`);
    } catch (err) {
      console.error(`  failed ${hoursOut}h reminder to ${reg.email}: ${err.message}`);
    }
  }
}

(async () => {
  try {
    await processReminder(24, 'reminder_24h_sent_at');
    await processReminder(1, 'reminder_1h_sent_at');
  } catch (err) {
    console.error('Reminder job error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
