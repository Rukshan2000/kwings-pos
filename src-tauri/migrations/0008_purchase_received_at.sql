-- `created_at` is when the draft was entered, not when the goods actually
-- arrived — those can be days apart. Without this column "when was this
-- received" was unanswerable once the draft aged past its creation date.
ALTER TABLE purchase
    ADD COLUMN received_at timestamptz;
