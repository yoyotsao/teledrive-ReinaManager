import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useState } from "react";
import { useObjectUrl } from "@/hooks/common/useObjectUrl";

/**
 * 图片预览 Hook。
 * 桌面版仍用 convertFileSrc；网页版 File 透过共用 useObjectUrl 管理生命周期。
 */
export const useImagePreview = () => {
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const [pathPreviewUrl, setPathPreviewUrl] = useState<string | null>(null);
	const filePreviewUrl = useObjectUrl(selectedFile);
	const previewUrl = selectedFile ? (filePreviewUrl ?? null) : pathPreviewUrl;

	const cleanup = useCallback(() => {
		setPathPreviewUrl(null);
		setSelectedPath(null);
		setSelectedFile(null);
	}, []);

	const selectImage = useCallback((path: string) => {
		setSelectedFile(null);
		setSelectedPath(path);
		setPathPreviewUrl(convertFileSrc(path));
	}, []);

	const selectFile = useCallback((file: File) => {
		setSelectedPath(null);
		setPathPreviewUrl(null);
		setSelectedFile(file);
	}, []);

	return {
		selectedPath,
		selectedFile,
		previewUrl,
		selectImage,
		selectFile,
		cleanup,
	};
};
