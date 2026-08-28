-- Alternate prices for the same product that a cashier picks at the moment of
-- sale — market chilli powder at 100 today, 110 tomorrow because the market
-- moved, both for the same base-unit line. This is not `product_price_tier`:
-- a tier applies itself, chosen by quantity; a price option is chosen by a
-- person, because there is no rule that decides it, only today's market.
--
-- A product with no options here still sells at `product.selling_price` — the
-- feature only appears once the shop adds a second price to choose between.
CREATE TABLE product_price_option (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id  bigint      NOT NULL REFERENCES product(id),
    label       text        NOT NULL,
    price       numeric(14,2) NOT NULL CHECK (price >= 0),
    sort_order  integer     NOT NULL DEFAULT 0
);
CREATE INDEX product_price_option_product_idx ON product_price_option (product_id, sort_order);
