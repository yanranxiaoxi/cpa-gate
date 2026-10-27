import type { Identity, OidcParams } from '../service/oidc';
import type { IContext } from '../utils/interface';
import { CONFIG } from '../config/config';
import { isEligible } from '../service/keycloak';
import { ensureUserKey, isValidUserId } from '../service/keys';
import { buildAuthorizationUrlFromParams, buildEndSessionUrlForLogout, exchangeCodeAtCallback, fetchIdentity, generateOidcParams, oidcEnabled } from '../service/oidc';
import { parseCookies } from '../utils/cookie';
import { isSameOriginRequest } from '../utils/csrf';
import { clearCookie, getSessionUser, redirect, sendJson, setCookie } from '../utils/respond';
import { signSession, signTransientToken, verifyTransientToken } from '../utils/session';
import { Controller } from './controller';

/** OIDC 登录状态临时 Cookie 名（state/code_verifier） */
const OIDC_STATE_COOKIE = 'cpa_oidc_state';
/** 状态 Cookie 有效期（秒） */
const OIDC_STATE_TTL = 600;
/** 登录被拒后短暂保存身份的 Cookie 名 */
const DENIED_COOKIE = 'cpa_login_denied';
/** 被拒信息有效期（秒）：只用于在首页展示自己的用户 ID */
const DENIED_TTL = 300;

/**
 * 认证控制器：OIDC 登录状态、登录、回调、登出
 */
class Auth extends Controller {
	/** GET /api/auth/status */
	public async status(ctx: IContext) {
		const user = getSessionUser(ctx.user);
		const enabled = oidcEnabled();
		ctx.res.setHeader('Cache-Control', 'no-store');

		// 登录被拒时把身份暂存在签名 Cookie 中，由前端展示给用户自己（含 UUID）。
		// Cookie 在 5 分钟后过期，重新发起登录或登录成功时清除；期间刷新页面仍能看到。
		const cookies = parseCookies(ctx.req.headers.cookie);
		const deniedToken = cookies[DENIED_COOKIE];
		let denied: Record<string, string> | undefined;
		if (deniedToken && !user) {
			const payload = await verifyTransientToken(deniedToken);
			if (payload && typeof payload.userId === 'string') {
				denied = {
					reason: typeof payload.reason === 'string' ? payload.reason : 'forbidden',
					userId: payload.userId,
					...(typeof payload.username === 'string' && payload.username ? { username: payload.username } : {}),
				};
			}
		}

		sendJson(ctx.res, 200, {
			loggedIn: Boolean(user),
			authEnabled: enabled,
			// 未启用登录时不暴露提供商名称；未配置时前端使用本地化默认文案
			...(enabled && CONFIG.oidc.providerName ? { providerName: CONFIG.oidc.providerName } : {}),
			// 未配置时前端把用户名渲染为纯文本
			...(enabled && CONFIG.oidc.accountUrl ? { accountUrl: CONFIG.oidc.accountUrl } : {}),
			user: user ? { username: user.username } : null,
			...(denied ? { denied } : {}),
		});
	}

	/** GET /api/auth/login：302 跳转 IdP */
	public async login(ctx: IContext) {
		if (!oidcEnabled()) {
			sendJson(ctx.res, 503, { error: 'OIDC is not configured on this server' });
			return;
		}
		try {
			// 新的登录尝试开始，旧的被拒提示随之失效
			clearCookie(ctx.res, DENIED_COOKIE);
			const params = await generateOidcParams();
			const authorizationUrl = await buildAuthorizationUrlFromParams(params);
			const token = await signTransientToken({ ...params }, OIDC_STATE_TTL);
			setCookie(ctx.res, OIDC_STATE_COOKIE, token, { maxAge: OIDC_STATE_TTL });
			redirect(ctx.res, authorizationUrl);
		}
		catch (ex) {
			ctx.logger.error('oidc login failed', ex);
			sendJson(ctx.res, 500, { error: 'Failed to start OIDC login' });
		}
	}

	/** GET /api/auth/callback：IdP 回调，校验资格后换取会话 */
	public async callback(ctx: IContext) {
		const res = ctx.res;
		const fail = async (reason: 'failed' | 'forbidden' | 'unavailable', identity?: Identity) => {
			clearCookie(res, OIDC_STATE_COOKIE);
			if (identity && isValidUserId(identity.userId)) {
				try {
					const token = await signTransientToken({
						userId: identity.userId,
						username: identity.username,
						reason,
					}, DENIED_TTL);
					setCookie(res, DENIED_COOKIE, token, { maxAge: DENIED_TTL });
				}
				catch (ex) {
					// 签名失败不影响跳转，只是不展示用户 ID
					ctx.logger.warn(`failed to store denied identity: ${(ex as Error)?.message ?? ex}`);
				}
			}
			redirect(res, `/?login=${reason}`);
		};

		const cookies = parseCookies(ctx.req.headers.cookie);
		const storedToken = cookies[OIDC_STATE_COOKIE];
		const stored = storedToken ? await verifyTransientToken(storedToken) : null;
		if (!stored || typeof stored.state !== 'string' || typeof stored.codeVerifier !== 'string') {
			await fail('failed');
			return;
		}

		try {
			const currentUrl = new URL(ctx.req.url ?? '/', CONFIG.oidc.redirectUri);
			const params: OidcParams = {
				state: stored.state,
				codeVerifier: stored.codeVerifier,
				codeChallenge: '',
			};
			const tokens = await exchangeCodeAtCallback(currentUrl, params);
			const identity = await fetchIdentity(tokens);

			if (!isValidUserId(identity.userId)) {
				ctx.logger.error(`invalid userId for key prefix: ${identity.userId || '(empty)'}`);
				await fail('forbidden', identity);
				return;
			}

			const eligibility = await isEligible(identity.userId);
			if (eligibility === 'unavailable') {
				ctx.logger.warn(`eligibility check unavailable for user ${identity.userId}`);
				await fail('unavailable', identity);
				return;
			}
			if (eligibility !== 'eligible') {
				ctx.logger.info(`login rejected for user ${identity.userId}: ${eligibility}`);
				await fail('forbidden', identity);
				return;
			}

			const sessionToken = await signSession({ sub: identity.userId, username: identity.username });
			setCookie(res, CONFIG.session.cookieName, sessionToken, { maxAge: CONFIG.session.ttl });
			clearCookie(res, OIDC_STATE_COOKIE);
			clearCookie(res, DENIED_COOKIE);

			// Key 创建失败不阻断登录：页面会展示错误并允许重试
			try {
				await ensureUserKey(identity.userId);
			}
			catch (ex) {
				ctx.logger.error('failed to issue key on login', ex);
			}

			redirect(res, '/');
		}
		catch (ex) {
			ctx.logger.error('oidc callback failed', ex);
			await fail('failed');
		}
	}

	/** GET /api/auth/logout：清除本地会话；?sso=1 时继续跳 IdP 登出（RP-initiated logout） */
	public async logout(ctx: IContext) {
		// 登出是 GET：跨站顶层导航同样会携带 SameSite=Lax 的会话 Cookie，
		// 因此必须确认来源同源，避免任意站点用一个链接把用户踢下线
		if (!isSameOriginRequest(ctx)) {
			ctx.logger.warn('rejected cross-site logout request');
			sendJson(ctx.res, 403, { error: 'cross_site_request_blocked' });
			return;
		}

		clearCookie(ctx.res, CONFIG.session.cookieName);

		const url = new URL(ctx.req.url ?? '/', 'http://localhost');
		if (url.searchParams.get('sso') === '1' && oidcEnabled()) {
			try {
				const endSessionUrl = await buildEndSessionUrlForLogout();
				if (endSessionUrl) {
					redirect(ctx.res, endSessionUrl);
					return;
				}
			}
			catch (ex) {
				// IdP discovery 失败：本地会话已清除，退化为直接回首页而非报错
				ctx.logger.error('oidc end session failed', ex);
			}
		}

		redirect(ctx.res, '/');
	}
}

const auth = new Auth();
export default auth;
