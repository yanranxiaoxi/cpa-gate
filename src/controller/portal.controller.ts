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

/** 去掉空字段，避免前端把空串当作显式配置 */
function compactSiteText(text: { title: string; subtitle: string; description: string }) {
	return {
		...(text.title ? { title: text.title } : {}),
		...(text.subtitle ? { subtitle: text.subtitle } : {}),
		...(text.description ? { description: text.description } : {}),
	};
}

/**
 * 各协议的调用地址
 *
 * CLIProxyAPI 在同一端口上暴露多套兼容接口，路径前缀各不相同：
 * - OpenAI 兼容：`/v1`（chat/completions、responses、models）
 * - Anthropic 兼容：站点根（Claude Code 自己追加 `/v1/messages`）
 * - Gemini 兼容：`/v1beta`（Gemini CLI 自己追加 `/v1beta/models/...`）
 *
 * 因此 Anthropic 那一项不能再带 `/v1`，否则会变成 `/v1/v1/messages`。
 *
 * 每项同时给出：
 * - `base`：客户端环境变量应填的值（页面默认展示）
 * - `full`：一个可直接调用的完整接口地址（页面「完整 URL」开关打开后展示）
 */
function endpoints() {
	const base = CONFIG.cpa.apiBaseUrl;
	return {
		/** OpenAI 兼容（OpenAI SDK / Codex CLI） */
		openai: {
			base: `${base}/v1`,
			full: `${base}/v1/chat/completions`,
		},
		/** Anthropic 兼容（Claude Code 的 ANTHROPIC_BASE_URL） */
		anthropic: {
			base,
			full: `${base}/v1/messages`,
		},
		/** Gemini 兼容（Gemini CLI 的 GOOGLE_GEMINI_BASE_URL） */
		gemini: {
			base: `${base}/v1beta`,
			full: `${base}/v1beta/models/{model}:generateContent`,
		},
	};
}

/** 前端展示的主调用地址（OpenAI 兼容） */
function callUrl(): string {
	return endpoints().openai.base;
}

/**
 * 页面数据控制器：调用地址、个人 Token、可用模型
 */
class Portal extends Controller {
	/** GET /api/config：前端公共配置 */
	public async config(ctx: IContext) {
		ctx.res.setHeader('Cache-Control', 'public, max-age=3600');
		sendJson(ctx.res, 200, {
			callUrl: callUrl(),
			endpoints: endpoints(),
			// 每个语言只下发配置过的字段，未配置时前端回退到该语言的默认文案
			site: {
				'zh-Hans': compactSiteText(CONFIG.site.zhHans),
				'en': compactSiteText(CONFIG.site.en),
			},
		});
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
			endpoints: endpoints(),
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
