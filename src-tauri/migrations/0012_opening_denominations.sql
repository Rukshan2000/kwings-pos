-- Opening cash was a single typed-in number; a cashier counting the float note
-- by note should get the same denomination breakdown UI as the closing count,
-- so this stores it the same way `denominations` does.
ALTER TABLE cash_reconciliation
    ADD COLUMN opening_denominations jsonb NOT NULL DEFAULT '[]';
