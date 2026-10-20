import type { AuthStatus, PortalData } from './types';
import { ApiError } from './types';

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
