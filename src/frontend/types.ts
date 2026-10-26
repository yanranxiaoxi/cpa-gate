/** 某个语言下的品牌文案，未配置的字段缺省 */
export interface SiteText {
	title?: string;
	subtitle?: string;
	description?: string;
}

/** 单个协议的地址：客户端应填的基址 + 一个完整接口地址 */
export interface ProtocolEndpoint {
	/** 客户端环境变量应填的基址 */
	base: string;
	/** 可直接调用的完整接口地址 */
	full: string;
}

/** 各协议的调用地址 */
export interface Endpoints {
	/** OpenAI 兼容（OpenAI SDK / Codex CLI） */
	openai: ProtocolEndpoint;
	/** Anthropic 兼容（Claude Code 的 ANTHROPIC_BASE_URL） */
	anthropic: ProtocolEndpoint;
	/** Gemini 兼容（Gemini CLI 的 GOOGLE_GEMINI_BASE_URL） */
	gemini: ProtocolEndpoint;
}

/** /api/config 返回结构 */
export interface AppConfig {
	/** 前端展示的 CLIProxyAPI 调用基址（含 /v1） */
	callUrl: string;
	/** 各协议调用地址 */
	endpoints?: Endpoints;
	/** 按语言配置的品牌文案；缺少该语言或字段时回退到语言包 */
	site?: Record<string, SiteText>;
}

/** 登录被拒时暂存的身份信息（仅用于展示用户自己的 UUID） */
export interface DeniedInfo {
	reason: 'forbidden' | 'unavailable' | string;
	userId: string;
	username?: string;
}

/** /api/auth/status 返回结构 */
export interface AuthStatus {
	loggedIn: boolean;
	authEnabled: boolean;
	/** SSO 提供商名称（服务端 OIDC_PROVIDER_NAME；未配置时前端用本地化默认文案） */
	providerName?: string;
	/** SSO 用户中心地址（服务端 OIDC_ACCOUNT_URL）；配置后用户名渲染为指向它的链接 */
	accountUrl?: string;
	user: { username: string } | null;
	/** 登录被拒后的提示信息，读取一次即失效 */
	denied?: DeniedInfo;
}

/** GET /api/portal 返回结构 */
export interface PortalData {
	/** 用户当前是否仍有资格（false 表示已不在允许组/用户名单/被禁用/被删除） */
	eligible: boolean;
	/** 用户自己的 Keycloak 用户 ID，便于向管理员核对 */
	userId: string;
	callUrl: string;
	/** 各协议调用地址 */
	endpoints?: Endpoints;
	token: string | null;
	/** API 密钥相关错误：cpa_unavailable / verification_unavailable */
	tokenError?: string;
	models: string[];
	modelsUnavailable: boolean;
}

/** 带业务信息的请求错误 */
export class ApiError extends Error {
	public readonly status: number;
	public constructor(message: string, status = 0) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}
