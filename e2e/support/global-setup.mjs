import { BASE_URL_ENV, startTestEnv, stopTestEnv } from "./test-env.mjs";

export default async function globalSetup() {
	const { baseUrl } = await startTestEnv();
	// worker 在 globalSetup 之后才启动，会继承这个环境变量
	process.env[BASE_URL_ENV] = baseUrl;
	return async () => {
		await stopTestEnv();
	};
}
