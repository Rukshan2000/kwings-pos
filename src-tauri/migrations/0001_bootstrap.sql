-- Phase 1 only: proves the migration runner end to end.
-- The full MVP schema lands in phase 2 as its own migration.

CREATE TABLE app_setting (
    key         text PRIMARY KEY,
    value       jsonb       NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app_setting IS 'Key/value store for shop configuration.';

INSERT INTO app_setting (key, value) VALUES
    ('schema_owner', '"greenplus-pos"'),
    ('currency',     '"LKR"')
ON CONFLICT (key) DO NOTHING;
