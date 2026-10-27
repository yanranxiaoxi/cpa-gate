import process from 'node:process';
import { CONFIG } from '../config/config';
import logger from '../utils/logger';
import { pruneKeys } from './keys';

/** 首次执行前的延迟：等待服务完成启动，并与其它副本错开 */
const FIRST_RUN_DELAY_MS = 45_000;
/** 首次执行的随机抖动上限：多副本在同一次部署中启动时避免同秒打 Keycloak */
const FIRST_RUN_JITTER_MS = 15_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

/**
 * 执行一轮清理并记录摘要
 *
 * Keycloak 不可用时 `pruneKeys` 会保留 Key（fail safe），
 * 因此这里必须把 errors 打成错误日志：否则撤销能力会静默失效。
 */
async function runOnce(): Promise<void> {
	try {
		const report = await pruneKeys(false);
		logger.info(
			`[prune] scanned=${report.scannedKeys} managed=${report.managedKeys} `
			+ `valid=${report.validKeys} removed=${report.removedKeys} errors=${report.errors.length}`,
		);
		if (report.errors.length > 0) {
			// 只打印前若干条，避免超长用户列表刷屏
			const sample = report.errors.slice(0, 10);
			logger.error(
				`[prune] ${report.errors.length} user(s) could not be verified, their keys were kept: ${JSON.stringify(sample)}`,
			);
		}
	}
	catch (ex) {
		logger.error(`[prune] run failed: ${(ex as Error)?.message ?? ex}`);
	}
}

/**
 * 排下一轮（用递归 setTimeout 而非 setInterval）
 *
 * 一轮耗时超过间隔时，setInterval 会让任务堆积，递归方式总是从本轮结束后重新计时。
 */
function scheduleNext(delayMs: number): void {
	timer = setTimeout(async () => {
		await runOnce();
		if (!stopped) {
			scheduleNext(CONFIG.prune.intervalSeconds * 1000);
		}
	}, delayMs);
	// 定时器不阻止进程退出；服务本身常驻，这里只影响优雅退出的等待时间
	timer.unref?.();
}

/**
 * 启动自动清理调度
 *
 * 关闭后不会有任何撤销动作，因此关闭时打印警告而不是静默返回。
 */
export function startPruneScheduler(): void {
	const seconds = CONFIG.prune.intervalSeconds;
	if (seconds <= 0) {
		logger.warn('[prune] disabled by PRUNE_INTERVAL=0: revoked users keep their keys until removed by hand');
		return;
	}

	const firstDelay = FIRST_RUN_DELAY_MS + Math.floor(Math.random() * FIRST_RUN_JITTER_MS);
	logger.info(`[prune] every ${seconds}s, first run in ${Math.round(firstDelay / 1000)}s`);
	scheduleNext(firstDelay);
}

/** 停止调度（优雅退出与测试用） */
export function stopPruneScheduler(): void {
	stopped = true;
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
}

// 容器停止时避免把定时器留成悬挂状态
process.once('SIGTERM', stopPruneScheduler);
process.once('SIGINT', stopPruneScheduler);
