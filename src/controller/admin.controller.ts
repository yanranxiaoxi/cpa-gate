import type { IContext } from '../utils/interface';
import { createHash, timingSafeEqual } from 'node:crypto';
import { CONFIG } from '../config/config';
import { LockTimeoutError, UpstreamError } from '../service/errors';
import { pruneKeys } from '../service/keys';
import { sendJson } from '../utils/respond';
import { Controller } from './controller';

/** 定长比较，长度不同也保持常量时间 */
function safeEqual(expected: string, provided: string): boolean {
	const a = createHash('sha256').update(expected).digest();
	const b = createHash('sha256').update(provided).digest();
	return timingSafeEqual(a, b);
}

/** 从请求头取管理员 Key：X-Admin-Key 优先，其次 Authorization: Bearer */
function providedAdminKey(ctx: IContext): string {
	const header = ctx.req.headers['x-admin-key'];
	if (typeof header === 'string' && header) {
		return header;
	}
	const authorization = ctx.req.headers.authorization;
	if (typeof authorization === 'string' && authorization.slice(0, 7).toLowerCase() === 'bearer ') {
		return authorization.slice(7).trim();
	}
	return '';
}

/**
 * 管理接口：清理已失效的用户 Key
 */
class Admin extends Controller {
	/** POST /api/admin/keys/prune */
	public async prune(ctx: IContext) {
		// 未配置视为未启用，减少攻击面
		if (!CONFIG.admin.pruneKey) {
			sendJson(ctx.res, 404, { error: 'not_found' });
			return;
		}
		if (!safeEqual(CONFIG.admin.pruneKey, providedAdminKey(ctx))) {
			sendJson(ctx.res, 401, { error: 'unauthorized' });
			return;
		}

		const url = new URL(ctx.req.url ?? '/', 'http://localhost');
		const dryRun = url.searchParams.get('dryRun') === 'true';

		try {
			const report = await pruneKeys(dryRun);
			sendJson(ctx.res, 200, report);
		}
		catch (ex) {
			if (ex instanceof LockTimeoutError) {
				sendJson(ctx.res, 409, { error: 'busy' });
				return;
			}
			if (ex instanceof UpstreamError) {
				ctx.logger.error('prune failed', ex);
				sendJson(ctx.res, 502, { error: ex.code });
				return;
			}
			ctx.logger.error('prune failed', ex);
			sendJson(ctx.res, 500, { error: 'internal_error' });
		}
	}
}

const admin = new Admin();
export default admin;
