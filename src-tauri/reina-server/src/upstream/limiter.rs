//! 每個來源一條全域節流佇列。所有裝置共用同一個伺服器，所以限速也跨裝置生效。
//! 間隔數值來自 `upstream::policy::SOURCE_POLICIES`（與前端 rateLimit.ts 一致）。

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use tokio::sync::Mutex;
use tokio::time::{Duration, Instant, sleep_until};

use crate::upstream::policy::SOURCE_POLICIES;

#[derive(Debug, Default)]
struct Backoff {
    until: Option<Instant>,
    consecutive_429: u32,
}

#[derive(Debug)]
pub struct SourceLimiter {
    interval: Duration,
    /// 排隊用的鎖。tokio Mutex 是公平的，等待者依抵達順序放行。
    next_start: Mutex<Option<Instant>>,
    /// 來源共用的 429 退避期限。獨立於排隊鎖，讓其他請求能在等待者睡眠時延長退避。
    backoff: StdMutex<Backoff>,
}

impl SourceLimiter {
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            next_start: Mutex::new(None),
            backoff: StdMutex::new(Backoff::default()),
        }
    }

    pub fn interval(&self) -> Duration {
        self.interval
    }

    fn backoff_until(&self) -> Option<Instant> {
        self.backoff.lock().expect("backoff lock poisoned").until
    }

    /// 等到輪到自己、而且不在退避期間為止。
    pub async fn acquire(&self) {
        let mut next = self.next_start.lock().await;
        loop {
            let wake = [*next, self.backoff_until()].into_iter().flatten().max();
            match wake {
                Some(at) if at > Instant::now() => sleep_until(at).await,
                _ => break,
            }
        }
        *next = Some(Instant::now() + self.interval);
    }

    /// 收到 429 時登記來源共用退避期限，只延長、不縮短。
    pub fn record_429(
        &self,
        retry_after: Option<Duration>,
        default: Duration,
        max: Duration,
    ) -> Duration {
        let mut backoff = self.backoff.lock().expect("backoff lock poisoned");
        backoff.consecutive_429 += 1;
        let exponent = backoff.consecutive_429.saturating_sub(1).min(16);
        let delay = retry_after
            .unwrap_or_else(|| default.saturating_mul(1 << exponent))
            .min(max);
        let until = Instant::now() + delay;
        backoff.until = Some(backoff.until.map_or(until, |current| current.max(until)));
        delay
    }

    /// 請求成功後重置連續 429 計數；已登記的期限仍照常到期。
    pub fn record_success(&self) {
        self.backoff
            .lock()
            .expect("backoff lock poisoned")
            .consecutive_429 = 0;
    }
}

#[derive(Debug)]
pub struct Limiters {
    by_source: HashMap<&'static str, SourceLimiter>,
}

impl Limiters {
    pub fn from_policies() -> Self {
        Self {
            by_source: SOURCE_POLICIES
                .iter()
                .map(|policy| {
                    (
                        policy.source,
                        SourceLimiter::new(Duration::from_millis(policy.min_interval_ms)),
                    )
                })
                .collect(),
        }
    }

    pub fn for_source(&self, source: &str) -> &SourceLimiter {
        self.by_source
            .get(source)
            .expect("every policy has a limiter")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test(start_paused = true)]
    async fn 連續請求之間至少間隔設定的毫秒數() {
        let limiter = Arc::new(SourceLimiter::new(Duration::from_millis(250)));
        let start = Instant::now();
        let mut handles = Vec::new();
        for _ in 0..4 {
            let limiter = limiter.clone();
            handles.push(tokio::spawn(async move {
                limiter.acquire().await;
                Instant::now()
            }));
        }
        let mut times: Vec<Instant> = Vec::new();
        for handle in handles {
            times.push(handle.await.unwrap());
        }
        times.sort();
        assert_eq!(times[0] - start, Duration::ZERO);
        for pair in times.windows(2) {
            assert!(pair[1] - pair[0] >= Duration::from_millis(250));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn 閒置超過間隔後不需等待() {
        let limiter = SourceLimiter::new(Duration::from_millis(1600));
        limiter.acquire().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        let before = Instant::now();
        limiter.acquire().await;
        assert_eq!(Instant::now() - before, Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn 收到_429_後同一來源的所有請求都要等退避期限() {
        let limiter = SourceLimiter::new(Duration::from_millis(100));
        limiter.acquire().await;
        let delay = limiter.record_429(
            Some(Duration::from_secs(3)),
            Duration::from_secs(30),
            Duration::from_secs(300),
        );
        assert_eq!(delay, Duration::from_secs(3));
        let before = Instant::now();
        limiter.acquire().await;
        assert!(Instant::now() - before >= Duration::from_secs(3));
    }

    #[tokio::test(start_paused = true)]
    async fn 排隊睡眠期間登記的退避也會被遵守() {
        let limiter = Arc::new(SourceLimiter::new(Duration::from_secs(1)));
        limiter.acquire().await;
        let waiter = {
            let limiter = limiter.clone();
            tokio::spawn(async move {
                let before = Instant::now();
                limiter.acquire().await;
                Instant::now() - before
            })
        };
        tokio::task::yield_now().await;
        limiter.record_429(
            Some(Duration::from_secs(5)),
            Duration::from_secs(30),
            Duration::from_secs(300),
        );
        let waited = waiter.await.unwrap();
        assert!(waited >= Duration::from_secs(5), "實際只等了 {waited:?}");
    }

    #[test]
    fn 沒有_retry_after_時指數退避_成功後重置() {
        let limiter = SourceLimiter::new(Duration::from_millis(100));
        let (default, max) = (Duration::from_secs(30), Duration::from_secs(300));
        assert_eq!(
            limiter.record_429(None, default, max),
            Duration::from_secs(30)
        );
        assert_eq!(
            limiter.record_429(None, default, max),
            Duration::from_secs(60)
        );
        assert_eq!(
            limiter.record_429(None, default, max),
            Duration::from_secs(120)
        );
        assert_eq!(
            limiter.record_429(None, default, max),
            Duration::from_secs(240)
        );
        assert_eq!(limiter.record_429(None, default, max), max);
        limiter.record_success();
        assert_eq!(
            limiter.record_429(None, default, max),
            Duration::from_secs(30)
        );
    }

    #[test]
    fn 每個來源的間隔與_policy_一致() {
        let limiters = Limiters::from_policies();
        assert_eq!(
            limiters.for_source("vndb").interval(),
            Duration::from_millis(1600)
        );
        assert_eq!(
            limiters.for_source("bgm").interval(),
            Duration::from_millis(250)
        );
        assert_eq!(
            limiters.for_source("dlsite").interval(),
            Duration::from_millis(2000)
        );
        assert_eq!(
            limiters.for_source("erogamescape").interval(),
            Duration::from_millis(3000)
        );
        assert_eq!(
            limiters.for_source("hikarinagi").interval(),
            Duration::from_millis(500)
        );
    }
}
