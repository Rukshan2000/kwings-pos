//! Unit conversion. Stock is always stored in a product's base unit; a purchase or
//! sale line can be entered in any unit defined for that product (a box, a kg, a
//! bag), and this module is the only place that translates between them.

use rust_decimal::Decimal;

use crate::domain::money::Qty;

/// `factor` is "how many base units in one of this unit" — e.g. base unit 'pc',
/// unit 'box', factor 12 means 1 box = 12 pc.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnitConversion {
    pub factor: Decimal,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum UnitError {
    #[error("conversion factor must be greater than zero")]
    NonPositiveFactor,
}

impl UnitConversion {
    pub fn new(factor: Decimal) -> Result<Self, UnitError> {
        if factor <= Decimal::ZERO {
            return Err(UnitError::NonPositiveFactor);
        }
        Ok(UnitConversion { factor })
    }

    /// e.g. 2 boxes, factor 12 → 24 pc for the stock ledger.
    pub fn to_base(&self, qty_in_unit: Qty) -> Qty {
        qty_in_unit * self.factor
    }

    /// e.g. 24 pc in stock, factor 12 → 2 boxes for display.
    pub fn from_base(&self, qty_in_base: Qty) -> Qty {
        qty_in_base / self.factor
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn box_of_twelve_converts_to_base_pieces() {
        let box_unit = UnitConversion::new(dec!(12)).unwrap();
        assert_eq!(box_unit.to_base(dec!(2)), dec!(24));
        assert_eq!(box_unit.from_base(dec!(24)), dec!(2));
    }

    #[test]
    fn kilogram_split_into_grams_is_exact() {
        // 1 kg = 1000 g. Selling 250 g must not lose precision the way an f64
        // gram-to-kg round trip can.
        let gram = UnitConversion::new(dec!(0.001)).unwrap(); // base unit is kg
        assert_eq!(gram.to_base(dec!(250)), dec!(0.250));
    }

    #[test]
    fn zero_or_negative_factor_is_rejected() {
        assert_eq!(UnitConversion::new(dec!(0)), Err(UnitError::NonPositiveFactor));
        assert_eq!(UnitConversion::new(dec!(-1)), Err(UnitError::NonPositiveFactor));
    }

    #[test]
    fn round_trip_through_a_non_integer_factor_is_stable() {
        // A fractional factor (e.g. 1 pack = 1.5 kg) must not drift after
        // converting to base and back.
        let pack = UnitConversion::new(dec!(1.5)).unwrap();
        let original = dec!(7);
        assert_eq!(pack.from_base(pack.to_base(original)), original);
    }
}
