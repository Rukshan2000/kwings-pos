-- Opening and closing counts are now saved independently (morning cashier
-- saves the float, evening cashier reconciles) rather than always together in
-- one call, so a row can exist with only one side filled in. These columns
-- need defaults for that half-filled insert to succeed.
ALTER TABLE cash_reconciliation
    ALTER COLUMN expected_cash SET DEFAULT 0,
    ALTER COLUMN counted_cash SET DEFAULT 0,
    ALTER COLUMN variance SET DEFAULT 0,
    ALTER COLUMN denominations SET DEFAULT '[]';
