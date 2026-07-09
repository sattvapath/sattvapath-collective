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
    liability_accepted    BOOLEAN NOT NULL DEFAULT FALSE,
    admin_notes           TEXT DEFAULT '',
    source                TEXT DEFAULT 'website',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS registrations_event_idx    ON registrations(event_id);
CREATE INDEX IF NOT EXISTS registrations_status_idx   ON registrations(payment_status);
CREATE INDEX IF NOT EXISTS registrations_created_idx  ON registrations(created_at DESC);

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

CREATE TRIGGER events_updated_at
    BEFORE UPDATE ON events
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER emotions_updated_at
    BEFORE UPDATE ON emotions
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER registrations_updated_at
    BEFORE UPDATE ON registrations
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Seed the featured Sattva Path Retreat if not present.
INSERT INTO events (id, type, status, title, date, location, price, age, description, fields)
VALUES (
    'sattva-path-retreat-2026',
    'Retreat',
    'Posted',
    'Sattva Path Retreat',
    'September 19-20, 2026',
    'Enchanted Hills Retreat, 3568 Mt Veeder Rd, Napa, CA 94558',
    '$449 early bird / $499 regular',
    '18 years or older',
    'A two-day retreat for adults seeking peace, acceptance, spiritual guidance, and simple meditation practices that can be carried into daily life.',
    '["Full name","Email","Phone number","Emergency contact","Accommodation preference","Dietary considerations","Payment acknowledgment","Liability / cancellation agreement"]'::jsonb
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
