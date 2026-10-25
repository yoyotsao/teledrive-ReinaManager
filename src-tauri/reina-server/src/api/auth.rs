//! TeleDrive JWT 验证；规则与 TeleDrive backend 的 `decode_jwt` 一致。

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;
use serde_json::Value;

use crate::app::AppState;
use crate::error::ApiError;
use crate::stores::UserStore;

#[derive(Deserialize)]
struct Claims {
    // TeleDrive 用 Python 的 int() 转换，所以同时接受整数与数字字符串
    user_id: Value,
}

/// 验证 TeleDrive 签发的 JWT，返回 `user_id`。
///
/// 与 TeleDrive `decode_jwt` 相同：只接受 HS256、必须有 `exp` 与 `user_id`、
/// 不给时间宽限（PyJWT 默认 leeway 为 0）。
pub fn verify_token(token: &str, secret: &str) -> Result<i64, ApiError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 0;
    validation.validate_exp = true;
    validation.set_required_spec_claims(&["exp"]);

    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|_| ApiError::unauthorized())?;

    parse_user_id(&data.claims.user_id).ok_or_else(ApiError::unauthorized)
}

fn parse_user_id(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }
}

/// 已通过验证的使用者，附带他自己的数据库与封面目录。
/// `token` 保留原文，扫描时要用它转调用 TeleDrive API。
#[derive(Clone)]
pub struct AuthUser {
    pub user_id: i64,
    pub token: String,
    pub store: UserStore,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(ApiError::unauthorized)?;
        // 与 TeleDrive 相同，只接受 "Bearer " 前缀
        let token = header
            .strip_prefix("Bearer ")
            .ok_or_else(ApiError::unauthorized)?;
        let user_id = verify_token(token, &state.config.jwt_secret)?;
        // 任何有效的 TeleDrive 使用者都可以使用，各自拿到自己的数据；非正整数 id 视为无效
        let store = state.stores.open(user_id).await?;
        Ok(Self {
            user_id,
            token: token.to_string(),
            store,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    use serde_json::{Value, json};
    use std::time::{SystemTime, UNIX_EPOCH};

    const SECRET: &str = "unit-secret";

    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    fn sign(claims: Value, alg: Algorithm, secret: &str) -> String {
        encode(
            &Header::new(alg),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap()
    }

    #[test]
    fn 有效的_hs256_token_返回_user_id() {
        let token = sign(
            json!({"user_id": 42, "exp": now() + 60}),
            Algorithm::HS256,
            SECRET,
        );
        assert_eq!(verify_token(&token, SECRET).unwrap(), 42);
    }

    #[test]
    fn 数字字符串的_user_id_与_teledrive_的_int_转换一致() {
        let token = sign(
            json!({"user_id": "42", "exp": now() + 60}),
            Algorithm::HS256,
            SECRET,
        );
        assert_eq!(verify_token(&token, SECRET).unwrap(), 42);
    }

    #[test]
    fn 已过期的_token_不给任何宽限() {
        let token = sign(
            json!({"user_id": 42, "exp": now() - 1}),
            Algorithm::HS256,
            SECRET,
        );
        assert_eq!(verify_token(&token, SECRET).unwrap_err().status, 401);
    }

    #[test]
    fn 缺少必要字段或格式错误都回_401() {
        let cases = [
            sign(json!({"user_id": 42}), Algorithm::HS256, SECRET),
            sign(json!({"exp": now() + 60}), Algorithm::HS256, SECRET),
            sign(
                json!({"user_id": null, "exp": now() + 60}),
                Algorithm::HS256,
                SECRET,
            ),
            sign(
                json!({"user_id": "abc", "exp": now() + 60}),
                Algorithm::HS256,
                SECRET,
            ),
            sign(
                json!({"user_id": 42, "exp": now() + 60}),
                Algorithm::HS256,
                "other-secret",
            ),
            sign(
                json!({"user_id": 42, "exp": now() + 60}),
                Algorithm::HS512,
                SECRET,
            ),
            "not-a-jwt".to_string(),
        ];
        for token in cases {
            let err = verify_token(&token, SECRET).unwrap_err();
            assert_eq!(err.status, 401, "token {token} 应该被拒绝");
            assert_eq!(err.code, "unauthorized");
        }
    }
}
