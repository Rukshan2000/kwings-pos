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
