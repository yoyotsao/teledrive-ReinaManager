import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import LinearProgress from "@mui/material/LinearProgress";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProxiedImage } from "@/components/ProxiedImage";
import {
	type ApplyDecisionsResult,
	parseScanDecisions,
	useCloudScan,
} from "@/hooks/features/games/useCloudScan";
import { getUserErrorMessage } from "@/utils/errors";

export default function CloudScanTab() {
	const { t } = useTranslation();
	const {
		scan,
		confirm,
		applyDecisions,
		dismiss,
		cancel,
		loadPending,
		running,
		progress,
		pending,
		error,
		failedCount,
		lastScanAt,
	} = useCloudScan();

	const [importOpen, setImportOpen] = useState(false);
	const [importText, setImportText] = useState("");
	const [importResult, setImportResult] = useState<ApplyDecisionsResult | null>(
		null,
	);
	const parsedDecisions = importText.trim()
		? parseScanDecisions(importText)
		: null;

	const handleImport = async () => {
		if (!parsedDecisions) return;
		setImportOpen(false);
		setImportResult(null);
		setImportResult(await applyDecisions(parsedDecisions));
		setImportText("");
	};

	// 背景掃描已維護待確認清單；打開對話框時再讀一次，帶入其他裝置的變更
	useEffect(() => {
		void loadPending();
	}, [loadPending]);

	return (
		<Stack spacing={2} className="pt-2">
			<Typography variant="body2" color="text.secondary">
				{t(
					"components.AddModal.cloudScan.description",
					"系统会定期自动扫描 TeleDrive 的 game 文件夹并添加游戏。名称完全相同的结果会自动应用，其余列在下方，选一个候选应用即可。",
				)}
			</Typography>
			<Stack direction="row" spacing={1} className="items-center">
				<Typography variant="body2" color="text.secondary" className="flex-1">
					{running
						? t("components.AddModal.cloudScan.scanning", "正在扫描云端…")
						: lastScanAt
							? t(
									"components.AddModal.cloudScan.lastScan",
									"上次扫描：{{time}}",
									{
										time: new Date(lastScanAt).toLocaleTimeString(),
									},
								)
							: null}
				</Typography>
				{running ? (
					<Button size="small" onClick={cancel}>
						{t("components.AddModal.cloudScan.cancel", "停止")}
					</Button>
				) : (
					<>
						<Button size="small" onClick={() => setImportOpen(true)}>
							{t("components.AddModal.cloudScan.import", "导入建议")}
						</Button>
						<Button size="small" onClick={() => void scan()}>
							{t("components.AddModal.cloudScan.start", "立即扫描")}
						</Button>
					</>
				)}
			</Stack>
			<Dialog
				open={importOpen}
				onClose={() => setImportOpen(false)}
				fullWidth
				maxWidth="sm"
			>
				<DialogTitle>
					{t("components.AddModal.cloudScan.importTitle", "导入套用建议")}
				</DialogTitle>
				<DialogContent>
					<Typography variant="body2" color="text.secondary" className="mb-2">
						{t(
							"components.AddModal.cloudScan.importHint",
							"贴上建议清单（JSON），会逐笔用和「应用」相同的方式抓取资料与封面。已不在待确认清单中的会自动略过。",
						)}
					</Typography>
					<TextField
						multiline
						minRows={6}
						maxRows={14}
						fullWidth
						value={importText}
						onChange={(event) => setImportText(event.target.value)}
						error={Boolean(importText.trim()) && !parsedDecisions}
						helperText={
							importText.trim()
								? parsedDecisions
									? t(
											"components.AddModal.cloudScan.importCount",
											"共 {{count}} 笔",
											{ count: parsedDecisions.length },
										)
									: t(
											"components.AddModal.cloudScan.importInvalid",
											"格式不正确",
										)
								: undefined
						}
					/>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setImportOpen(false)}>
						{t("components.AddModal.cancel", "取消")}
					</Button>
					<Button
						variant="contained"
						disabled={!parsedDecisions?.length}
						onClick={() => void handleImport()}
					>
						{t("components.AddModal.cloudScan.importApply", "开始套用")}
					</Button>
				</DialogActions>
			</Dialog>
			{!running && importResult ? (
				<Typography color="success.main">
					{t(
						"components.AddModal.cloudScan.importResult",
						"已应用 {{applied}} 笔，略过 {{skipped}} 笔，失败 {{failed}} 笔。",
						{ ...importResult },
					)}
				</Typography>
			) : null}
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
			{pending.length === 0 && !running && (
				<Typography variant="body2" color="text.secondary">
					{t("components.AddModal.cloudScan.empty", "目前没有需要确认的游戏。")}
				</Typography>
			)}
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
