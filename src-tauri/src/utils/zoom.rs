use tauri::{Emitter, WebviewWindow};
use webview2_com::ZoomFactorChangedEventHandler;

const MIN_ZOOM_FACTOR: f64 = 0.8;
const MAX_ZOOM_FACTOR: f64 = 1.5;

pub fn listen_to_webview_zoom(window: &WebviewWindow) -> tauri::Result<()> {
    let window_for_event = window.clone();
    window.with_webview(move |webview| {
        let callback = ZoomFactorChangedEventHandler::create(Box::new(move |sender, _| {
            if let Some(controller) = sender {
                let mut factor = 0.0;
                // SAFETY: 回调由 WebView2 在控制器有效期间调用，factor 是可写的 f64 地址。
                match unsafe { controller.ZoomFactor(&mut factor) } {
                    Ok(()) if factor.is_finite() && factor > 0.0 => {
                        let bounded_factor = factor.clamp(MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR);
                        // 忽略边界附近的浮点误差，避免无谓地改写 WebView2 的默认缩放比例。
                        let effective_factor = if (factor - bounded_factor).abs() > 0.001 {
                            // SAFETY: 回调期间控制器仍有效，缩放比例限制在 WebView2 支持的正常范围内。
                            match unsafe { controller.SetZoomFactor(bounded_factor) } {
                                Ok(()) => bounded_factor,
                                Err(error) => {
                                    log::warn!("限制 WebView 缩放比例失败: {error}");
                                    factor
                                }
                            }
                        } else {
                            factor
                        };
                        let percent = (effective_factor * 100.0).round() as u32;
                        if let Err(error) = window_for_event.emit("webview-zoom-changed", percent) {
                            log::warn!("发送 WebView 缩放事件失败: {error}");
                        }
                    }
                    Ok(()) => log::warn!("WebView 返回无效缩放比例: {factor}"),
                    Err(error) => log::warn!("读取 WebView 缩放比例失败: {error}"),
                }
            }
            Ok(())
        }));

        let mut token = 0;
        // SAFETY: callback 在注册时交给 WebView2 持有，token 是可写的事件令牌地址。
        if let Err(error) = unsafe {
            webview
                .controller()
                .add_ZoomFactorChanged(&callback, &mut token)
        } {
            log::warn!("注册 WebView 缩放事件失败: {error}");
        }
    })
}
