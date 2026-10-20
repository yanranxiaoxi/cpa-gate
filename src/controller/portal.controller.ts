import type { IContext } from '../utils/interface';
import type { SessionUser } from '../utils/session';
import { CONFIG } from '../config/config';
import { listModels } from '../service/cpa';
import { LockTimeoutError, RotateIncompleteError } from '../service/errors';
import { isEligible } from '../service/keycloak';
import { ensureUserKey, findUserKey, rotateUserKey } from '../service/keys';
import { getSessionUser, sendJson } from '../utils/respond';
import { Controller } from './controller';

/** 取当前会话用户；未登录时写 401 并返回 null */
function requireUser(ctx: IContext): SessionUser | null {
	const user = getSessionUser(ctx.user);
	if (!user) {
		sendJson(ctx.res, 401, { error: 'unauthorized' });
		return null;
	}
	return user;
}

/** 前端展示的调用基址 */
function callUrl(): string {
	return `${CONFIG.cpa.apiBaseUrl}/v1`;
}

/**
 * 页面数据控制器：调用地址、个人 Token、可用模型
 */
class Portal extends Controller {
	/** GET /api/config：前端公共配置 */
	public async config(ctx: IContext) {
		ctx.res.setHeader('Cache-Control', 'public, max-age=3600');
		sendJson(ctx.res, 200, { callUrl: callUrl() });
	}

	/** GET /api/portal */
	public async portal(ctx: IContext) {
		const user = requireUser(ctx);
		if (!user) {
			return;
		}
		ctx.res.setHeader('Cache-Control', 'no-store');

		let token: string | null = null;
		let tokenError: string | undefined;
		let eligible = true;

		try {
			token = await findUserKey(user.sub);
		}
		catch (ex) {
			ctx.logger.error('failed to read keys', ex);
			tokenError = 'cpa_unavailable';
		}

		// Key 不存在时才复核资格：已被清理的用户不能靠刷新页面重新拿到 Key
		if (!token && !tokenError) {
			const status = await isEligible(user.sub);
			if (status === 'eligible') {
				try {
					token = await ensureUserKey(user.sub);
				}
				catch (ex) {
					ctx.logger.error('failed to ensure key', ex);
					tokenError = 'cpa_unavailable';
				}
			}
			else if (status === 'unavailable') {
				tokenError = 'verification_unavailable';
			}
			else {
				eligible = false;
			}
		}

		const models = token ? await listModels(token) : { models: [], unavailable: true };

		sendJson(ctx.res, 200, {
			eligible,
			// 返回用户自己的 ID，便于失去资格后向管理员核对
			userId: user.sub,
			callUrl: callUrl(),
			token,
			...(tokenError ? { tokenError } : {}),
			models: models.models,
			modelsUnavailable: models.unavailable,
		});
	}

	/** POST /api/token/rotate */
	public async rotate(ctx: IContext) {
		const user = requireUser(ctx);
		if (!user) {
			return;
		}
		ctx.res.setHeader('Cache-Control', 'no-store');

		const status = await isEligible(user.sub);
		if (status === 'unavailable') {
			sendJson(ctx.res, 503, { error: 'verification_unavailable' });
			return;
		}
		if (status !== 'eligible') {
			sendJson(ctx.res, 403, { error: 'not_eligible' });
			return;
		}

		try {
			const token = await rotateUserKey(user.sub);
			sendJson(ctx.res, 200, { token });
		}
		catch (ex) {
			if (ex instanceof RotateIncompleteError) {
				// 新 Key 已经可用，旧 Key 清理不完整
				sendJson(ctx.res, 502, { error: 'rotate_incomplete', token: ex.token });
				return;
			}
			if (ex instanceof LockTimeoutError) {
				sendJson(ctx.res, 409, { error: 'busy' });
				return;
			}
			ctx.logger.error('rotate failed', ex);
			sendJson(ctx.res, 502, { error: 'cpa_unavailable' });
		}
	}
}

const portal = new Portal();
export default portal;
