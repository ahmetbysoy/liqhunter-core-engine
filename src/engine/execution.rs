use hmac::{Hmac, Mac};
use reqwest::Client;
use rust_decimal::Decimal;
use serde::Deserialize;
use sha2::Sha256;
use std::env;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::time::{SystemTime, UNIX_EPOCH};
use url::form_urlencoded::Serializer;
use zeroize::Zeroizing;

type HmacSha256 = Hmac<Sha256>;

const DEFAULT_BASE_URL: &str = "https://fapi.binance.com";
const RECV_WINDOW_MS: u64 = 50;
const HTTP_TIMEOUT_MS: u64 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    Disabled,
    Live,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderSide {
    Buy,
    Sell,
}

impl OrderSide {
    fn as_str(self) -> &'static str {
        match self {
            Self::Buy => "BUY",
            Self::Sell => "SELL",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeInForce {
    Gtc,
    Ioc,
    Gtx,
}

impl TimeInForce {
    fn as_str(self) -> &'static str {
        match self {
            Self::Gtc => "GTC",
            Self::Ioc => "IOC",
            Self::Gtx => "GTX",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LimitOrderRequest {
    pub symbol: String,
    pub side: OrderSide,
    pub time_in_force: TimeInForce,
    pub quantity: Decimal,
    pub price: Decimal,
}

impl LimitOrderRequest {
    fn validate(&self) -> Result<(), ExecutionError> {
        if !matches!(self.symbol.as_str(), "BTCUSDT" | "ETHUSDT") {
            return Err(ExecutionError::UnsupportedSymbol(self.symbol.clone()));
        }
        if self.quantity <= Decimal::ZERO || self.price <= Decimal::ZERO {
            return Err(ExecutionError::InvalidOrder(
                "quantity and price must be greater than zero",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderResponse {
    pub client_order_id: String,
    pub cum_qty: String,
    pub cum_quote: String,
    pub executed_qty: String,
    pub order_id: u64,
    pub avg_price: String,
    pub orig_qty: String,
    pub price: String,
    pub reduce_only: bool,
    pub side: String,
    pub position_side: String,
    pub status: String,
    pub stop_price: String,
    pub close_position: bool,
    pub symbol: String,
    pub time_in_force: String,
    pub r#type: String,
    pub orig_type: String,
    pub activate_price: String,
    pub price_rate: String,
    pub update_time: u64,
    pub working_type: String,
    pub price_protect: bool,
}

#[derive(Debug)]
pub enum ExecutionError {
    MissingCredential(&'static str),
    InvalidBaseUrl,
    LiveTradingDisabled,
    UnsupportedSymbol(String),
    InvalidOrder(&'static str),
    ClockUnavailable,
    ClientBuild(reqwest::Error),
    Http(reqwest::Error),
    ResponseDecode(serde_json::Error),
    ExchangeRejected { status: u16, message: String },
}

impl Display for ExecutionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingCredential(name) => write!(formatter, "missing credential: {name}"),
            Self::InvalidBaseUrl => formatter.write_str("base URL must use HTTPS"),
            Self::LiveTradingDisabled => formatter.write_str("live trading is disabled"),
            Self::UnsupportedSymbol(symbol) => write!(formatter, "unsupported symbol: {symbol}"),
            Self::InvalidOrder(message) => formatter.write_str(message),
            Self::ClockUnavailable => formatter.write_str("system clock is before UNIX epoch"),
            Self::ClientBuild(error) => write!(formatter, "HTTP client build failed: {error}"),
            Self::Http(error) => write!(formatter, "HTTP request failed: {error}"),
            Self::ResponseDecode(error) => write!(formatter, "order response decode failed: {error}"),
            Self::ExchangeRejected { status, message } => {
                write!(formatter, "exchange rejected order ({status}): {message}")
            }
        }
    }
}

impl Error for ExecutionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::ClientBuild(error) | Self::Http(error) => Some(error),
            Self::ResponseDecode(error) => Some(error),
            _ => None,
        }
    }
}

pub struct ExecutionEngine {
    api_key: String,
    api_secret: Zeroizing<String>,
    base_url: String,
    client: Client,
    mode: ExecutionMode,
}

impl ExecutionEngine {
    pub fn from_env() -> Result<Self, ExecutionError> {
        let api_key = env::var("BINANCE_API_KEY").unwrap_or_default();
        let api_secret = env::var("BINANCE_API_SECRET").unwrap_or_default();
        let base_url = env::var("BINANCE_FUTURES_REST_URL")
            .unwrap_or_else(|_| DEFAULT_BASE_URL.to_owned());
        let live_enabled = env::var("LIVE_TRADING_ENABLED")
            .map(|value| value.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        Self::new(
            api_key,
            api_secret,
            base_url,
            if live_enabled {
                ExecutionMode::Live
            } else {
                ExecutionMode::Disabled
            },
        )
    }

    pub fn new(
        api_key: String,
        api_secret: String,
        base_url: String,
        mode: ExecutionMode,
    ) -> Result<Self, ExecutionError> {
        if !base_url.starts_with("https://") {
            return Err(ExecutionError::InvalidBaseUrl);
        }
        if mode == ExecutionMode::Live && (api_key.is_empty() || api_secret.is_empty()) {
            return Err(ExecutionError::MissingCredential("Binance API credentials"));
        }

        let client = Client::builder()
            .timeout(std::time::Duration::from_millis(HTTP_TIMEOUT_MS))
            .tcp_nodelay(true)
            .build()
            .map_err(ExecutionError::ClientBuild)?;

        Ok(Self {
            api_key,
            api_secret: Zeroizing::new(api_secret),
            base_url: base_url.trim_end_matches('/').to_owned(),
            client,
            mode,
        })
    }

    pub fn mode(&self) -> ExecutionMode {
        self.mode
    }

    pub fn generate_signature(&self, query_string: &str) -> String {
        sign_query(self.api_secret.as_bytes(), query_string)
    }

    pub fn build_signed_query(
        &self,
        order: &LimitOrderRequest,
        timestamp_ms: u64,
    ) -> Result<String, ExecutionError> {
        order.validate()?;
        let mut serializer = Serializer::new(String::new());
        serializer.append_pair("price", &order.price.to_string());
        serializer.append_pair("quantity", &order.quantity.to_string());
        serializer.append_pair("recvWindow", &RECV_WINDOW_MS.to_string());
        serializer.append_pair("side", order.side.as_str());
        serializer.append_pair("symbol", &order.symbol);
        serializer.append_pair("timeInForce", order.time_in_force.as_str());
        serializer.append_pair("timestamp", &timestamp_ms.to_string());
        serializer.append_pair("type", "LIMIT");
        Ok(serializer.finish())
    }

    pub async fn place_limit_order(
        &self,
        order: &LimitOrderRequest,
    ) -> Result<OrderResponse, ExecutionError> {
        if self.mode != ExecutionMode::Live {
            return Err(ExecutionError::LiveTradingDisabled);
        }

        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ExecutionError::ClockUnavailable)?
            .as_millis() as u64;
        let query = self.build_signed_query(order, timestamp_ms)?;
        let signature = self.generate_signature(&query);
        let url = format!(
            "{}/fapi/v1/order?{}&signature={}",
            self.base_url, query, signature
        );

        let response = self
            .client
            .post(url)
            .header("X-MBX-APIKEY", &self.api_key)
            .send()
            .await
            .map_err(ExecutionError::Http)?;
        let status = response.status();
        let body = response.text().await.map_err(ExecutionError::Http)?;

        if !status.is_success() {
            return Err(ExecutionError::ExchangeRejected {
                status: status.as_u16(),
                message: body,
            });
        }

        serde_json::from_str(&body).map_err(ExecutionError::ResponseDecode)
    }
}

fn sign_query(secret: &[u8], query_string: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts keys of any length");
    mac.update(query_string.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(mode: ExecutionMode) -> ExecutionEngine {
        ExecutionEngine::new(
            "test-api-key".to_owned(),
            "key".to_owned(),
            DEFAULT_BASE_URL.to_owned(),
            mode,
        )
        .expect("test engine")
    }

    fn order() -> LimitOrderRequest {
        LimitOrderRequest {
            symbol: "BTCUSDT".to_owned(),
            side: OrderSide::Buy,
            time_in_force: TimeInForce::Gtx,
            quantity: Decimal::new(1, 3),
            price: Decimal::new(100_000, 0),
        }
    }

    #[test]
    fn generates_known_hmac_signature() {
        assert_eq!(
            sign_query(b"key", "The quick brown fox jumps over the lazy dog"),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }

    #[test]
    fn builds_encoded_signed_query_without_secrets() {
        let query = engine(ExecutionMode::Disabled)
            .build_signed_query(&order(), 1_700_000_000_000)
            .expect("valid order");
        assert!(query.contains("symbol=BTCUSDT"));
        assert!(query.contains("recvWindow=50"));
        assert!(query.contains("timestamp=1700000000000"));
    }

    #[tokio::test]
    async fn live_request_is_locked_by_default() {
        let result = engine(ExecutionMode::Disabled)
            .place_limit_order(&order())
            .await;
        assert!(matches!(result, Err(ExecutionError::LiveTradingDisabled)));
    }
}
