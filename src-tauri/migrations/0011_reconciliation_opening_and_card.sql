-- Two gaps in the day-one cash count: no way to record what the drawer started
-- with (so "expected cash" ignored the float), and no way to reconcile
-- non-cash tenders (card/bank settlement batches) against what the till says
-- was taken.
ALTER TABLE cash_reconciliation
    ADD COLUMN opening_cash numeric(14,2) NOT NULL DEFAULT 0,
    -- [{"method": "card", "counted": "1500.00"}, ...] — one row per non-cash
    -- payment method, the amount the cashier confirms actually settled.
    ADD COLUMN payment_counts jsonb NOT NULL DEFAULT '[]';
