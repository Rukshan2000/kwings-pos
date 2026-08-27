-- Full MVP schema, written once (see PLAN.md phase 2). Every later phase builds on
-- these tables rather than altering their shape.
--
-- Conventions (docs/schema.md):
--   money    NUMERIC(14,2)   quantity NUMERIC(14,3)   time timestamptz (UTC)
--   ledgers  append-only, never UPDATE/DELETE a row
--   deletion soft (archived_at), never a hard DELETE on anything a document may cite

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================== users / roles

CREATE TYPE user_role AS ENUM ('admin', 'manager', 'cashier');

CREATE TABLE app_user (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username        text        NOT NULL UNIQUE,
    display_name    text        NOT NULL,
    password_hash   text        NOT NULL,      -- Argon2id
    role            user_role   NOT NULL,
    active          boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz
);

-- Fine-grained overrides on top of the role default (e.g. a cashier permitted to
-- edit prices). Absence of a row means "use the role default", enforced in Rust.
CREATE TABLE user_permission (
    user_id     bigint NOT NULL REFERENCES app_user(id),
    permission  text   NOT NULL,
    allowed     boolean NOT NULL,
    PRIMARY KEY (user_id, permission)
);

CREATE TABLE audit_log (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     bigint REFERENCES app_user(id),
    action      text        NOT NULL,
    entity      text        NOT NULL,
    entity_id   bigint,
    detail      jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);

-- Cashier shift: opening cash through closing cash + variance.
CREATE TABLE cashier_shift (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         bigint      NOT NULL REFERENCES app_user(id),
    opened_at       timestamptz NOT NULL DEFAULT now(),
    closed_at       timestamptz,
    opening_cash    numeric(14,2) NOT NULL,
    closing_cash    numeric(14,2),
    expected_cash   numeric(14,2),
    variance        numeric(14,2),
    note            text
);
CREATE INDEX cashier_shift_open_idx ON cashier_shift (user_id) WHERE closed_at IS NULL;

-- Cash movements within a shift that are not sales: expenses paid from the till,
-- manual withdrawals, owner drops. Sales/refunds affect cash via `sale`/`sale_return`
-- and are not duplicated here.
CREATE TYPE cash_movement_type AS ENUM ('withdrawal', 'deposit');

CREATE TABLE cash_movement (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shift_id    bigint      NOT NULL REFERENCES cashier_shift(id),
    type        cash_movement_type NOT NULL,
    amount      numeric(14,2) NOT NULL CHECK (amount > 0),
    reason      text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_by  bigint      NOT NULL REFERENCES app_user(id)
);

-- ==================================================================== locations

-- Single shop today; schema supports more so phase 4's transfer table has somewhere
-- to point without a later migration.
CREATE TABLE location (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text        NOT NULL,
    is_default  boolean     NOT NULL DEFAULT false,
    archived_at timestamptz
);
CREATE UNIQUE INDEX location_one_default_idx ON location (is_default) WHERE is_default;

-- ===================================================================== catalogue

CREATE TABLE category (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text        NOT NULL UNIQUE,
    archived_at timestamptz
);

CREATE TABLE brand (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text        NOT NULL UNIQUE,
    archived_at timestamptz
);

-- Base units (kg, piece, litre, ...) plus shop-defined custom units.
CREATE TABLE unit (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        text        NOT NULL UNIQUE,   -- 'kg', 'pc', 'box', ...
    name        text        NOT NULL,
    archived_at timestamptz
);

CREATE TABLE product (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sku             text        UNIQUE,
    barcode         text        UNIQUE,
    name            text        NOT NULL,
    category_id     bigint      REFERENCES category(id),
    brand_id        bigint      REFERENCES brand(id),
    -- Stock is always held in this unit; conversions below translate to and from it.
    base_unit_id    bigint      NOT NULL REFERENCES unit(id),
    cost_price      numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
    selling_price   numeric(14,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
    low_stock_at    numeric(14,3),
    image_path      text,
    active          boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz
);
CREATE INDEX product_name_idx ON product USING gin (to_tsvector('simple', name));
CREATE INDEX product_barcode_idx ON product (barcode) WHERE barcode IS NOT NULL;

-- e.g. 1 box = 12 pc: unit_id 'box', factor 12, relative to the product's base unit
-- (which would be 'pc'). Selling/costing/scanning can happen in any defined unit;
-- stock itself is always converted to and stored in the base unit.
CREATE TABLE product_unit (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id      bigint      NOT NULL REFERENCES product(id),
    unit_id         bigint      NOT NULL REFERENCES unit(id),
    factor          numeric(14,6) NOT NULL CHECK (factor > 0),
    barcode         text UNIQUE,
    UNIQUE (product_id, unit_id)
);

-- Price tiers: retail/wholesale, and quantity breaks within either.
CREATE TYPE price_tier_kind AS ENUM ('retail', 'wholesale');

CREATE TABLE product_price_tier (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id      bigint      NOT NULL REFERENCES product(id),
    unit_id         bigint      NOT NULL REFERENCES unit(id),
    kind            price_tier_kind NOT NULL DEFAULT 'retail',
    min_qty         numeric(14,3) NOT NULL DEFAULT 0,
    price           numeric(14,2) NOT NULL CHECK (price >= 0),
    UNIQUE (product_id, unit_id, kind, min_qty)
);

-- =================================================================== inventory

-- Append-only. Every stock change of any kind — sale, purchase, adjustment,
-- transfer, return — is one row here. Rows are never updated or deleted; a
-- correction is a new opposing row. Quantity is always in the product's base unit
-- and is signed (+in / -out) so current stock is `sum(quantity)`.
CREATE TYPE stock_movement_reason AS ENUM (
    'opening', 'purchase', 'purchase_return', 'sale', 'sale_return',
    'adjustment', 'transfer_in', 'transfer_out'
);

CREATE TABLE stock_movement (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id      bigint      NOT NULL REFERENCES product(id),
    location_id     bigint      NOT NULL REFERENCES location(id),
    quantity        numeric(14,3) NOT NULL,       -- signed, base unit
    reason          stock_movement_reason NOT NULL,
    unit_cost       numeric(14,2),                -- cost at time of movement, for valuation
    note            text,
    -- Points at whichever document caused this row (sale, purchase, ...). Not a
    -- foreign key: the referenced table depends on `reason`, and the row must
    -- survive even if application-level cleanup of the source ever happened.
    ref_table       text,
    ref_id          bigint,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      bigint      REFERENCES app_user(id)
);
CREATE INDEX stock_movement_product_idx ON stock_movement (product_id, location_id, created_at);
CREATE INDEX stock_movement_ref_idx ON stock_movement (ref_table, ref_id);

CREATE TYPE stock_transfer_status AS ENUM ('pending', 'completed', 'cancelled');

CREATE TABLE stock_transfer (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    from_location_id bigint    NOT NULL REFERENCES location(id),
    to_location_id  bigint      NOT NULL REFERENCES location(id),
    status          stock_transfer_status NOT NULL DEFAULT 'pending',
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      bigint      REFERENCES app_user(id)
);

CREATE TABLE stock_transfer_line (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id     bigint      NOT NULL REFERENCES stock_transfer(id),
    product_id      bigint      NOT NULL REFERENCES product(id),
    quantity        numeric(14,3) NOT NULL CHECK (quantity > 0)
);

-- =================================================================== suppliers

CREATE TABLE supplier (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            text        NOT NULL,
    phone           text,
    address         text,
    opening_balance numeric(14,2) NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz
);

CREATE TYPE purchase_status AS ENUM ('draft', 'received', 'cancelled');

CREATE TABLE purchase (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    supplier_id     bigint      NOT NULL REFERENCES supplier(id),
    location_id     bigint      NOT NULL REFERENCES location(id),
    invoice_number  text,
    status          purchase_status NOT NULL DEFAULT 'draft',
    total           numeric(14,2) NOT NULL DEFAULT 0,
    paid            numeric(14,2) NOT NULL DEFAULT 0,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      bigint      REFERENCES app_user(id)
);

CREATE TABLE purchase_line (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    purchase_id     bigint      NOT NULL REFERENCES purchase(id),
    product_id      bigint      NOT NULL REFERENCES product(id),
    unit_id         bigint      NOT NULL REFERENCES unit(id),
    quantity        numeric(14,3) NOT NULL CHECK (quantity > 0),
    unit_cost       numeric(14,2) NOT NULL CHECK (unit_cost >= 0),
    line_total      numeric(14,2) NOT NULL
);

CREATE TABLE purchase_payment (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    purchase_id     bigint      NOT NULL REFERENCES purchase(id),
    amount          numeric(14,2) NOT NULL CHECK (amount > 0),
    method          text        NOT NULL,
    paid_at         timestamptz NOT NULL DEFAULT now(),
    created_by      bigint      REFERENCES app_user(id)
);

CREATE TYPE purchase_return_status AS ENUM ('draft', 'completed');

CREATE TABLE purchase_return (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    purchase_id     bigint      NOT NULL REFERENCES purchase(id),
    status          purchase_return_status NOT NULL DEFAULT 'draft',
    reason          text,
    total           numeric(14,2) NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      bigint      REFERENCES app_user(id)
);

CREATE TABLE purchase_return_line (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    purchase_return_id  bigint  NOT NULL REFERENCES purchase_return(id),
    purchase_line_id    bigint  NOT NULL REFERENCES purchase_line(id),
    quantity            numeric(14,3) NOT NULL CHECK (quantity > 0),
    line_total          numeric(14,2) NOT NULL
);

-- ==================================================================== customers

CREATE TABLE customer (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            text        NOT NULL,
    phone           text,
    address         text,
    credit_limit    numeric(14,2) NOT NULL DEFAULT 0,
    -- Phase 2 extension point (see PLAN.md) — loyalty points are Phase 2 of the
    -- product roadmap, not this migration phase; the column exists so the feature
    -- never needs a schema change to land.
    loyalty_points  numeric(14,2) NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz
);

CREATE TABLE customer_payment (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id     bigint      NOT NULL REFERENCES customer(id),
    amount          numeric(14,2) NOT NULL CHECK (amount > 0),
    method          text        NOT NULL,
    note            text,
    paid_at         timestamptz NOT NULL DEFAULT now(),
    created_by      bigint      REFERENCES app_user(id)
);

-- ========================================================================= sales

-- Gapless per-day invoice numbers. A SEQUENCE leaks numbers on rollback; this
-- counter is incremented inside the sale transaction under `SELECT ... FOR UPDATE`,
-- which deliberately serializes concurrent sales (fine for one till).
CREATE TABLE invoice_counter (
    prefix      text NOT NULL,
    day         date NOT NULL,
    next_seq    integer NOT NULL DEFAULT 1,
    PRIMARY KEY (prefix, day)
);

CREATE TYPE sale_status AS ENUM ('held', 'completed', 'cancelled');

CREATE TABLE sale (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_number  text        UNIQUE,
    location_id     bigint      NOT NULL REFERENCES location(id),
    customer_id     bigint      REFERENCES customer(id),
    shift_id        bigint      REFERENCES cashier_shift(id),
    status          sale_status NOT NULL DEFAULT 'held',
    subtotal        numeric(14,2) NOT NULL DEFAULT 0,
    discount_total  numeric(14,2) NOT NULL DEFAULT 0,
    tax_total       numeric(14,2) NOT NULL DEFAULT 0,
    grand_total     numeric(14,2) NOT NULL DEFAULT 0,
    -- Credit sales: grand_total minus payments received so far. Kept denormalised
    -- because it is read on every customer statement and dashboard load.
    balance_due     numeric(14,2) NOT NULL DEFAULT 0,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    created_by      bigint      REFERENCES app_user(id)
);
CREATE INDEX sale_status_idx ON sale (status);
CREATE INDEX sale_created_idx ON sale (created_at);
CREATE INDEX sale_customer_idx ON sale (customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE sale_line (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sale_id         bigint      NOT NULL REFERENCES sale(id),
    product_id      bigint      NOT NULL REFERENCES product(id),
    unit_id         bigint      NOT NULL REFERENCES unit(id),
    quantity        numeric(14,3) NOT NULL CHECK (quantity > 0),
    unit_price      numeric(14,2) NOT NULL CHECK (unit_price >= 0),
    -- Snapshot of cost at sale time, for COGS reporting independent of later cost
    -- changes on the product.
    unit_cost       numeric(14,2) NOT NULL DEFAULT 0,
    discount_amount numeric(14,2) NOT NULL DEFAULT 0,
    line_total      numeric(14,2) NOT NULL,
    -- Price overrides above the configured limit require a recorded authoriser.
    price_overridden_by bigint REFERENCES app_user(id)
);
CREATE INDEX sale_line_sale_idx ON sale_line (sale_id);
CREATE INDEX sale_line_product_idx ON sale_line (product_id);

CREATE TYPE payment_method AS ENUM ('cash', 'card', 'bank_transfer', 'credit');

-- One sale can split across methods; a credit sale simply has no payment rows yet
-- (or partial ones), tracked against `sale.balance_due`.
CREATE TABLE sale_payment (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sale_id         bigint      NOT NULL REFERENCES sale(id),
    method          payment_method NOT NULL,
    amount          numeric(14,2) NOT NULL CHECK (amount > 0),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sale_payment_sale_idx ON sale_payment (sale_id);

CREATE TYPE discount_scope AS ENUM ('line', 'bill');
CREATE TYPE discount_kind AS ENUM ('percent', 'fixed');

-- Records what discount was applied and, when above the configured limit, who
-- authorised it — the manager-authorization requirement from the feature spec.
CREATE TABLE sale_discount (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sale_id         bigint      NOT NULL REFERENCES sale(id),
    sale_line_id    bigint      REFERENCES sale_line(id),
    scope           discount_scope NOT NULL,
    kind            discount_kind NOT NULL,
    value           numeric(14,2) NOT NULL,
    amount          numeric(14,2) NOT NULL,
    authorized_by   bigint      REFERENCES app_user(id)
);

CREATE TYPE return_status AS ENUM ('draft', 'completed');

CREATE TABLE sale_return (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sale_id         bigint      NOT NULL REFERENCES sale(id),
    status          return_status NOT NULL DEFAULT 'draft',
    reason          text,
    refund_method   payment_method,
    total           numeric(14,2) NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      bigint      REFERENCES app_user(id)
);

CREATE TABLE sale_return_line (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sale_return_id  bigint      NOT NULL REFERENCES sale_return(id),
    sale_line_id    bigint      NOT NULL REFERENCES sale_line(id),
    quantity        numeric(14,3) NOT NULL CHECK (quantity > 0),
    line_total      numeric(14,2) NOT NULL
);

-- ===================================================================== expenses

CREATE TABLE expense_category (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text NOT NULL UNIQUE,
    archived_at timestamptz
);

CREATE TABLE expense (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category_id     bigint      NOT NULL REFERENCES expense_category(id),
    shift_id        bigint      REFERENCES cashier_shift(id),
    amount          numeric(14,2) NOT NULL CHECK (amount > 0),
    method          payment_method NOT NULL,
    description     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      bigint      REFERENCES app_user(id)
);
CREATE INDEX expense_created_idx ON expense (created_at);

-- ====================================================================== settings

-- Structured on top of the generic app_setting from phase 1: prefix + sequence
-- reset policy for invoice numbering, tax rate, receipt text, etc. Kept in
-- app_setting as jsonb (e.g. key = 'invoice_numbering') rather than dedicated
-- columns, so Settings can grow without another migration.

-- Selectable payment methods per shop (a shop might not accept card, etc).
CREATE TABLE payment_method_setting (
    method      payment_method PRIMARY KEY,
    enabled     boolean NOT NULL DEFAULT true
);
