import { Box, Button, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

interface WebAuthGateProps {
	onRetry: () => void;
}

/**
 * 网页版未登录提示
 * TeleDrive 登录后不会自动跳回 /game，由使用者自己回来（TeleDrive 不需要改程式）
 */
export function WebAuthGate({ onRetry }: WebAuthGateProps) {
	const { t } = useTranslation();

	return (
		<Box className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
			<Typography variant="h5" component="h1">
				{t("components.WebAuthGate.title", "请先登录 TeleDrive")}
			</Typography>
			<Typography variant="body2" color="text.secondary">
				{t(
					"components.WebAuthGate.description",
					"ReinaManager 网页版沿用 TeleDrive 的登录。请在 TeleDrive 登录后回到本页。",
				)}
			</Typography>
			<Box className="flex flex-wrap justify-center gap-3">
				<Button variant="contained" href="/">
					{t("components.WebAuthGate.openTeleDrive", "前往 TeleDrive 登录")}
				</Button>
				<Button variant="outlined" onClick={onRetry}>
					{t("components.WebAuthGate.retry", "我已登录，重新检查")}
				</Button>
			</Box>
		</Box>
	);
}
