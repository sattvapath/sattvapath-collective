-- Sattva Path Collective backend schema
-- Applied to database `sattva` owned by `sattva_app`.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Admin accounts. Only owner + optional editor for now.
CREATE TABLE IF NOT EXISTS admin_users (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'owner',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Simple session tokens stored server-side.
CREATE TABLE IF NOT EXISTS admin_sessions (
    token       TEXT PRIMARY KEY,
    admin_id    BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_sessions_admin_idx ON admin_sessions(admin_id);

-- Retreat/meditation/kirtan events.
CREATE TABLE IF NOT EXISTS events (
    id           TEXT PRIMARY KEY,  -- stable id like 'sattva-path-retreat-2026'
    type         TEXT NOT NULL,     -- 'Retreat' | 'Meditation' | 'Kirtan/Bhajan'
    status       TEXT NOT NULL,     -- 'Posted' | 'Draft' | 'Closed'
    title        TEXT NOT NULL,
    date         TEXT NOT NULL,
    location     TEXT NOT NULL,
    price        TEXT DEFAULT '',
    age          TEXT DEFAULT '',
    description  TEXT NOT NULL,
    fields       JSONB DEFAULT '[]'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS events_type_status_idx ON events(type, status);
-- Generalized fields for the reminder + email builder (item 7b). Idempotent.
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_datetime TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS zoom_link      TEXT DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS email_extra    TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS events_datetime_idx ON events(event_datetime) WHERE event_datetime IS NOT NULL;

-- Emotion board posts.
CREATE TABLE IF NOT EXISTS emotions (
    id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id                       TEXT NOT NULL,       -- browser-issued anon owner id
    status                          TEXT NOT NULL DEFAULT 'Posted',  -- 'Posted' | 'Hidden'
    name                            TEXT DEFAULT '',
    word                            TEXT NOT NULL,
    message                         TEXT DEFAULT '',
    host_response_preference        TEXT NOT NULL,
    community_response_preference   TEXT NOT NULL,
    email                           TEXT DEFAULT '',
    public_response                 TEXT DEFAULT '',
    community_replies               JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS emotions_status_idx     ON emotions(status);
CREATE INDEX IF NOT EXISTS emotions_created_at_idx ON emotions(created_at DESC);
CREATE INDEX IF NOT EXISTS emotions_client_id_idx  ON emotions(client_id);

-- Site content sections. Each 'key' maps to a data-content="key" element
-- on the site (hero.title, welcome.body, etc). Value is the text; store
-- plain text — the frontend inserts it as textContent, not HTML.
CREATE TABLE IF NOT EXISTS site_content (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Contact form inquiries. Status:
--   'new'      default on POST
--   'read'     admin viewed the details
--   'replied'  admin responded via email
--   'archived' hidden from default view
CREATE TABLE IF NOT EXISTS contact_inquiries (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           TEXT NOT NULL,
    email          TEXT NOT NULL,
    subject        TEXT DEFAULT '',
    message        TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'new',
    admin_notes    TEXT DEFAULT '',
    source_page    TEXT DEFAULT 'contact',
    ip_hash        TEXT DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS contact_inquiries_status_idx  ON contact_inquiries(status);
CREATE INDEX IF NOT EXISTS contact_inquiries_created_idx ON contact_inquiries(created_at DESC);

-- Customer reviews / testimonials.
-- status: 'pending' (default on submit) | 'approved' (public) | 'hidden'.
CREATE TABLE IF NOT EXISTS reviews (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,
    email        TEXT DEFAULT '',        -- private, admin-only
    rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    experience   TEXT DEFAULT '',        -- Retreat / Webinar / Guidance / etc.
    body         TEXT NOT NULL,
    location     TEXT DEFAULT '',        -- shown publicly, e.g. "Napa, CA"
    status       TEXT NOT NULL DEFAULT 'pending',
    admin_notes  TEXT DEFAULT '',
    ip_hash      TEXT DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reviews_status_idx  ON reviews(status);
CREATE INDEX IF NOT EXISTS reviews_created_idx ON reviews(created_at DESC);

-- Retreat / event registrations. Payment_status:
-- 'pending'   default on POST
-- 'paid'      admin toggles when Zelle received
-- 'refunded'  admin toggles after refund
-- 'cancelled' admin marks
CREATE TABLE IF NOT EXISTS registrations (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id              TEXT REFERENCES events(id) ON DELETE SET NULL,
    contact_name          TEXT NOT NULL,
    contact_email         TEXT NOT NULL,
    contact_phone         TEXT NOT NULL,
    participant_count     INTEGER NOT NULL DEFAULT 1,
    participants          JSONB NOT NULL DEFAULT '[]'::jsonb,
    accommodation         TEXT DEFAULT '',
    accommodation_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    dietary_notes         TEXT DEFAULT '',
    emergency_name        TEXT DEFAULT '',
    emergency_phone       TEXT DEFAULT '',
    fee_type              TEXT DEFAULT '',
    fee_per_person        NUMERIC(10,2) DEFAULT 0,
    retreat_fee_total     NUMERIC(10,2) DEFAULT 0,
    lodging_total         NUMERIC(10,2) DEFAULT 0,
    total_amount          NUMERIC(10,2) DEFAULT 0,
    payment_status        TEXT NOT NULL DEFAULT 'pending',
    payment_notes         TEXT DEFAULT '',
    payment_method        TEXT DEFAULT '',
    stripe_session_id     TEXT DEFAULT '',
    stripe_payment_id     TEXT DEFAULT '',
    stripe_paid_at        TIMESTAMPTZ,
    liability_accepted    BOOLEAN NOT NULL DEFAULT FALSE,
    admin_notes           TEXT DEFAULT '',
    source                TEXT DEFAULT 'website',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS registrations_event_idx    ON registrations(event_id);
CREATE INDEX IF NOT EXISTS registrations_status_idx   ON registrations(payment_status);
CREATE INDEX IF NOT EXISTS registrations_created_idx  ON registrations(created_at DESC);

-- Free webinar / one-off event registrations that don't need the full
-- retreat payment flow. Rows are created via POST /api/webinar-register.
CREATE TABLE IF NOT EXISTS webinar_registrations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_slug    TEXT NOT NULL,        -- e.g. 'free-webinar-2026-08-09'
    name          TEXT NOT NULL,
    email         TEXT NOT NULL,
    phone         TEXT DEFAULT '',
    message       TEXT DEFAULT '',
    ip_hash       TEXT DEFAULT '',
    email_status  TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'failed'
    email_error   TEXT DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS webinar_registrations_event_idx   ON webinar_registrations(event_slug);
CREATE INDEX IF NOT EXISTS webinar_registrations_created_idx ON webinar_registrations(created_at DESC);
-- Reminder tracking (idempotent — safe on re-runs).
ALTER TABLE webinar_registrations ADD COLUMN IF NOT EXISTS reminder_24h_sent_at   TIMESTAMPTZ;
ALTER TABLE webinar_registrations ADD COLUMN IF NOT EXISTS reminder_1h_sent_at    TIMESTAMPTZ;
ALTER TABLE webinar_registrations ADD COLUMN IF NOT EXISTS reminder_start_sent_at TIMESTAMPTZ;

-- Backfill Stripe columns on existing registrations tables (safe re-runs).
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS payment_method    TEXT DEFAULT '';
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS stripe_session_id TEXT DEFAULT '';
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS stripe_payment_id TEXT DEFAULT '';
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS stripe_paid_at    TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS registrations_stripe_session_idx ON registrations(stripe_session_id);
-- Reminder tracking for retreat/event registrations (item 7b).
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS reminder_24h_sent_at   TIMESTAMPTZ;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS reminder_1h_sent_at    TIMESTAMPTZ;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS reminder_start_sent_at TIMESTAMPTZ;
-- Confirmation email status on submit (mirrors webinar_registrations).
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS email_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS email_error  TEXT DEFAULT '';
-- Track admin "abandoned registration" alerts so we only email once per row.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS abandoned_alert_sent_at TIMESTAMPTZ;

-- Auto-update updated_at on any UPDATE.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_updated_at        ON events;
DROP TRIGGER IF EXISTS emotions_updated_at      ON emotions;
DROP TRIGGER IF EXISTS registrations_updated_at ON registrations;
DROP TRIGGER IF EXISTS site_content_updated_at     ON site_content;
DROP TRIGGER IF EXISTS contact_inquiries_updated_at ON contact_inquiries;
DROP TRIGGER IF EXISTS reviews_updated_at ON reviews;

CREATE TRIGGER site_content_updated_at
    BEFORE UPDATE ON site_content
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER contact_inquiries_updated_at
    BEFORE UPDATE ON contact_inquiries
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER events_updated_at
    BEFORE UPDATE ON events
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER emotions_updated_at
    BEFORE UPDATE ON emotions
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER registrations_updated_at
    BEFORE UPDATE ON registrations
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER reviews_updated_at
    BEFORE UPDATE ON reviews
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Seed the featured Sattva Path Retreat if not present.
INSERT INTO events (id, type, status, title, date, location, price, age, description, fields)
VALUES (
    'sattva-path-retreat-2026',
    'Retreat',
    'Posted',
    'Sattva Path Retreat',
    'September 19-20, 2026',
    'Enchanted Hills Retreat, 3410 Mount Veeder Road, Napa, CA 94558',
    '$449 early bird / $499 regular',
    '18 years or older',
    'A two-day retreat for adults seeking peace, acceptance, spiritual guidance, and simple meditation practices that can be carried into daily life.',
    '["Full name","Email","Phone number","Emergency contact","Accommodation preference","Dietary considerations","Payment acknowledgment","Liability / cancellation agreement"]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- Backfill retreat start time (Sep 19, 2026 at 9:00 AM PDT = 16:00 UTC).
-- Only sets the value on rows that don't already have one, so this is safe
-- to re-run and won't clobber a value edited via the admin panel later.
UPDATE events SET event_datetime = '2026-09-19 16:00:00+00'
 WHERE id = 'sattva-path-retreat-2026' AND event_datetime IS NULL;

-- Seed the free meditation webinar as a proper events row so the reminder
-- scheduler can iterate it uniformly with other events. type='Webinar'
-- means no public events-page renderer picks it up (that's on purpose —
-- the webinar has its own /free-webinar.html landing page).
INSERT INTO events (id, type, status, title, date, location, price, age, description, event_datetime, zoom_link)
VALUES (
    'free-webinar-2026-08-09',
    'Webinar',
    'Posted',
    'Free Meditation Webinar',
    'Sunday, August 9, 2026 at 10:30 AM PST',
    'via Zoom',
    'Free',
    'All ages',
    'Experience inner peace in just one hour with Dr. Nirupama Gupta. A guided meditation and live Q&A over Zoom.',
    '2026-08-09 17:30:00+00',
    'https://epikso.zoom.us/j/6558586811'
)
ON CONFLICT (id) DO NOTHING;

-- Meditation webinar series (Aug 13/15/16 2026, on Microsoft Teams). Three
-- separate events so the reminder scheduler treats each independently and
-- registrants only get reminders for the session they picked. Datetimes are
-- 2026 dates in America/Los_Angeles (PDT = UTC-7 in August).
INSERT INTO events (id, type, status, title, date, location, price, age, description, event_datetime, zoom_link)
VALUES
    ('meditation-webinar-2026-08-13', 'Webinar', 'Posted', 'Meditation Webinar — Thursday Evening',
     'Thursday, August 13, 2026 at 6:30 PM PDT', 'via Microsoft Teams', 'Free', 'All ages',
     'A one-hour live meditation session with Nirupama Gupta over Microsoft Teams.',
     '2026-08-14 01:30:00+00', 'https://teams.live.com/meet/9378260350547?p=HqCDYEMy7D3rJSGoek'),
    ('meditation-webinar-2026-08-15', 'Webinar', 'Posted', 'Meditation Webinar — Saturday Morning',
     'Saturday, August 15, 2026 at 11:00 AM PDT', 'via Microsoft Teams', 'Free', 'All ages',
     'A one-hour live meditation session with Nirupama Gupta over Microsoft Teams.',
     '2026-08-15 18:00:00+00', 'https://teams.live.com/meet/93119896045353?p=4fi4Y7RT9EuSxUtiUj'),
    ('meditation-webinar-2026-08-16', 'Webinar', 'Posted', 'Meditation Webinar — Sunday Evening',
     'Sunday, August 16, 2026 at 6:00 PM PDT', 'via Microsoft Teams', 'Free', 'All ages',
     'A one-hour live meditation session with Nirupama Gupta over Microsoft Teams.',
     '2026-08-17 01:00:00+00', 'https://teams.live.com/meet/9366432296211?p=UNN7WZsiGx9L8ZXeL2'),
    ('meditation-webinar-2026-08-20', 'Webinar', 'Posted', 'Meditation Webinar — Thursday Evening',
     'Thursday, August 20, 2026 at 7:00 PM PDT', 'via Microsoft Teams', 'Free', 'All ages',
     'A one-hour live meditation session with Nirupama Gupta over Microsoft Teams.',
     '2026-08-21 02:00:00+00', 'https://teams.live.com/meet/9324486012732?p=6S0L23NZ9yVbsnSWzs'),
    ('meditation-webinar-2026-08-23', 'Webinar', 'Posted', 'Meditation Webinar — Sunday Evening',
     'Sunday, August 23, 2026 at 5:30 PM PDT', 'via Microsoft Teams', 'Free', 'All ages',
     'A one-hour live meditation session with Nirupama Gupta over Microsoft Teams.',
     '2026-08-24 00:30:00+00', 'https://teams.live.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2F9347395651010%3Fp%3DfJGzcccY8AInUIUrPf%26anon%3Dtrue&type=meet&deeplinkId=4e6422b2-32db-40d6-bba9-6e736640e74a&directDl=true&msLaunch=true&enableMobilePage=true&suppressPrompt=true'),
    ('meditation-webinar-2026-08-25', 'Webinar', 'Posted', 'Meditation Webinar — Tuesday Evening',
     'Tuesday, August 25, 2026 at 6:30 PM PDT', 'via Microsoft Teams', 'Free', 'All ages',
     'A one-hour live meditation session with Nirupama Gupta over Microsoft Teams.',
     '2026-08-26 01:30:00+00', 'https://teams.live.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2F93771470570572%3Fp%3Dk903HuskJmWs32GzOE%26anon%3Dtrue&type=meet&deeplinkId=430074ba-64d9-407a-9539-ea4c44713502&directDl=true&msLaunch=true&enableMobilePage=true&suppressPrompt=true'),
    ('meditation-webinar-2026-08-27', 'Webinar', 'Posted', 'Meditation Webinar — Thursday Evening',
     'Thursday, August 27, 2026 at 6:30 PM PDT', 'via Microsoft Teams', 'Free', 'All ages',
     'A one-hour live meditation session with Nirupama Gupta over Microsoft Teams.',
     '2026-08-28 01:30:00+00', 'https://teams.live.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2F9343801229283%3Fp%3DRcQ0ApZBsDWeSKzduU%26anon%3Dtrue&type=meet&deeplinkId=d8e674cf-1046-4c85-97f0-da8f098fe481&directDl=true&msLaunch=true&enableMobilePage=true&suppressPrompt=true'),
    ('meditation-webinar-2026-08-29', 'Webinar', 'Posted', 'Meditation Webinar — Saturday Morning',
     'Saturday, August 29, 2026 at 11:00 AM PDT', 'via Microsoft Teams', 'Free', 'All ages',
     'A one-hour live meditation session with Nirupama Gupta over Microsoft Teams.',
     '2026-08-29 18:00:00+00', 'https://teams.live.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2F9310130131844%3Fp%3DDHPlG27xCUuuEKhihv%26anon%3Dtrue&type=meet&deeplinkId=409e7f3f-0ec9-4b49-b880-c7483f524a96&directDl=true&msLaunch=true&enableMobilePage=true&suppressPrompt=true')
ON CONFLICT (id) DO NOTHING;

COMMIT;
