import { CONFIG } from '../config/config';
import logger from '../utils/logger';
import { UpstreamError } from './errors';

/** 访问资格判定结果 */
export type Eligibility = 'eligible' | 'user_not_found' | 'user_disabled' | 'not_allowed' | 'unavailable';

interface GroupInfo {
	name: string;
	path: string;
}

interface UserStatus {
	exists: boolean;
	enabled: boolean;
	username: string;
	email: string;
}

interface AdminToken {
	value: string;
	expiresAt: number;
}

let cachedToken: AdminToken | null = null;

/**
 * 获取 Keycloak 管理员 Token（client_credentials）
 *
 * 密码模式需要真实管理员账号，服务账号更安全；缓存到过期前 30 秒。
 */
async function getAdminToken(force = false): Promise<string> {
	if (!force && cachedToken && cachedToken.expiresAt > Date.now()) {
		return cachedToken.value;
	}
	const url = `${CONFIG.keycloak.baseUrl}/realms/${encodeURIComponent(CONFIG.keycloak.realm)}/protocol/openid-connect/token`;
	const body = new URLSearchParams({
		grant_type: 'client_credentials',
		client_id: CONFIG.keycloak.adminClientId,
		client_secret: CONFIG.keycloak.adminClientSecret,
	});

	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
			signal: AbortSignal.timeout(CONFIG.keycloak.timeoutMs),
		});
	}
	catch (ex) {
		throw new UpstreamError('keycloak_unavailable', `admin token request failed: ${(ex as Error)?.message ?? ex}`);
	}
	if (!res.ok) {
		throw new UpstreamError('keycloak_unavailable', `admin token request returned ${res.status}`, res.status);
	}
	const payload = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
	if (!payload || typeof payload.access_token !== 'string') {
		throw new UpstreamError('keycloak_unavailable', 'admin token response is invalid');
	}
	const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 60;
	cachedToken = {
		value: payload.access_token,
		expiresAt: Date.now() + Math.max(30, expiresIn - 30) * 1000,
	};
	return cachedToken.value;
}

/** 调用 Admin API；401 时强制刷新一次 Token */
async function adminRequest(path: string, retry = true): Promise<Response> {
	const token = await getAdminToken();
	const url = `${CONFIG.keycloak.baseUrl}/admin/realms/${encodeURIComponent(CONFIG.keycloak.realm)}${path}`;
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(CONFIG.keycloak.timeoutMs),
		});
	}
	catch (ex) {
		throw new UpstreamError('keycloak_unavailable', `GET ${path} failed: ${(ex as Error)?.message ?? ex}`);
	}
	if (res.status === 401 && retry) {
		cachedToken = null;
		await getAdminToken(true);
		return await adminRequest(path, false);
	}
	if (res.status !== 200 && res.status !== 404) {
		// 403/5xx 都不能解释为“用户不在组”，统一按不可用处理
		throw new UpstreamError(
			res.status === 403 ? 'keycloak_forbidden' : 'keycloak_unavailable',
			`GET ${path} returned ${res.status}`,
			res.status,
		);
	}
	return res;
}

/** 查询用户是否存在、是否启用，并取出用户名与邮箱用于用户名单匹配 */
async function getUser(userId: string): Promise<UserStatus> {
	const res = await adminRequest(`/users/${encodeURIComponent(userId)}`);
	if (res.status === 404) {
		return { exists: false, enabled: false, username: '', email: '' };
	}
	const payload = (await res.json().catch(() => null)) as { enabled?: unknown; username?: unknown; email?: unknown } | null;
	return {
		exists: true,
		enabled: payload?.enabled !== false,
		username: typeof payload?.username === 'string' ? payload.username : '',
		email: typeof payload?.email === 'string' ? payload.email : '',
	};
}

/** 分页拉取用户直接所属的组 */
async function getUserGroups(userId: string): Promise<GroupInfo[]> {
	const pageSize = 500;
	const maxGroups = 2000;
	const groups: GroupInfo[] = [];
	let first = 0;

	while (first < maxGroups) {
		const res = await adminRequest(
			`/users/${encodeURIComponent(userId)}/groups?briefRepresentation=false&first=${first}&max=${pageSize}`,
		);
		if (res.status === 404) {
			throw new UpstreamError('user_not_found', 'user disappeared while querying groups', 404);
		}
		const page = (await res.json().catch(() => null)) as unknown;
		if (!Array.isArray(page)) {
			throw new UpstreamError('keycloak_unavailable', 'user groups response is invalid');
		}
		for (const item of page) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const entry = item as { name?: unknown; path?: unknown };
			const name = typeof entry.name === 'string' ? entry.name : '';
			const path = typeof entry.path === 'string' ? entry.path : (name ? `/${name}` : '');
			if (name || path) {
				groups.push({ name, path });
			}
		}
		if (page.length < pageSize) {
			break;
		}
		first += pageSize;
	}
	return groups;
}

/**
 * 判断一个用户组是否命中允许列表
 *
 * - 配置项以 `/` 开头时按路径比较：用户所在子组也算命中父组（`/staff/ai/llm` 命中 `/staff/ai`）。
 * - 否则按组名比较。
 */
export function groupMatches(group: GroupInfo, allowed: string[]): boolean {
	const name = group.name;
	const path = group.path || (name ? `/${name}` : '');
	for (const entry of allowed) {
		if (entry.startsWith('/')) {
			if (path === entry || path.startsWith(`${entry}/`)) {
				return true;
			}
		}
		else if (name === entry || path.split('/').filter(Boolean).pop() === entry) {
			return true;
		}
	}
	return false;
}

/** 参与用户名单匹配的身份字段 */
export interface UserIdentity {
	id?: string;
	username?: string;
	email?: string;
}

/**
 * 判断用户是否命中具体用户名单
 *
 * 裸值同时匹配 UUID、用户名与邮箱；`uuid:` / `username:` / `email:` 前缀只匹配对应字段。
 * 全部按小写比较（Keycloak 用户名默认不区分大小写，邮箱实践中也不区分）。
 */
export function userMatchesAllowList(identity: UserIdentity, allowed: string[]): boolean {
	if (!allowed.length) {
		return false;
	}
	const id = (identity.id ?? '').trim().toLowerCase();
	const username = (identity.username ?? '').trim().toLowerCase();
	const email = (identity.email ?? '').trim().toLowerCase();

	for (const raw of allowed) {
		const entry = raw.trim().toLowerCase();
		if (!entry) {
			continue;
		}
		const separator = entry.indexOf(':');
		if (separator > 0) {
			const kind = entry.slice(0, separator);
			const value = entry.slice(separator + 1).trim();
			if (!value) {
				continue;
			}
			if (kind === 'uuid' && id && value === id) {
				return true;
			}
			if (kind === 'username' && username && value === username) {
				return true;
			}
			if (kind === 'email' && email && value === email) {
				return true;
			}
			continue;
		}
		if ((id && entry === id) || (username && entry === username) || (email && entry === email)) {
			return true;
		}
	}
	return false;
}

/**
 * 校验用户当前是否仍有资格使用本服务
 *
 * 合格条件取并集：命中具体用户名单，或属于允许的用户组。
 * 失败时区分“明确不合格”与“无法确认”：后者必须由调用方按 fail closed/fail safe 处理。
 */
export async function isEligible(userId: string): Promise<Eligibility> {
	try {
		const user = await getUser(userId);
		if (!user.exists) {
			return 'user_not_found';
		}
		if (!user.enabled) {
			return 'user_disabled';
		}
		if (userMatchesAllowList({ id: userId, username: user.username, email: user.email }, CONFIG.keycloak.allowedUsers)) {
			return 'eligible';
		}
		// 没有配置任何组时无需再查组，直接判定不合格
		if (!CONFIG.keycloak.allowedGroups.length) {
			return 'not_allowed';
		}
		const groups = await getUserGroups(userId);
		return groups.some(group => groupMatches(group, CONFIG.keycloak.allowedGroups))
			? 'eligible'
			: 'not_allowed';
	}
	catch (ex) {
		if (ex instanceof UpstreamError && ex.code === 'user_not_found') {
			return 'user_not_found';
		}
		logger.warn(`keycloak eligibility check failed: ${(ex as Error)?.message ?? ex}`);
		return 'unavailable';
	}
}

/** 清空管理员 Token 缓存（测试与诊断用） */
export function clearAdminTokenCache(): void {
	cachedToken = null;
}
