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

// Human-readable meeting provider inferred from the join URL, so email copy
// says "Microsoft Teams" for Teams links and "Zoom" for Zoom links instead of
// hardcoding "Zoom" for every online session. Falls back to a generic
// "meeting" label for unknown hosts.
function meetingProviderFromUrl(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return { name: 'meeting', joinLabel: 'Join the meeting' };
  if (u.includes('teams.microsoft.com') || u.includes('teams.live.com') || u.includes('teams.office.com')) {
    return { name: 'Microsoft Teams', joinLabel: 'Join the Microsoft Teams meeting' };
  }
  if (u.includes('zoom.us') || u.includes('zoom.com')) {
    return { name: 'Zoom', joinLabel: 'Join the Zoom room' };
  }
  if (u.includes('meet.google.com')) {
    return { name: 'Google Meet', joinLabel: 'Join the Google Meet' };
  }
  return { name: 'meeting', joinLabel: 'Join the meeting' };
}

function buildReminderEmail(event, registration, hoursOut) {
  const isOnline = !!(event.zoom_link && event.zoom_link.trim());
  const safeName = escapeHtml(registration.name);
  const eventTitle = event.title;
  const eventWhen = event.date; // freeform human-readable date string
  const eventWhere = event.location || '';
  const joinUrl = (event.zoom_link || '').trim();
  const provider = meetingProviderFromUrl(joinUrl);
  const emailExtra = (event.email_extra || '').trim();

  let subject, introSoft, introExact, joinBlockHtml, joinBlockText;

  if (hoursOut === 24) {
    subject = `Reminder: ${eventTitle} is tomorrow — ${eventWhen}`;
    introSoft = 'tomorrow';
    introExact = eventWhen;
  } else if (hoursOut === 1) {
    subject = isOnline
      ? `Starting in about an hour — join ${provider.name} for ${eventTitle}`
      : `${eventTitle} starts in about an hour`;
    introSoft = 'in about an hour';
    introExact = eventWhen;
  } else {
    // hoursOut === 0 → "starting right now"
    subject = isOnline
      ? `Starting now — ${eventTitle}, join here`
      : `${eventTitle} is starting now`;
    introSoft = isOnline ? 'starting right now — join the link below' : 'starting right now';
    introExact = eventWhen;
  }

  if (isOnline) {
    joinBlockHtml = `
      <p><strong>${escapeHtml(provider.joinLabel)}:</strong><br>
         <a href="${joinUrl}">${escapeHtml(joinUrl)}</a></p>`;
    joinBlockText = `${provider.joinLabel}:\n${joinUrl}`;
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

  // For 24h/1h reminders, don't fire if the event has already started.
  // For the 0h "starting now" reminder, we allow the send window to straddle
  // the actual start time (±WINDOW_MIN) — otherwise it would only ever fire
  // in the ~10 min before start.
  if (hoursOut > 0 && now > new Date(event.event_datetime)) return;
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

// Alert admin (NOTIFY_EMAIL) about retreat registrations that submitted but
// never completed payment. Fires once per row after 2 hours of pending status.
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || SMTP_USER;
const ABANDONED_HOURS = 2;

async function processAbandonedRegistrations() {
  if (!NOTIFY_EMAIL) return;
  const q = await pool.query(
    `SELECT id, event_id, contact_name, contact_email, contact_phone,
            participant_count, participants, total_amount,
            stripe_session_id, created_at
       FROM registrations
      WHERE payment_status = 'pending'
        AND abandoned_alert_sent_at IS NULL
        AND created_at < NOW() - INTERVAL '${ABANDONED_HOURS} hours'
      ORDER BY created_at ASC`
  );
  if (!q.rows.length) return;
  console.log(`Abandoned registration alerts: ${q.rows.length} pending`);
  for (const reg of q.rows) {
    try {
      const parts = Array.isArray(reg.participants) ? reg.participants : [];
      const partsText = parts.map((p, i) => {
        const name = p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
        return `  ${i + 1}. ${name || '(unnamed)'}  age ${p.age || '?'}  email ${p.email || '(none)'}  phone ${p.phone || '(none)'}`;
      }).join('\n');
      const attemptedStripe = reg.stripe_session_id ? 'YES (Stripe session was created — they clicked "Continue to secure payment" but the payment did not complete)' : 'NO (they submitted the registration but never clicked "Continue to secure payment")';
      const bodyText = [
        `A registration has been sitting as PENDING PAYMENT for more than ${ABANDONED_HOURS} hours.`,
        ``,
        `Registration ID: ${reg.id}`,
        `Submitted:       ${new Date(reg.created_at).toISOString()}`,
        `Attempted Stripe: ${attemptedStripe}`,
        ``,
        `Primary contact:`,
        `  Name:  ${reg.contact_name || ''}`,
        `  Email: ${reg.contact_email || ''}`,
        `  Phone: ${reg.contact_phone || ''}`,
        ``,
        `Party size:  ${reg.participant_count || parts.length}`,
        `Total due:   $${Number(reg.total_amount || 0).toFixed(2)}`,
        ``,
        `Participants:`,
        partsText || '  (none listed)',
        ``,
        `Suggest: reach out to ${reg.contact_email} to see if they need help completing the payment.`,
        ``,
        `Admin panel: https://sattvapathcollective.com/admin.html`,
      ].join('\n');
      await mailer.sendMail({
        from: SMTP_FROM,
        to: NOTIFY_EMAIL,
        subject: `[Sattva Alert] Registration pending payment — ${reg.contact_name || 'unknown'}`,
        text: bodyText,
        replyTo: reg.contact_email || undefined,
      });
      await pool.query(
        `UPDATE registrations SET abandoned_alert_sent_at = NOW() WHERE id = $1`,
        [reg.id]
      );
      console.log(`  alerted admin about ${reg.contact_email}`);
    } catch (err) {
      console.error(`  abandoned-alert send failed for ${reg.id}: ${err.message}`);
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

    if (events.rows.length) {
      for (const event of events.rows) {
        await processEventReminder(event, 24, 'reminder_24h_sent_at');
        await processEventReminder(event, 1,  'reminder_1h_sent_at');
        await processEventReminder(event, 0,  'reminder_start_sent_at');
      }
    } else {
      console.log('No upcoming events with event_datetime set.');
    }

    await processAbandonedRegistrations();
  } catch (err) {
    console.error('Reminder job error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
