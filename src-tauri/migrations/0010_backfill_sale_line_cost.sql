-- complete_sale never set sale_line.unit_cost, so every sale line before this
-- migration recorded 0 cost — meaning every gross-profit report so far has
-- silently equaled revenue. Backfilled from each product's *current*
-- cost_price (converted through the line's unit factor), which is an
-- approximation for older sales if a product's cost has changed since, but a
-- far better one than 0.
UPDATE sale_line sl
SET unit_cost = src.unit_cost
FROM (
    SELECT sl2.id, p.cost_price * COALESCE(pu.factor, 1) AS unit_cost
    FROM sale_line sl2
    JOIN product p ON p.id = sl2.product_id
    LEFT JOIN product_unit pu ON pu.product_id = p.id AND pu.unit_id = sl2.unit_id
    WHERE sl2.unit_cost = 0
) src
WHERE sl.id = src.id;
