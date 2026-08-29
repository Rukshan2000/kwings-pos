-- Login didn't exist until now, so nothing enforced the "must force a password
-- change on first login" note left on the seeded admin account (0003_seed.sql).
-- This column makes that enforceable: true means the next successful login must
-- be followed by a password change before any other command is allowed.
ALTER TABLE app_user
    ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- The seeded admin still has the public default password from 0003_seed.sql.
UPDATE app_user SET must_change_password = true WHERE username = 'admin';
