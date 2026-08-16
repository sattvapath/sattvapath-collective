// Nightly database backup — pipes pg_dump through gzip and emails the .sql.gz
// as an attachment. Runs as a systemd oneshot (see systemd/sattva-db-backup.*).
//
// Env vars (all inherited from /etc/sattva/db.env in production):
//   PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD  — same as the API
//   SMTP_USER SMTP_PASS SMTP_FROM               — same as the API
//   BACKUP_EMAIL                                — recipient; falls back to
//                                                 NOTIFY_EMAIL then SMTP_USER
//
// To restore from a dump: gunzip sattva-backup-YYYY-MM-DD.sql.gz then
//   psql sattva -f sattva-backup-YYYY-MM-DD.sql
// on a fresh Postgres instance.

const { spawn } = require('child_process');
const zlib = require('zlib');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `Sattva Path Backups <${SMTP_USER}>` : '');
const BACKUP_EMAIL = process.env.BACKUP_EMAIL || process.env.NOTIFY_EMAIL || SMTP_USER;
const DB_NAME = process.env.PGDATABASE || 'sattva';

if (!SMTP_USER || !SMTP_PASS) {
  console.error('backup-db: SMTP_USER/SMTP_PASS not set — cannot send email. Exiting.');
  process.exit(2);
}
if (!BACKUP_EMAIL) {
  console.error('backup-db: No recipient (set BACKUP_EMAIL, NOTIFY_EMAIL, or SMTP_USER).');
  process.exit(2);
}

const mailer = nodemailer.createTransport({
  host: 'smtp.gmail.com', port: 587, secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

// Row-count summary so the email body is a quick "did anything unusual happen"
// glance without downloading the dump. Reads a fixed set of tables; missing
// tables are silently skipped so the script survives schema changes.
async function collectRowCounts() {
  const pool = new Pool();
  const tables = [
    'admin_users', 'events', 'emotions', 'registrations', 'webinar_registrations',
    'contact_inquiries', 'reviews', 'site_content', 'admin_sessions',
  ];
  const counts = {};
  for (const t of tables) {
    try {
      const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
      counts[t] = r.rows[0].n;
    } catch { counts[t] = null; }
  }
  await pool.end();
  return counts;
}

// pg_dump → gzip → in-memory Buffer. Rejects on non-zero pg_dump exit so a
// broken dump never ships silently. Uses --no-owner --no-privileges so the
// dump can be restored into a fresh DB by any user.
function makeCompressedDump() {
  return new Promise((resolve, reject) => {
    const dump = spawn('pg_dump', [
      '--no-owner', '--no-privileges', '--clean', '--if-exists',
      '--format=plain', DB_NAME,
    ], { env: process.env });

    const gzip = zlib.createGzip({ level: 9 });
    const chunks = [];
    let stderr = '';

    dump.stderr.on('data', (d) => { stderr += d.toString(); });
    dump.on('error', reject);
    gzip.on('data', (chunk) => chunks.push(chunk));
    gzip.on('end', () => {}); // resolution deferred to dump 'close'
    gzip.on('error', reject);

    dump.stdout.pipe(gzip);

    dump.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`pg_dump exited ${code}: ${stderr.trim() || 'no stderr'}`));
      }
      // Wait for gzip flush after pg_dump closed its stdout.
      gzip.end();
      gzip.on('finish', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function sendBackupEmail(compressed, counts) {
  const stamp = todayStamp();
  const filename = `sattva-backup-${stamp}.sql.gz`;
  const countLines = Object.entries(counts)
    .map(([t, n]) => `  ${t.padEnd(24, ' ')} ${n === null ? '(missing)' : n.toLocaleString()}`)
    .join('\n');

  const text = [
    `Nightly database backup — ${DB_NAME}`,
    ``,
    `Date:     ${stamp} (UTC)`,
    `Size:     ${formatSize(compressed.length)} compressed`,
    `Filename: ${filename}`,
    ``,
    `Row counts:`,
    countLines,
    ``,
    `To restore on a fresh Postgres instance:`,
    `  gunzip ${filename}`,
    `  psql <db_name> -f ${filename.replace(/\.gz$/, '')}`,
    ``,
    `— Sattva Path automated backup`,
  ].join('\n');

  await mailer.sendMail({
    from: SMTP_FROM,
    to: BACKUP_EMAIL,
    subject: `[Sattva Backup] ${stamp} — ${formatSize(compressed.length)}`,
    text,
    attachments: [{ filename, content: compressed, contentType: 'application/gzip' }],
  });
}

async function sendFailureEmail(err) {
  try {
    await mailer.sendMail({
      from: SMTP_FROM,
      to: BACKUP_EMAIL,
      subject: `[Sattva Backup] FAILED — ${todayStamp()}`,
      text: [
        `Nightly database backup FAILED.`,
        ``,
        `Error: ${err.message || String(err)}`,
        ``,
        `SSH to the VPS and check:`,
        `  systemctl status sattva-db-backup.service`,
        `  journalctl -u sattva-db-backup.service -n 50 --no-pager`,
      ].join('\n'),
    });
  } catch (mailErr) {
    console.error('backup-db: failure-alert email also failed:', mailErr.message);
  }
}

(async () => {
  try {
    const counts = await collectRowCounts();
    const compressed = await makeCompressedDump();
    await sendBackupEmail(compressed, counts);
    console.log(`backup-db: sent ${formatSize(compressed.length)} to ${BACKUP_EMAIL}`);
    process.exit(0);
  } catch (err) {
    console.error('backup-db: FAILED —', err.message);
    await sendFailureEmail(err);
    process.exit(1);
  }
})();
