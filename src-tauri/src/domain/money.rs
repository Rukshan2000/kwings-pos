//! Money and quantity types shared by every phase that touches a price or a stock
//! count. `f32`/`f64` are never used for either — binary floats cannot represent
//! 0.10 exactly, and that error compounds across thousands of sale lines.

use rust_decimal::Decimal;
use rust_decimal_macros::dec;

/// A monetary amount, stored and rounded to 2 decimal places — matches
/// `NUMERIC(14,2)` in the database.
pub type Money = Decimal;

/// A stock quantity, in a product's base unit — matches `NUMERIC(14,3)`, which is
/// enough to carry a fraction of a kilogram or a litre.
pub type Qty = Decimal;

/// Rounds to the money scale using banker's rounding, matching PostgreSQL's
/// `round()` on `NUMERIC` so a value computed in Rust and one computed in SQL never
/// disagree by a cent.
pub fn round_money(v: Money) -> Money {
    v.round_dp_with_strategy(2, rust_decimal::RoundingStrategy::MidpointNearestEven)
}

pub fn line_total(qty: Qty, unit_price: Money) -> Money {
    round_money(qty * unit_price)
}

#[derive(Debug, Clone, Copy)]
pub enum Discount {
    Percent(Decimal),
    Fixed(Money),
}

impl Discount {
    /// Amount taken off `base`. A percent discount is clamped to 0..=100 and a
    /// fixed discount is clamped to `base` — neither can ever make a line negative.
    pub fn amount_on(&self, base: Money) -> Money {
        let amount = match self {
            Discount::Percent(pct) => base * (*pct).clamp(dec!(0), dec!(100)) / dec!(100),
            Discount::Fixed(amt) => (*amt).max(dec!(0)),
        };
        round_money(amount.min(base.max(dec!(0))))
    }
}

/// One cart line, priced but not yet discounted.
#[derive(Debug, Clone, Copy)]
pub struct PricedLine {
    pub qty: Qty,
    pub unit_price: Money,
    pub discount: Option<Discount>,
}

/// What a single line came to once its own discount was taken off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineAmounts {
    pub gross: Money,
    pub discount_amount: Money,
    pub line_total: Money,
}

/// Every figure a sale needs to store or print.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Totals {
    pub lines: Vec<LineAmounts>,
    /// Gross, before any discount — matches `sale.subtotal`.
    pub subtotal: Money,
    pub line_discount_total: Money,
    pub bill_discount_amount: Money,
    /// `line_discount_total + bill_discount_amount` — matches `sale.discount_total`.
    pub discount_total: Money,
    pub grand_total: Money,
}

/// Prices a whole cart: line discounts first, then the bill discount on what is
/// left.
///
/// The order matters and is not arbitrary. A percentage off the bill has to
/// apply to what the customer is actually being asked to pay, so it is computed
/// against the subtotal *after* line discounts — otherwise "10% off" on a bill
/// whose lines were already discounted would take off more than a tenth of the
/// amount due, and two discounts could between them exceed the bill.
///
/// Every subtraction goes through `Discount::amount_on`, which clamps to its
/// base, so no combination of inputs can produce a negative total.
pub fn bill_totals(lines: &[PricedLine], bill_discount: Option<Discount>) -> Totals {
    let priced: Vec<LineAmounts> = lines
        .iter()
        .map(|l| {
            let gross = line_total(l.qty, l.unit_price);
            let discount_amount = l.discount.map_or(Money::ZERO, |d| d.amount_on(gross));
            LineAmounts {
                gross,
                discount_amount,
                line_total: gross - discount_amount,
            }
        })
        .collect();

    let subtotal = priced.iter().map(|l| l.gross).sum::<Money>();
    let line_discount_total = priced.iter().map(|l| l.discount_amount).sum::<Money>();
    let after_lines = subtotal - line_discount_total;

    let bill_discount_amount = bill_discount.map_or(Money::ZERO, |d| d.amount_on(after_lines));

    Totals {
        lines: priced,
        subtotal,
        line_discount_total,
        bill_discount_amount,
        discount_total: line_discount_total + bill_discount_amount,
        grand_total: after_lines - bill_discount_amount,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_total_rounds_to_cents() {
        // 3 x 0.1 = 0.30000..., which an f64 cannot hold exactly.
        assert_eq!(line_total(dec!(3), dec!(0.1)), dec!(0.30));
    }

    #[test]
    fn banker_rounding_matches_postgres_round() {
        // Postgres NUMERIC round() on a tie rounds to even, not always up.
        assert_eq!(round_money(dec!(1.005)), dec!(1.00));
        assert_eq!(round_money(dec!(1.015)), dec!(1.02));
    }

    #[test]
    fn percent_discount_is_clamped_to_the_base() {
        let d = Discount::Percent(dec!(150)); // a fat-fingered 150%
        assert_eq!(d.amount_on(dec!(20)), dec!(20));
    }

    #[test]
    fn fixed_discount_cannot_go_negative() {
        let d = Discount::Fixed(dec!(-5));
        assert_eq!(d.amount_on(dec!(20)), dec!(0));
    }

    #[test]
    fn fixed_discount_cannot_exceed_the_line() {
        let d = Discount::Fixed(dec!(999));
        assert_eq!(d.amount_on(dec!(20)), dec!(20));
    }

    fn line(qty: &str, price: &str, d: Option<Discount>) -> PricedLine {
        PricedLine {
            qty: qty.parse().unwrap(),
            unit_price: price.parse().unwrap(),
            discount: d,
        }
    }

    #[test]
    fn a_cart_with_no_discounts_totals_to_its_subtotal() {
        let t = bill_totals(&[line("2", "150.00", None), line("1", "75.50", None)], None);
        assert_eq!(t.subtotal, dec!(375.50));
        assert_eq!(t.discount_total, dec!(0));
        assert_eq!(t.grand_total, dec!(375.50));
    }

    #[test]
    fn a_percentage_off_one_line_only_touches_that_line() {
        let t = bill_totals(
            &[
                line("2", "150.00", Some(Discount::Percent(dec!(10)))),
                line("1", "75.50", None),
            ],
            None,
        );
        assert_eq!(t.lines[0].discount_amount, dec!(30.00));
        assert_eq!(t.lines[0].line_total, dec!(270.00));
        assert_eq!(t.lines[1].discount_amount, dec!(0));
        assert_eq!(t.subtotal, dec!(375.50));
        assert_eq!(t.grand_total, dec!(345.50));
    }

    #[test]
    fn a_fixed_amount_off_one_line_only_touches_that_line() {
        let t = bill_totals(&[line("3", "100.00", Some(Discount::Fixed(dec!(45.00))))], None);
        assert_eq!(t.lines[0].line_total, dec!(255.00));
        assert_eq!(t.grand_total, dec!(255.00));
    }

    #[test]
    fn a_bill_discount_applies_after_line_discounts_not_before() {
        // 1000 gross, 100 off the line leaves 900, and 10% of *that* is 90 —
        // not 100, which is what discounting the gross subtotal would give.
        let t = bill_totals(
            &[line("10", "100.00", Some(Discount::Fixed(dec!(100.00))))],
            Some(Discount::Percent(dec!(10))),
        );
        assert_eq!(t.line_discount_total, dec!(100.00));
        assert_eq!(t.bill_discount_amount, dec!(90.00));
        assert_eq!(t.discount_total, dec!(190.00));
        assert_eq!(t.grand_total, dec!(810.00));
    }

    #[test]
    fn discounts_can_never_drive_a_bill_below_zero() {
        // A fixed bill discount larger than the bill, on top of a line discount.
        let t = bill_totals(
            &[line("1", "500.00", Some(Discount::Percent(dec!(50))))],
            Some(Discount::Fixed(dec!(9_999.00))),
        );
        assert_eq!(t.grand_total, dec!(0));
        assert_eq!(t.bill_discount_amount, dec!(250.00));
        // The recorded discount is what was actually given, not what was typed.
        assert_eq!(t.discount_total, dec!(500.00));
    }

    #[test]
    fn a_hundred_percent_off_is_a_free_bill_not_an_error() {
        let t = bill_totals(&[line("2", "250.00", None)], Some(Discount::Percent(dec!(100))));
        assert_eq!(t.grand_total, dec!(0));
        assert_eq!(t.discount_total, dec!(500.00));
    }

    #[test]
    fn the_parts_always_reconcile_to_the_whole() {
        // subtotal - discount_total = grand_total, to the cent, on amounts that
        // do not divide evenly — this is the invariant the receipt prints.
        let t = bill_totals(
            &[
                line("3", "33.33", Some(Discount::Percent(dec!(7.5)))),
                line("1", "0.01", None),
                line("7", "19.99", Some(Discount::Fixed(dec!(11.11)))),
            ],
            Some(Discount::Percent(dec!(12.5))),
        );
        assert_eq!(t.subtotal - t.discount_total, t.grand_total);
        assert_eq!(
            t.line_discount_total + t.bill_discount_amount,
            t.discount_total
        );
    }

    #[test]
    fn a_percent_discount_rounds_to_whole_cents() {
        // 10% of 33.33 is 3.333, which must not leak a third of a cent into the
        // stored NUMERIC(14,2).
        let t = bill_totals(&[line("1", "33.33", Some(Discount::Percent(dec!(10))))], None);
        assert_eq!(t.lines[0].discount_amount, dec!(3.33));
        assert_eq!(t.grand_total, dec!(30.00));
    }

    #[test]
    fn split_payment_can_sum_exactly_to_the_total() {
        // Regression shape for split payments: three shares of a total that isn't
        // evenly divisible by 3 must still sum to the total to the cent.
        let total = dec!(100.00);
        let a = round_money(total / dec!(3));
        let b = round_money(total / dec!(3));
        let c = total - a - b; // remainder absorbs the rounding, never a float drift
        assert_eq!(a + b + c, total);
    }
}
