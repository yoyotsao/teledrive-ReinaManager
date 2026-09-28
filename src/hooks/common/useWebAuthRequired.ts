import { useEffect, useState } from "react";
import { AUTH_REQUIRED_EVENT } from "@/services/web/auth";

/**
 * 监听 HTTP 传输层发出的「需要登录」事件（token 缺失或刷新失败）
 * @returns 是否需要显示登录提示
 */
export function useWebAuthRequired(): boolean {
	const [required, setRequired] = useState(false);

	useEffect(() => {
		const handleAuthRequired = () => setRequired(true);
		window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
		return () =>
			window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
	}, []);

	return required;
}
