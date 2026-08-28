-- Products the till offers as one-tap buttons: shopping bags, mostly, but the
-- shop decides. A flag rather than a hardcoded list of bag sizes, so a shop that
-- sells string, ice or a delivery charge the same way does not need a code
-- change to get a button for it.
--
-- `sort_order` exists so small/medium/large read in that order rather than
-- alphabetically, which would put Large first.
ALTER TABLE product
    ADD COLUMN quick_add  boolean NOT NULL DEFAULT false,
    ADD COLUMN sort_order integer NOT NULL DEFAULT 0;

-- The till reads this on every load and it is a handful of rows out of the whole
-- catalogue, so it is worth an index that only carries them.
CREATE INDEX product_quick_add_idx ON product (sort_order, name) WHERE quick_add;
