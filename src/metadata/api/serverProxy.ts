/**
 * @file 網頁版的中繼資料請求
 * @description 透過 reina-server 的 /api/metadata/request 代為連線外部來源。
 * TeleDrive JWT 只送本站，不會被轉送到上游。
 */

import { authenticatedFetch } from "@/services/web/http";
import {
	ApiRateLimitError,
	AppError,
	HttpResponseError,
	toError,
} from "@/utils/errors";
import {
	getApiRateLimitErrorMessage,
	type TauriHttpOptions,
	type TauriHttpResponse,
} from "./http";
import { type ApiRateLimitSource, getApiRateLimitPolicy } from "./rateLimit";

interface ProxyReply {
	status: number;
	headers: [string, string][];
	body: string;
}

function parseRetryAfterMs(headers: [string, string][]): number | undefined {
	const raw = headers.find(
		([name]) => name.toLowerCase() === "retry-after",
	)?.[1];
	if (!raw) return undefined;

	const seconds = Number(raw);
	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1000);
	}
	const at = Date.parse(raw);
	return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export async function requestViaServerProxy<T>(
	method: "GET" | "POST" | "PATCH" | "PUT",
	fullUrl: string,
	options: TauriHttpOptions | undefined,
	data: unknown,
	source: ApiRateLimitSource | undefined,
): Promise<TauriHttpResponse<T>> {
	const response = await authenticatedFetch("/game/api/metadata/request", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: options?.signal,
		body: JSON.stringify({
			source: source ?? null,
			method,
			url: fullUrl,
			headers: {
				...(method === "GET" ? {} : { "Content-Type": "application/json" }),
				...options?.headers,
			},
			body:
				method === "GET" || data === undefined ? null : JSON.stringify(data),
		}),
	});

	if (!response.ok) {
		throw new AppError({
			code: "metadata_proxy_failed",
			message: `Metadata proxy failed: ${response.status} ${method} ${fullUrl}`,
		});
	}

	const reply = (await response.json()) as ProxyReply;

	if (reply.status === 429 && source) {
		const retryAfterMs = parseRetryAfterMs(reply.headers);
		throw new ApiRateLimitError({
			source,
			message: getApiRateLimitErrorMessage(source),
			retryAfterMs,
			backoffUntil: Date.now() + (retryAfterMs ?? 0),
			fatal: getApiRateLimitPolicy(source).stopOn429,
		});
	}

	if (reply.status < 200 || reply.status >= 300) {
		throw new HttpResponseError({
			method,
			url: fullUrl,
			status: reply.status,
			statusText: "",
		});
	}

	let parsed: T;
	if (options?.responseType === "text") {
		parsed = reply.body as T;
	} else if (!reply.body) {
		parsed = null as T;
	} else {
		try {
			parsed = JSON.parse(reply.body) as T;
		} catch (error) {
			throw new AppError({
				code: "http_response_parse_failed",
				message: `Failed to parse HTTP response: ${method} ${fullUrl}`,
				cause: toError(error, "Failed to parse HTTP response"),
			});
		}
	}

	return {
		data: parsed,
		status: reply.status,
		statusText: "",
		headers: reply.headers,
	};
}
