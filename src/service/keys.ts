import { randomBytes } from 'node:crypto';
import logger from '../utils/logger';
import { deleteKey, ensureKey, listKeys } from './cpa';
import { LockTimeoutError, RotateIncompleteError } from './errors';
import { isEligible } from './keycloak';

/** 本服务创建并管理的 Key：<userId>.<32 字节 base64url> */
const MANAGED_KEY_RE = /^([\w-]{1,128})\.([\w-]{43})$/;
/** 用户 ID 只允许出现在 Key 前缀中，不能包含分隔符 */
const USER_ID_RE = /^[\w-]{1,128}$/;
/** 单个 Key 操作最长等待时间（清理接口并发时返回 409） */
const LOCK_TIMEOUT_MS = 30_000;

export interface ParsedKey {
	userId: string;
	random: string;
}

export type PruneReason = 'user_not_found' | 'user_disabled' | 'not_allowed';

export interface PruneRemoved {
	userId: string;
	key: string;
	reason: PruneReason;
}

export interface PruneError {
	userId: string;
	reason: string;
}

export interface PruneReport {
	ok: true;
	dryRun: boolean;
	scannedKeys: number;
	managedKeys: number;
	unmanagedKeys: number;
	checkedUsers: number;
	validKeys: number;
	removedKeys: number;
	removed: PruneRemoved[];
	errors: PruneError[];
}

/**
 * 串行化 Key 写操作
 *
 * 无数据库时，并发 ensure/rotate/prune 会互相覆盖 Key 列表，必须在进程内排队。
 * 多副本部署时仍需依赖 CLIProxyAPI 的原子接口。
 */
class Mutex {
	private locked = false;
	private readonly waiters: Array<{ grant: () => void; timer: ReturnType<typeof setTimeout> }> = [];

	public async acquire(timeoutMs = LOCK_TIMEOUT_MS): Promise<() => void> {
		if (!this.locked) {
			this.locked = true;
			return this.releaser();
		}
		return await new Promise((resolve, reject) => {
			const waiter = {
				grant: () => {
					clearTimeout(waiter.timer);
					resolve(this.releaser());
				},
				timer: setTimeout(() => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) {
						this.waiters.splice(index, 1);
					}
					reject(new LockTimeoutError());
				}, timeoutMs),
			};
			this.waiters.push(waiter);
		});
	}

	private releaser(): () => void {
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const next = this.waiters.shift();
			if (next) {
				next.grant();
			}
			else {
				this.locked = false;
			}
		};
	}
}

const mutex = new Mutex();

/** 校验用户 ID 是否可作为 Key 前缀 */
export function isValidUserId(userId: string): boolean {
	return USER_ID_RE.test(userId);
}

/** 解析本服务管理的 Key；非本服务 Key 返回 null */
export function parseManagedKey(key: string): ParsedKey | null {
	const match = MANAGED_KEY_RE.exec(key);
	return match ? { userId: match[1], random: match[2] } : null;
}

/** 生成新 Key */
export function buildKey(userId: string): string {
	return `${userId}.${randomBytes(32).toString('base64url')}`;
}

/** 日志/响应中的 Key 脱敏：保留前 8 位与后 4 位 */
export function maskKey(key: string): string {
	return key.length <= 12 ? '***' : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/**
 * 查找用户当前的 Key
 *
 * CLIProxyAPI 把新 Key 追加到列表末尾，因此从后往前找即取最新的一枚：
 * 轮换不完整（新 Key 已建、旧 Key 未删完）时也不会把旧 Key 展示给用户。
 */
export async function findUserKey(userId: string): Promise<string | null> {
	const keys = await listKeys();
	for (let i = keys.length - 1; i >= 0; i--) {
		if (parseManagedKey(keys[i])?.userId === userId) {
			return keys[i];
		}
	}
	return null;
}

/**
 * 确保用户存在一枚 Key（已存在则直接复用）
 */
export async function ensureUserKey(userId: string): Promise<string> {
	const release = await mutex.acquire();
	try {
		const existing = await findUserKey(userId);
		if (existing) {
			return existing;
		}
		const key = buildKey(userId);
		await ensureKey(key);
		logger.info(`issued key for user ${userId}: ${maskKey(key)}`);
		return key;
	}
	finally {
		release();
	}
}

/**
 * 轮换用户 Key
 *
 * 顺序：先幂等新增新 Key，成功后再删除所有旧 Key。
 * 第 4 步失败时新 Key 已可用，抛出 RotateIncompleteError 让调用方把新密钥返回给用户。
 */
export async function rotateUserKey(userId: string): Promise<string> {
	const release = await mutex.acquire();
	try {
		const next = buildKey(userId);
		await ensureKey(next);
		try {
			const keys = await listKeys();
			for (const key of keys) {
				if (key !== next && parseManagedKey(key)?.userId === userId) {
					await deleteKey(key);
				}
			}
		}
		catch (ex) {
			logger.error(`rotate incomplete for user ${userId}: ${(ex as Error)?.message ?? ex}`);
			throw new RotateIncompleteError(next, ex);
		}
		logger.info(`rotated key for user ${userId}: ${maskKey(next)}`);
		return next;
	}
	finally {
		release();
	}
}

/**
 * 扫描并清理失效 Key
 *
 * - 只处理符合本服务格式的 Key，其它 Key 原样保留。
 * - Keycloak 无法确认时保留 Key（fail safe）。
 */
export async function pruneKeys(dryRun: boolean): Promise<PruneReport> {
	const release = await mutex.acquire();
	try {
		const keys = await listKeys();
		const byUser = new Map<string, string[]>();
		let unmanagedKeys = 0;

		for (const key of keys) {
			const parsed = parseManagedKey(key);
			if (!parsed) {
				unmanagedKeys++;
				continue;
			}
			const list = byUser.get(parsed.userId);
			if (list) {
				list.push(key);
			}
			else {
				byUser.set(parsed.userId, [key]);
			}
		}

		const removed: PruneRemoved[] = [];
		const errors: PruneError[] = [];
		let validKeys = 0;

		for (const [userId, userKeys] of byUser) {
			const eligibility = await isEligible(userId);
			if (eligibility === 'eligible') {
				validKeys += userKeys.length;
				continue;
			}
			if (eligibility === 'unavailable') {
				errors.push({ userId, reason: 'keycloak_unavailable' });
				continue;
			}
			for (const key of userKeys) {
				if (!dryRun) {
					try {
						await deleteKey(key);
					}
					catch (ex) {
						logger.error(`failed to delete key ${maskKey(key)}: ${(ex as Error)?.message ?? ex}`);
						errors.push({ userId, reason: 'cpa_delete_failed' });
						continue;
					}
				}
				removed.push({ userId, key: maskKey(key), reason: eligibility });
			}
			logger.info(`pruned ${userKeys.length} key(s) for user ${userId}: ${eligibility}${dryRun ? ' (dry run)' : ''}`);
		}

		return {
			ok: true,
			dryRun,
			scannedKeys: keys.length,
			managedKeys: keys.length - unmanagedKeys,
			unmanagedKeys,
			checkedUsers: byUser.size,
			validKeys,
			removedKeys: removed.length,
			removed,
			errors,
		};
	}
	finally {
		release();
	}
}
