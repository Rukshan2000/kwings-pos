-- Every product gets a low-stock threshold.
--
-- It was nullable, and a NULL meant "never warn" — which reads as a considered
-- choice but in practice was just the field left blank on the way to saving a
-- product. A shop that wants no warning for an item can say so explicitly with
-- 0: nothing is ever at or below zero once it is out of stock at zero, so the
-- meaning survives, it just has to be stated.
--
-- Existing NULLs become 0, preserving today's behaviour for every product that
-- has one: they warned about nothing before this migration and warn about
-- nothing after it.
UPDATE product SET low_stock_at = 0 WHERE low_stock_at IS NULL;

ALTER TABLE product
    ALTER COLUMN low_stock_at SET DEFAULT 0,
    ALTER COLUMN low_stock_at SET NOT NULL,
    ADD CONSTRAINT product_low_stock_at_not_negative CHECK (low_stock_at >= 0);
