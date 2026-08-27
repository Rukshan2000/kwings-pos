-- Minimum data the app cannot run without. Product/category/customer data is the
-- shop owner's, not ours to seed.

INSERT INTO location (name, is_default) VALUES ('Main Store', true);

INSERT INTO unit (code, name) VALUES
    ('pc',  'Piece'),
    ('pkt', 'Packet'),
    ('pack','Pack'),
    ('box', 'Box'),
    ('bag', 'Bag'),
    ('btl', 'Bottle'),
    ('kg',  'Kilogram'),
    ('g',   'Gram'),
    ('l',   'Litre'),
    ('ml',  'Millilitre');

INSERT INTO payment_method_setting (method, enabled) VALUES
    ('cash', true), ('card', true), ('bank_transfer', true), ('credit', true);

INSERT INTO expense_category (name) VALUES
    ('Utilities'), ('Rent'), ('Salaries'), ('Transport'), ('Miscellaneous');

-- Default admin: username 'admin', password 'admin123'. Real Argon2id hash,
-- verified to round-trip (m=65536 KiB, t=3, p=4 — argon2 crate defaults). It is
-- a setup convenience, not a secret: this file is public. The app MUST force a
-- password change on first login.
INSERT INTO app_user (username, display_name, password_hash, role)
VALUES (
    'admin',
    'Administrator',
    '$argon2id$v=19$m=65536,t=3,p=4$OYPlv3sSJAndGlcNx18oXg$LxF/kP3p6qbrmzXdw2Xi7LWB6zwOdl5zdr/rHOCRE1s',
    'admin'
);
