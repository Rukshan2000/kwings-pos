-- End-of-day till count: what the cashier physically counted in the drawer,
-- broken down by denomination, against what the day's cash sales say should be
-- there. One row per location per day — recounting the same day overwrites it,
-- since a reconciliation is "what we found at close today", not a ledger entry.
CREATE TABLE cash_reconciliation (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    location_id     bigint      NOT NULL REFERENCES location(id),
    business_date   date        NOT NULL,
    expected_cash   numeric(14,2) NOT NULL,
    counted_cash    numeric(14,2) NOT NULL,
    variance        numeric(14,2) NOT NULL,
    -- [{"value": "5000", "count": 3}, ...] — denominations are shop-currency
    -- specific and change less often than code should need to be touched.
    denominations   jsonb       NOT NULL,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      bigint      REFERENCES app_user(id),
    UNIQUE (location_id, business_date)
);
