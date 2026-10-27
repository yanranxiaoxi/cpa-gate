import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as packageJson from '../../package.json';
import 'dotenv/config';

/**
 * 验证必需的环境变量
 * @param name - 环境变量名称
 * @param value - 环境变量值
 * @param defaultValue - 默认值
 * @returns 验证后的环境变量值
 */
function validateEnvVar(name: string, value: string | undefined, defaultValue?: string): string {
	if (!value && defaultValue === undefined) {
		throw new Error(`Required environment variable ${name} is not set`);
	}
	return value || defaultValue!;
}

/**
 * 验证端口号
 * @param port - 端口号字符串
 * @param defaultPort - 默认端口号
 * @returns 验证后的端口号
 */
function validatePort(port: string | undefined, defaultPort: number): number {
	const portNum = port ? Number(port) : defaultPort;
	if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
		throw new Error(`Invalid port number: ${port}. Must be between 1 and 65535`);
	}
	return portNum;
}

function validateOptionalEnvVar(value: string | undefined, defaultValue = ''): string {
	return value || defaultValue;
}

function validateNumberEnvVar(name: string, value: string | undefined, defaultValue: number, allowZero = false): number {
	if (!value) {
		return defaultValue;
	}
	const num = Number(value);
	if (Number.isNaN(num) || num < (allowZero ? 0 : 1)) {
		throw new Error(`Invalid environment variable ${name}: ${value}`);
	}
	return num;
}

/** 去掉末尾斜杠，避免拼接出双斜杠 */
function trimSlash(url: string): string {
	return url.replace(/\/+$/, '');
}

/**
 * 解析逗号分隔或 JSON 数组形式的列表配置
 *
 * @param name - 环境变量名（用于报错信息）
 * @param raw - 原始值
 */
function parseEnvList(name: string, raw: string | undefined): string[] {
	const value = (raw ?? '').trim();
	if (!value) {
		return [];
	}
	if (value.startsWith('[')) {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (!Array.isArray(parsed)) {
				throw new TypeError(`${name} must be a JSON array`);
			}
			return parsed.map(item => String(item)).map(item => item.trim()).filter(Boolean);
		}
		catch (ex) {
			throw new Error(`Invalid ${name}: ${(ex as Error).message}`);
		}
	}
	return value.split(',').map(item => item.trim()).filter(Boolean);
}

/** 去掉空项与路径尾部斜杠，避免 `/staff/ai/` 这类配置匹配不到子组 */
function normalizeGroups(items: string[]): string[] {
	return items
		.map(item => (item.startsWith('/') ? item.replace(/\/+$/, '') : item))
		.filter(item => item !== '/');
}

/**
 * 允许的具体用户
 *
 * 裸值同时匹配 UUID、用户名与邮箱（大小写不敏感）；也可用
 * `uuid:` / `username:` / `email:` 前缀限定匹配字段。
 */
function parseAllowedUsers(raw: string | undefined): string[] {
	return parseEnvList('ALLOWED_USERS', raw);
}

/**
 * 解析 RP-initiated logout 的回跳地址
 *
 * 显式配置 OIDC_POST_LOGOUT_REDIRECT_URI 优先；否则取 OIDC_REDIRECT_URI 的站点根
 * （如 https://example.com/api/auth/callback → https://example.com/）。
 * 两者都不可用时返回空串，此时登出仅清本地会话、不跳 IdP。
 */
function resolvePostLogoutRedirectUri(): string {
	const explicit = validateOptionalEnvVar(process.env.OIDC_POST_LOGOUT_REDIRECT_URI);
	if (explicit) {
		return explicit;
	}
	const redirectUri = process.env.OIDC_REDIRECT_URI;
	if (!redirectUri) {
		return '';
	}
	try {
		return `${new URL(redirectUri).origin}/`;
	}
	catch {
		return '';
	}
}

/**
 * 解析 SSO 用户中心地址
 *
 * 只接受 http/https：该值会作为 `<a href>` 下发到页面，若误配成 `javascript:`
 * 之类的协议，点击用户名就会执行脚本，因此直接丢弃而不是原样透传。
 */
function resolveAccountUrl(): string {
	const raw = validateOptionalEnvVar(process.env.OIDC_ACCOUNT_URL);
	if (!raw) {
		return '';
	}
	try {
		const { protocol } = new URL(raw);
		return protocol === 'http:' || protocol === 'https:' ? raw : '';
	}
	catch {
		return '';
	}
}

/**
 * 从 OIDC issuer 推导 Keycloak Admin 基址与 realm
 *
 * issuer 形如 https://sso.example.com/realms/main：
 * - baseUrl: https://sso.example.com
 * - realm: main
 */
function resolveKeycloakFromIssuer(): { baseUrl: string; realm: string } {
	const issuer = process.env.OIDC_ISSUER ?? '';
	if (!issuer) {
		return { baseUrl: '', realm: '' };
	}
	try {
		const url = new URL(issuer);
		const match = url.pathname.match(/\/realms\/([^/]+)/);
		return { baseUrl: url.origin, realm: match ? match[1] : '' };
	}
	catch {
		return { baseUrl: '', realm: '' };
	}
}

const managementUrl = trimSlash(validateEnvVar('CPA_MANAGEMENT_URL', process.env.CPA_MANAGEMENT_URL));
const managementKey = validateOptionalEnvVar(process.env.CPA_MANAGEMENT_KEY);
const apiBaseUrl = trimSlash(validateOptionalEnvVar(process.env.CPA_API_BASE_URL, managementUrl));
const keycloakDerived = resolveKeycloakFromIssuer();

const oidcIssuer = validateOptionalEnvVar(process.env.OIDC_ISSUER);
const oidcClientId = validateOptionalEnvVar(process.env.OIDC_CLIENT_ID);
const oidcClientSecret = validateOptionalEnvVar(process.env.OIDC_CLIENT_SECRET);
const oidcRedirectUri = validateOptionalEnvVar(process.env.OIDC_REDIRECT_URI);
const oidcConfigured = Boolean(oidcIssuer && oidcClientId && oidcClientSecret && oidcRedirectUri);

const keycloakAdminClientId = validateOptionalEnvVar(process.env.KEYCLOAK_ADMIN_CLIENT_ID);
const keycloakAdminClientSecret = validateOptionalEnvVar(process.env.KEYCLOAK_ADMIN_CLIENT_SECRET);
const allowedGroups = normalizeGroups(parseEnvList('ALLOWED_GROUPS', process.env.ALLOWED_GROUPS));
const allowedUsers = parseAllowedUsers(process.env.ALLOWED_USERS);

// 启动期校验：避免出现“能登录但永远拿不到 Key”或“无法判断用户组”的隐性故障
if (managementUrl && !managementKey) {
	throw new Error('CPA_MANAGEMENT_KEY is required when CPA_MANAGEMENT_URL is set');
}
if (oidcConfigured) {
	if (!keycloakAdminClientId || !keycloakAdminClientSecret) {
		throw new Error('KEYCLOAK_ADMIN_CLIENT_ID and KEYCLOAK_ADMIN_CLIENT_SECRET are required to verify users');
	}
	if (!keycloakDerived.baseUrl || !keycloakDerived.realm) {
		throw new Error('Cannot derive Keycloak base URL/realm from OIDC_ISSUER; set KEYCLOAK_ADMIN_BASE_URL and KEYCLOAK_REALM');
	}
	if (!allowedGroups.length && !allowedUsers.length) {
		throw new Error('At least one of ALLOWED_GROUPS / ALLOWED_USERS is required when OIDC login is enabled');
	}
}

export const CONFIG = {
	env: validateEnvVar('ENV_PRODUCT', process.env.ENV_PRODUCT, 'development'),
	host: validateEnvVar('SERVER_HOST', process.env.SERVER_HOST, '0.0.0.0'),
	port: validatePort(process.env.SERVER_PORT, 3001),
	serverName: validateEnvVar('SERVER_NAME', process.env.SERVER_NAME, 'cpa-gate'),

	envProduct: validateEnvVar('ENV_PRODUCT', process.env.ENV_PRODUCT, 'development'),
	projectName: validateEnvVar('PROJECT_NAME', process.env.PROJECT_NAME, packageJson.name),
	logLevel: validateEnvVar('LOG_LEVEL', process.env.LOG_LEVEL, 'info'),

	/** CLIProxyAPI 配置 */
	cpa: {
		/** 管理 API 基址（origin + 可选 base path，不含 /v0/management） */
		managementUrl,
		/** Management Key，只存在于服务端 */
		managementKey,
		/** 前端展示的调用基址；未配置时与管理地址一致。模型查询始终走管理地址 */
		apiBaseUrl,
		/** 上游请求超时（毫秒） */
		timeoutMs: validateNumberEnvVar('CPA_TIMEOUT_MS', process.env.CPA_TIMEOUT_MS, 10000),
		/** 模型列表缓存秒数，0 表示不缓存 */
		modelsCacheTtl: validateNumberEnvVar('MODELS_CACHE_TTL', process.env.MODELS_CACHE_TTL, 60, true),
	},

	/** OpenID Connect 登录配置（全部配置后才启用登录） */
	oidc: {
		issuer: oidcIssuer,
		clientId: oidcClientId,
		clientSecret: oidcClientSecret,
		redirectUri: oidcRedirectUri,
		scope: validateOptionalEnvVar(process.env.OIDC_SCOPE, 'openid profile email'),
		/** 用户名取自 userinfo 的哪个 claim（Keycloak 为 preferred_username） */
		usernameClaim: validateOptionalEnvVar(process.env.OIDC_USERNAME_CLAIM, 'preferred_username'),
		/** 用户 ID 取自哪个 claim，必须是 Keycloak 真实用户 ID */
		userIdClaim: validateOptionalEnvVar(process.env.OIDC_USER_ID_CLAIM, 'sub'),
		/** 是否允许非 HTTPS 的 issuer（仅本地开发/测试使用） */
		allowInsecure: process.env.OIDC_ALLOW_INSECURE === 'true' || process.env.OIDC_ALLOW_INSECURE === '1',
		/** SSO 提供商名称，显示在登录弹窗按钮上；留空时前端使用本地化默认文案 */
		providerName: validateOptionalEnvVar(process.env.OIDC_PROVIDER_NAME),
		/** 登出 SSO 时 IdP 回跳地址；留空则自动取 OIDC_REDIRECT_URI 的站点根 */
		postLogoutRedirectUri: resolvePostLogoutRedirectUri(),
		/** SSO 用户中心地址；配置后登录时用户名变为可点击链接 */
		accountUrl: resolveAccountUrl(),
	},

	/** Keycloak Admin API（用于校验用户是否存在、是否在允许组中） */
	keycloak: {
		baseUrl: trimSlash(validateOptionalEnvVar(process.env.KEYCLOAK_ADMIN_BASE_URL, keycloakDerived.baseUrl)),
		realm: validateOptionalEnvVar(process.env.KEYCLOAK_REALM, keycloakDerived.realm),
		adminClientId: keycloakAdminClientId,
		adminClientSecret: keycloakAdminClientSecret,
		timeoutMs: validateNumberEnvVar('KEYCLOAK_ADMIN_TIMEOUT_MS', process.env.KEYCLOAK_ADMIN_TIMEOUT_MS, 10000),
		/** 允许的用户组：组名（ai）或完整路径（/staff/ai），父组自动覆盖子组 */
		allowedGroups,
		/** 允许的具体用户：UUID / 用户名 / 邮箱，或带 uuid: / username: / email: 前缀 */
		allowedUsers,
	},

	/** 自动清理配置 */
	prune: {
		/**
		 * 自动清理间隔（秒，0 = 关闭）
		 *
		 * 这是撤销「已离开用户组 / 已禁用 / 已删除」用户 Key 的唯一机制，
		 * 关闭后这些用户会一直保留可用 Key，直到手工清理。
		 */
		intervalSeconds: validateNumberEnvVar('PRUNE_INTERVAL', process.env.PRUNE_INTERVAL, 30 * 60, true),
	},

	/** 会话配置 */
	session: {
		/** 会话签名密钥（必填，建议 32+ 随机字节） */
		secret: validateEnvVar('SESSION_SECRET', process.env.SESSION_SECRET),
		cookieName: validateOptionalEnvVar(process.env.SESSION_COOKIE_NAME, 'cpa_session'),
		ttl: validateNumberEnvVar('SESSION_TTL', process.env.SESSION_TTL, 7 * 24 * 60 * 60),
	},

	/** 站点品牌（按语言分别配置，留空时使用该语言的默认文案） */
	site: {
		zhHans: {
			title: validateOptionalEnvVar(process.env.SITE_TITLE_ZH_HANS).trim(),
			subtitle: validateOptionalEnvVar(process.env.SITE_SUBTITLE_ZH_HANS).trim(),
			description: validateOptionalEnvVar(process.env.SITE_DESCRIPTION_ZH_HANS).trim(),
		},
		en: {
			title: validateOptionalEnvVar(process.env.SITE_TITLE_EN).trim(),
			subtitle: validateOptionalEnvVar(process.env.SITE_SUBTITLE_EN).trim(),
			description: validateOptionalEnvVar(process.env.SITE_DESCRIPTION_EN).trim(),
		},
	},

	/** 静态资源目录：默认为空时自动解析（构建产物 dist/public 或源码 public） */
	staticDir: validateOptionalEnvVar(process.env.STATIC_DIR),
} as const;

/**
 * 解析前端静态资源目录
 *
 * 优先级：STATIC_DIR 环境变量 > 运行入口同级的 public/（生产构建产物 dist/public）
 * > 向上逐级查找项目根下的 public/（开发时 tsx 运行）。
 */
export function resolveStaticDir(): string {
	if (CONFIG.staticDir) {
		return path.resolve(CONFIG.staticDir);
	}

	// 构建产物（esbuild 单文件）位于 dist/index.js；tsx 开发时位于 src/controller/*.ts
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const sibling = path.join(moduleDir, 'public');
	if (existsSync(sibling)) {
		return sibling;
	}

	// 逐级向上查找 package.json 所在目录下的 public/
	let current = moduleDir;
	while (current !== path.dirname(current)) {
		const candidate = path.join(current, 'public');
		if (existsSync(candidate)) {
			return candidate;
		}
		const pkg = path.join(current, 'package.json');
		if (existsSync(pkg)) {
			break;
		}
		current = path.dirname(current);
	}
	throw new Error('Cannot resolve static directory. Set STATIC_DIR explicitly.');
}
