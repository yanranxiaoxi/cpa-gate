import type { AppConfig, AuthStatus, PortalData } from './types';
import { getLang, t } from './i18n';
import { ApiError } from './types';

let siteConfig: AppConfig = { callUrl: '' };
let statusCache: AuthStatus = { loggedIn: false, authEnabled: false, user: null };
type AuthListener = (status: AuthStatus) => void;
const authListeners: AuthListener[] = [];

/** 订阅登录态变化（会话过期自动登出后，界面据此刷新用户区） */
export function onAuthChange(cb: AuthListener): void {
	authListeners.push(cb);
}

/** 内部：登录态变化时通知订阅者 */
function notifyAuthChange(status: AuthStatus): void {
	authListeners.forEach(cb => cb(status));
}

/**
 * 请求同源 JSON 接口
 */
async function sameOriginJson<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	let data: unknown = null;
	try {
		data = await res.json();
	}
	catch {
		// 非 JSON 响应
	}
	if (!res.ok) {
		const err = data as { error?: string } | null;
		throw new ApiError(err?.error || `HTTP ${res.status}`, res.status);
	}
	return data as T;
}

/**
 * 加载站点配置（调用地址与可选的品牌文案）
 *
 * 失败时保留空值，前端回退到语言包默认文案，不影响登录状态渲染。
 */
export async function loadConfig(): Promise<AppConfig> {
	try {
		siteConfig = await sameOriginJson<AppConfig>('/api/config');
	}
	catch {
		// 使用默认文案
	}
	return siteConfig;
}

/** 读取已加载的站点配置 */
export function getSiteConfig(): AppConfig {
	return siteConfig;
}

/** 获取当前语言下的站点标题（SITE_TITLE_* 优先，否则为默认 appName） */
export function getSiteTitle(): string {
	const site = siteConfig.site?.[getLang()];
	return site?.title || t('appName');
}

/** 加载登录状态 */
export async function loadAuthStatus(): Promise<AuthStatus> {
	statusCache = await sameOriginJson<AuthStatus>('/api/auth/status');
	notifyAuthChange(statusCache);
	return statusCache;
}

/** 加载页面数据（调用地址、Token、模型） */
export async function loadPortal(): Promise<PortalData> {
	try {
		return await sameOriginJson<PortalData>('/api/portal');
	}
	catch (ex) {
		if (ex instanceof ApiError && ex.status === 401) {
			statusCache = { loggedIn: false, authEnabled: statusCache.authEnabled, user: null };
			notifyAuthChange(statusCache);
		}
		throw ex;
	}
}

/**
 * 轮换 Token
 *
 * 502 rotate_incomplete 表示新 Token 已生效但旧 Token 未删干净：
 * 仍然返回新 Token，让用户先拿到可用的凭据。
 */
export async function rotateToken(): Promise<{ token: string; incomplete: boolean }> {
	const res = await fetch('/api/token/rotate', { method: 'POST' });
	const data = (await res.json().catch(() => null)) as { token?: unknown; error?: unknown } | null;
	const token = typeof data?.token === 'string' ? data.token : '';
	if (res.status === 502 && data?.error === 'rotate_incomplete' && token) {
		return { token, incomplete: true };
	}
	if (!res.ok || !token) {
		const error = typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`;
		throw new ApiError(error, res.status);
	}
	return { token, incomplete: false };
}
