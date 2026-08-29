-- Loyalty program: customers already had a `loyalty_points` balance reserved
-- as a Phase 2 extension point (0002_mvp_schema.sql). This activates it —
-- customers earn points on completed sales and can pay with them at the till,
-- so `loyalty_points` becomes a payment method alongside cash/card/etc.
ALTER TYPE payment_method ADD VALUE 'loyalty_points';

-- Single global rate, e.g. "earn 1 point per 100 LKR spent, redeem 1 point for
-- 1 LKR" — a single row (id is always 1) rather than a list, since there is
-- only ever one active rate.
CREATE TABLE loyalty_setting (
    id                      smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    earn_amount_lkr         numeric(14,2) NOT NULL DEFAULT 100,
    earn_points             numeric(14,2) NOT NULL DEFAULT 1,
    redeem_value_per_point  numeric(14,4) NOT NULL DEFAULT 1,
    updated_at              timestamptz NOT NULL DEFAULT now(),
    updated_by              bigint
);

INSERT INTO loyalty_setting (id) VALUES (1);
