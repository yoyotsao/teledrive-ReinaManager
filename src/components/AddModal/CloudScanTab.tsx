import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ProxiedImage } from "@/components/ProxiedImage";
import { useCloudScan } from "@/hooks/features/games/useCloudScan";
import { getUserErrorMessage } from "@/utils/errors";

export default function CloudScanTab() {
	const { t } = useTranslation();
	const {
		scan,
		confirm,
		dismiss,
		cancel,
		loadPending,
		running,
		progress,
		pending,
		error,
		failedCount,
	} = useCloudScan();

	useEffect(() => {
		void loadPending();
	}, [loadPending]);

	return (
		<Stack spacing={2} className="pt-2">
			<Typography variant="body2" color="text.secondary">
				{t(
					"components.AddModal.cloudScan.description",
					"扫描 TeleDrive 的 game 文件夹，添加尚未建立的游戏。只有名称完全相同的结果会自动应用，其余需要你确认。",
				)}
			</Typography>
			<Stack direction="row" spacing={1}>
				<Button
					variant="contained"
					disabled={running}
					onClick={() => void scan()}
				>
					{t("components.AddModal.cloudScan.start", "开始扫描")}
				</Button>
				{running && (
					<Button onClick={cancel}>
						{t("components.AddModal.cloudScan.cancel", "停止")}
					</Button>
				)}
			</Stack>
			{running && (
				<LinearProgress
					variant={progress.total ? "determinate" : "indeterminate"}
					value={progress.total ? (progress.done / progress.total) * 100 : 0}
				/>
			)}
			{error ? (
				<Typography color="error">{getUserErrorMessage(error, t)}</Typography>
			) : null}
			{!running && failedCount > 0 ? (
				<Typography color="warning.main">
					{t(
						"components.AddModal.cloudScan.retryLater",
						"有 {{count}} 款暂时查不到资料，下次扫描会自动重试。",
						{ count: failedCount },
					)}
				</Typography>
			) : null}
			<Typography variant="subtitle2">
				{t(
					"components.AddModal.cloudScan.pendingTitle",
					"待确认（{{count}}）",
					{ count: pending.length },
				)}
			</Typography>
			<List dense>
				{pending.map((item) => (
					<ListItem key={item.id} className="flex-col items-start gap-1">
						<Typography fontWeight={700}>{item.name}</Typography>
						{item.scan_candidates.length === 0 ? (
							<Typography variant="body2" color="text.secondary">
								{t(
									"components.AddModal.cloudScan.noCandidate",
									"找不到可信的候选，请到游戏详情页手动搜索。",
								)}
							</Typography>
						) : (
							item.scan_candidates.map((candidate) => (
								<Stack
									key={`${candidate.source}:${candidate.externalId}`}
									direction="row"
									spacing={1}
									className="items-center"
								>
									{candidate.image && (
										<ProxiedImage
											src={candidate.image}
											alt=""
											className="h-12 w-9 rounded object-cover"
										/>
									)}
									<Typography variant="body2" className="flex-1">
										{candidate.name}（{candidate.source}）
									</Typography>
									<Button
										size="small"
										onClick={() => void confirm(item, candidate)}
									>
										{t("components.AddModal.cloudScan.confirm", "应用")}
									</Button>
								</Stack>
							))
						)}
						<Button
							size="small"
							color="inherit"
							onClick={() => void dismiss(item)}
						>
							{t("components.AddModal.cloudScan.dismiss", "跳过")}
						</Button>
					</ListItem>
				))}
			</List>
		</Stack>
	);
}
