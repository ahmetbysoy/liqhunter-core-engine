use rust_decimal::Decimal;
use std::error::Error;
use std::fmt::{Display, Formatter};

const BPS_DENOMINATOR: i64 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PositionSide {
    Long,
    Short,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TradeSide {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MarketDepth {
    pub best_bid: Decimal,
    pub best_ask: Decimal,
    pub bid_volume_top_10: Decimal,
    pub ask_volume_top_10: Decimal,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PositionData {
    pub entry_price: Decimal,
    pub leverage: Decimal,
    pub side: PositionSide,
    pub maintenance_margin_rate: Decimal,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EngineConfig {
    pub max_data_age_ms: u64,
    pub liquidation_buffer_bps: u32,
    pub max_slippage_bps: u32,
    pub long_obi_threshold: Decimal,
    pub short_obi_threshold: Decimal,
}

impl EngineConfig {
    pub fn production() -> Self {
        Self {
            max_data_age_ms: 200,
            liquidation_buffer_bps: 50,
            max_slippage_bps: 15,
            long_obi_threshold: Decimal::new(-75, 2),
            short_obi_threshold: Decimal::new(75, 2),
        }
    }

    fn validate(self) -> Result<Self, EngineError> {
        if self.max_data_age_ms == 0
            || self.liquidation_buffer_bps == 0
            || self.max_slippage_bps == 0
            || self.long_obi_threshold >= Decimal::ZERO
            || self.short_obi_threshold <= Decimal::ZERO
            || self.long_obi_threshold <= Decimal::new(-100, 2)
            || self.short_obi_threshold >= Decimal::ONE
        {
            return Err(EngineError::InvalidConfig);
        }
        Ok(self)
    }

    fn liquidation_buffer_multiplier(self) -> Decimal {
        Decimal::ONE + Decimal::new(self.liquidation_buffer_bps as i64, 4)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CascadeAssessment {
    pub is_triggered: bool,
    pub liquidation_price: Decimal,
    pub order_book_imbalance: Decimal,
    pub is_price_proximate: bool,
    pub is_order_book_collapsed: bool,
    pub data_age_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineError {
    InvalidConfig,
    DataNeverSeen,
    DataStale,
    ClockRegression,
    NonMonotonicTimestamp,
    InvalidPrice,
    InvalidLeverage,
    InvalidMaintenanceMargin,
    InvalidDepth,
    EmptyOrderBook,
    InvalidTargetPrice,
    SlippageExceeded,
}

impl Display for EngineError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::InvalidConfig => "invalid engine configuration",
            Self::DataNeverSeen => "no market data has been accepted",
            Self::DataStale => "market data is stale",
            Self::ClockRegression => "evaluation clock is before the latest data",
            Self::NonMonotonicTimestamp => "market data timestamp moved backwards",
            Self::InvalidPrice => "price must be greater than zero",
            Self::InvalidLeverage => "leverage must be at least one",
            Self::InvalidMaintenanceMargin => "maintenance margin must be in [0, 1)",
            Self::InvalidDepth => "order book is invalid",
            Self::EmptyOrderBook => "order book has no volume",
            Self::InvalidTargetPrice => "target price must be greater than zero",
            Self::SlippageExceeded => "execution slippage exceeds the configured limit",
        };
        formatter.write_str(message)
    }
}

impl Error for EngineError {}

pub struct LiquidationEngine {
    config: EngineConfig,
    last_data_timestamp_ms: Option<u64>,
}

impl LiquidationEngine {
    pub fn new(config: EngineConfig) -> Result<Self, EngineError> {
        Ok(Self {
            config: config.validate()?,
            last_data_timestamp_ms: None,
        })
    }

    pub fn production() -> Self {
        Self::new(EngineConfig::production()).expect("production engine config must be valid")
    }

    pub fn config(&self) -> EngineConfig {
        self.config
    }

    pub fn last_data_timestamp_ms(&self) -> Option<u64> {
        self.last_data_timestamp_ms
    }

    pub fn record_data_timestamp(&mut self, timestamp_ms: u64) -> Result<(), EngineError> {
        if let Some(previous) = self.last_data_timestamp_ms {
            if timestamp_ms < previous {
                return Err(EngineError::NonMonotonicTimestamp);
            }
        }
        self.last_data_timestamp_ms = Some(timestamp_ms);
        Ok(())
    }

    pub fn check_data_freshness(&self, current_timestamp_ms: u64) -> Result<u64, EngineError> {
        let last = self
            .last_data_timestamp_ms
            .ok_or(EngineError::DataNeverSeen)?;
        let age = current_timestamp_ms
            .checked_sub(last)
            .ok_or(EngineError::ClockRegression)?;
        if age > self.config.max_data_age_ms {
            return Err(EngineError::DataStale);
        }
        Ok(age)
    }

    pub fn calculate_liquidation_price(
        &self,
        position: &PositionData,
    ) -> Result<Decimal, EngineError> {
        if position.entry_price <= Decimal::ZERO {
            return Err(EngineError::InvalidPrice);
        }
        if position.leverage < Decimal::ONE {
            return Err(EngineError::InvalidLeverage);
        }
        if position.maintenance_margin_rate < Decimal::ZERO
            || position.maintenance_margin_rate >= Decimal::ONE
        {
            return Err(EngineError::InvalidMaintenanceMargin);
        }

        let inverse_leverage = Decimal::ONE / position.leverage;
        let liquidation_price = match position.side {
            PositionSide::Long => {
                position.entry_price
                    * (Decimal::ONE - inverse_leverage + position.maintenance_margin_rate)
            }
            PositionSide::Short => {
                position.entry_price
                    * (Decimal::ONE + inverse_leverage - position.maintenance_margin_rate)
            }
        };

        if liquidation_price <= Decimal::ZERO {
            return Err(EngineError::InvalidPrice);
        }
        Ok(liquidation_price)
    }

    pub fn calculate_order_book_imbalance(
        &self,
        depth: &MarketDepth,
    ) -> Result<Decimal, EngineError> {
        self.validate_depth(depth)?;
        let total_volume = depth.bid_volume_top_10 + depth.ask_volume_top_10;
        if total_volume <= Decimal::ZERO {
            return Err(EngineError::EmptyOrderBook);
        }
        Ok((depth.bid_volume_top_10 - depth.ask_volume_top_10) / total_volume)
    }

    pub fn evaluate_cascade_trigger(
        &mut self,
        current_timestamp_ms: u64,
        mark_price: Decimal,
        depth: &MarketDepth,
        position: &PositionData,
    ) -> Result<CascadeAssessment, EngineError> {
        if mark_price <= Decimal::ZERO {
            return Err(EngineError::InvalidPrice);
        }
        self.record_data_timestamp(depth.timestamp_ms)?;
        let data_age_ms = self.check_data_freshness(current_timestamp_ms)?;
        let liquidation_price = self.calculate_liquidation_price(position)?;
        let order_book_imbalance = self.calculate_order_book_imbalance(depth)?;
        let buffer_multiplier = self.config.liquidation_buffer_multiplier();

        let is_price_proximate = match position.side {
            PositionSide::Long => mark_price <= liquidation_price * buffer_multiplier,
            PositionSide::Short => mark_price >= liquidation_price / buffer_multiplier,
        };
        let is_order_book_collapsed = match position.side {
            PositionSide::Long => order_book_imbalance <= self.config.long_obi_threshold,
            PositionSide::Short => order_book_imbalance >= self.config.short_obi_threshold,
        };

        Ok(CascadeAssessment {
            is_triggered: is_price_proximate && is_order_book_collapsed,
            liquidation_price,
            order_book_imbalance,
            is_price_proximate,
            is_order_book_collapsed,
            data_age_ms,
        })
    }

    pub fn validate_execution_slippage(
        &self,
        target_price: Decimal,
        executed_price: Decimal,
        side: TradeSide,
    ) -> Result<Decimal, EngineError> {
        if target_price <= Decimal::ZERO || executed_price <= Decimal::ZERO {
            return Err(EngineError::InvalidTargetPrice);
        }

        let adverse_move = match side {
            TradeSide::Buy if executed_price > target_price => executed_price - target_price,
            TradeSide::Sell if executed_price < target_price => target_price - executed_price,
            _ => Decimal::ZERO,
        };
        let slippage_bps = adverse_move / target_price * Decimal::new(BPS_DENOMINATOR, 0);
        if slippage_bps > Decimal::new(self.config.max_slippage_bps as i64, 0) {
            return Err(EngineError::SlippageExceeded);
        }
        Ok(slippage_bps)
    }

    fn validate_depth(&self, depth: &MarketDepth) -> Result<(), EngineError> {
        if depth.best_bid <= Decimal::ZERO
            || depth.best_ask <= Decimal::ZERO
            || depth.best_bid > depth.best_ask
            || depth.bid_volume_top_10 < Decimal::ZERO
            || depth.ask_volume_top_10 < Decimal::ZERO
        {
            return Err(EngineError::InvalidDepth);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn long_position() -> PositionData {
        PositionData {
            entry_price: Decimal::new(100, 0),
            leverage: Decimal::new(20, 0),
            side: PositionSide::Long,
            maintenance_margin_rate: Decimal::new(4, 3),
        }
    }

    fn collapsed_sell_depth(timestamp_ms: u64) -> MarketDepth {
        MarketDepth {
            best_bid: Decimal::new(95, 0),
            best_ask: Decimal::new(951, 1),
            bid_volume_top_10: Decimal::ONE,
            ask_volume_top_10: Decimal::new(10, 0),
            timestamp_ms,
        }
    }

    #[test]
    fn calculates_long_liquidation_price_from_position_inputs() {
        let engine = LiquidationEngine::production();
        let liquidation_price = engine
            .calculate_liquidation_price(&long_position())
            .expect("valid position");
        assert_eq!(liquidation_price, Decimal::new(954, 1));
    }

    #[test]
    fn triggers_only_when_price_and_book_conditions_agree() {
        let mut engine = LiquidationEngine::production();
        let assessment = engine
            .evaluate_cascade_trigger(
                1_000,
                Decimal::new(9568, 2),
                &collapsed_sell_depth(900),
                &long_position(),
            )
            .expect("valid market snapshot");
        assert!(assessment.is_triggered);
        assert!(assessment.is_price_proximate);
        assert!(assessment.is_order_book_collapsed);
        assert_eq!(assessment.data_age_ms, 100);
    }

    #[test]
    fn stale_data_is_rejected_before_trigger_evaluation() {
        let mut engine = LiquidationEngine::production();
        let result = engine.evaluate_cascade_trigger(
            1_201,
            Decimal::new(9568, 2),
            &collapsed_sell_depth(1_000),
            &long_position(),
        );
        assert_eq!(result, Err(EngineError::DataStale));
    }

    #[test]
    fn adverse_buy_slippage_is_limited_in_basis_points() {
        let engine = LiquidationEngine::production();
        let result = engine.validate_execution_slippage(
            Decimal::new(100, 0),
            Decimal::new(1002, 1),
            TradeSide::Buy,
        );
        assert_eq!(result, Err(EngineError::SlippageExceeded));
    }

    #[test]
    fn favorable_or_flat_slippage_does_not_fail_the_guard() {
        let engine = LiquidationEngine::production();
        let slippage = engine
            .validate_execution_slippage(Decimal::new(100, 0), Decimal::new(999, 1), TradeSide::Buy)
            .expect("favorable fill");
        assert_eq!(slippage, Decimal::ZERO);
    }
}
