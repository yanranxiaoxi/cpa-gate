import type { DeniedInfo, PortalData } from './types';
import { getSiteTitle, loadPortal } from './api';
import { closeModal, openLoginModal, openModal } from './auth';
import { t } from './i18n';
import { ApiError } from './types';
import { copyText, el, toast } from './ui';

export interface PortalHandlers {
	/** 轮换后重新加载页面数据 */
	onRotate: () => Promise<void>;
}

/** 「完整 URL」开关的 localStorage 键 */
const FULL_URL_KEY = 'cpa-full-url';

/**
 * 是否展示完整接口地址
 *
 * 关闭（默认）：显示客户端环境变量该填的基址，如 `https://cpa.example.com/v1`
 * 打开：显示可直接调用的完整接口地址，如 `https://cpa.example.com/v1/chat/completions`
 */
let showFullUrl = readFullUrlPreference();

/** 安全读取开关偏好（隐私模式下 localStorage 可能抛错） */
function readFullUrlPreference(): boolean {
	try {
		return localStorage.getItem(FULL_URL_KEY) === '1';
	}
	catch {
		return false;
	}
}

/** 持久化开关偏好 */
function saveFullUrlPreference(value: boolean): void {
	try {
		localStorage.setItem(FULL_URL_KEY, value ? '1' : '0');
	}
	catch {
		// 忽略
	}
}

/** 按当前开关状态选择要显示的地址 */
function currentUrl(base: string, full: string): string {
	return showFullUrl ? full : base;
}

/**
 * 生成一个可切换显示形态的 URL 元素
 *
 * `data-base` / `data-full` 同时保存两种形态，切换开关时只改文本、不重建 DOM；
 * 复制按钮在点击时读取当前文本，因此复制的就是屏幕上看到的地址。
 */
function urlCode(base: string, full: string, className: string): HTMLElement {
	return el('code', {
		'class': `${className} mono url-value`,
		'data-base': base,
		'data-full': full,
	}, [currentUrl(base, full)]);
}

/** 就地刷新所有 URL 元素的显示形态 */
function applyFullUrl(): void {
	for (const node of document.querySelectorAll<HTMLElement>('.url-value')) {
		const { base, full } = node.dataset;
		if (base && full) {
			node.textContent = currentUrl(base, full);
		}
	}
}

/** 「完整 URL」开关 */
function fullUrlSwitch(): HTMLElement {
	const input = el('input', { class: 'switch-input', type: 'checkbox' }) as HTMLInputElement;
	input.checked = showFullUrl;
	input.addEventListener('change', () => {
		showFullUrl = input.checked;
		saveFullUrlPreference(showFullUrl);
		applyFullUrl();
	});
	return el('label', { class: 'switch', title: t('fullUrlHint') }, [
		input,
		el('span', { class: 'switch-track' }),
		el('span', { class: 'switch-text' }, [t('fullUrlToggle')]),
	]);
}

/** 复制按钮：点击时读取目标元素当前文本，跟随开关状态 */
function copyUrlButton(node: HTMLElement): HTMLButtonElement {
	const button = el('button', { class: 'btn small ghost', type: 'button' }, [t('copy')]);
	button.addEventListener('click', async () => {
		const ok = await copyText(node.textContent ?? '');
		toast(ok ? t('copied') : t('copyFailed'), ok ? 'success' : 'error');
	});
	return button;
}

/** 复制按钮：成功后 toast 提示 */
function copyButton(value: string): HTMLButtonElement {
	const button = el('button', { class: 'btn small ghost', type: 'button' }, [t('copy')]);
	button.addEventListener('click', async () => {
		const ok = await copyText(value);
		toast(ok ? t('copied') : t('copyFailed'), ok ? 'success' : 'error');
	});
	return button;
}

/**
 * 用户 ID（UUID）展示块
 *
 * 失去资格或登录被拒时，用户需要把自己的 ID 交给管理员加入 ALLOWED_USERS，
 * 因此单独展示并支持复制。
 */
function userIdBlock(userId: string, username?: string): HTMLElement {
	const wrapper = el('div', { class: 'user-id-block' });
	wrapper.append(el('div', { class: 'user-id-label' }, [t('userIdLabel')]));
	const row = el('div', { class: 'user-id-row' });
	row.append(el('code', { class: 'user-id-value mono' }, [userId]), copyButton(userId));
	wrapper.append(row);
	if (username) {
		wrapper.append(el('p', { class: 'user-id-hint dim' }, [t('usernameLabel', { name: username })]));
	}
	wrapper.append(el('p', { class: 'user-id-hint dim' }, [t('userIdHint')]));
	return wrapper;
}

/**
 * 模型标签：点击即复制模型名
 *
 * 用 button 而不是 span，键盘可聚焦、可回车触发；视觉上保持胶囊样式。
 */
function modelChip(model: string): HTMLButtonElement {
	const chip = el('button', {
		'class': 'model-chip mono',
		'type': 'button',
		'title': t('copyModel'),
		'aria-label': t('copyModelAria', { name: model }),
	}, [model]);
	chip.addEventListener('click', async () => {
		const ok = await copyText(model);
		toast(ok ? t('copiedModel', { name: model }) : t('copyFailed'), ok ? 'success' : 'error');
	});
	return chip;
}

/** 一项兼容地址：协议名 + 用途 + 值 + 复制 */
function endpointRow(label: string, hint: string, base: string, full: string): HTMLElement {
	const row = el('div', { class: 'endpoint-item' });
	const meta = el('div', { class: 'endpoint-meta' });
	meta.append(
		el('span', { class: 'endpoint-name' }, [label]),
		el('span', { class: 'endpoint-hint dim mono' }, [hint]),
	);
	const code = urlCode(base, full, 'endpoint-value');
	row.append(meta, code, copyUrlButton(code));
	return row;
}

/** 一项信息：标签 + 值 + 操作按钮（可选协议提示与右侧控件） */
function section(
	label: string,
	value: string,
	actions: HTMLButtonElement[],
	hint?: string,
	headExtra?: HTMLElement,
): HTMLElement {
	const wrapper = el('div', { class: 'portal-section' });
	const head = el('div', { class: 'portal-label' }, [label]);
	if (hint) {
		head.append(el('span', { class: 'portal-hint mono' }, [hint]));
	}
	if (headExtra) {
		head.append(el('span', { class: 'portal-label-extra' }, [headExtra]));
	}
	const row = el('div', { class: 'portal-row' });
	row.append(el('code', { class: 'portal-value mono' }, [value]), ...actions);
	wrapper.append(head, row);
	return wrapper;
}

/** 调用地址区块：主地址 + 完整路径开关 + 其它兼容地址 */
function callSection(data: PortalData): HTMLElement {
	const wrapper = el('div', { class: 'portal-section' });
	const head = el('div', { class: 'portal-label' }, [
		t('callUrl'),
		el('span', { class: 'portal-hint mono' }, ['OPENAI_BASE_URL']),
		el('span', { class: 'portal-label-extra' }, [fullUrlSwitch()]),
	]);

	const row = el('div', { class: 'portal-row' });
	const code = urlCode(data.callUrl, data.endpoints?.openai.full ?? data.callUrl, 'portal-value');
	row.append(code, copyUrlButton(code));
	wrapper.append(head, row);

	if (data.endpoints) {
		// 主地址是 OpenAI 兼容入口；下方补充 Claude Code 与 Gemini CLI 需要的其它前缀
		const extras = el('div', { class: 'endpoint-list' });
		extras.append(el('div', { class: 'endpoint-list-label' }, [t('otherEndpoints')]));
		extras.append(
			endpointRow(t('endpointAnthropic'), 'ANTHROPIC_BASE_URL', data.endpoints.anthropic.base, data.endpoints.anthropic.full),
			endpointRow(t('endpointGemini'), 'GOOGLE_GEMINI_BASE_URL', data.endpoints.gemini.base, data.endpoints.gemini.full),
		);
		wrapper.append(extras);
	}
	return wrapper;
}

/**
 * 从 API 基址解析提供商标识符（用于客户端配置 ID）
 * 规则：取 host / hostname 并将非字母数字字符替换为连字符，如 https://ai-chat.sandstack.org -> ai-chat-sandstack-org
 */
export function parseProviderIdFromBaseUrl(rawUrl: string): string {
	try {
		const parsed = new URL(rawUrl);
		const source = parsed.hostname || parsed.host;
		const id = source.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
		return id || 'cpa-gate';
	}
	catch {
		const cleaned = rawUrl.replace(/^https?:\/\//i, '').split('/')[0];
		const id = cleaned.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
		return id || 'cpa-gate';
	}
}

/**
 * 工具辅助：将字符串以 UTF-8 编码为 URL-Safe Base64（+ 转 _，/ 转 -）
 */
function utf8ToBase64(text: string, urlSafe = false): string {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	const base64 = btoa(binary);
	return urlSafe ? base64.replace(/\+/g, '_').replace(/\//g, '-') : base64;
}

/**
 * 分解调用地址，拆出 origin (apiHost) 与 pathname (apiPath)
 */
function splitHostAndPath(callUrl: string): { apiHost: string; apiPath: string } {
	try {
		const parsed = new URL(callUrl);
		return {
			apiHost: parsed.origin,
			apiPath: parsed.pathname || '/v1',
		};
	}
	catch {
		const match = callUrl.match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
		if (match) {
			return { apiHost: match[1], apiPath: match[2] || '/v1' };
		}
		return { apiHost: callUrl, apiPath: '/v1' };
	}
}

/**
 * 构建 Cherry Studio 一键导入 Deep Link
 * 协议格式：cherrystudio://providers/api-keys?v=1&data={urlSafeBase64(json)}
 */
export function buildCherryStudioUrl(params: {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
}): string {
	const config = {
		id: params.id,
		name: params.name,
		baseUrl: params.baseUrl,
		apiKey: params.apiKey,
		type: 'openai',
	};
	const base64 = utf8ToBase64(JSON.stringify(config), true);
	return `cherrystudio://providers/api-keys?v=1&data=${base64}`;
}

/**
 * 构建 Chatbox 一键导入 Deep Link
 * 协议格式：chatbox://provider/import?config={base64(json)}
 */
export function buildChatboxUrl(params: {
	id: string;
	name: string;
	callUrl: string;
	apiKey: string;
}): string {
	const { apiHost, apiPath } = splitHostAndPath(params.callUrl);
	const config = {
		isCustom: true,
		id: params.id,
		name: params.name,
		type: 'openai',
		settings: {
			apiHost,
			apiPath,
			apiKey: params.apiKey,
		},
	};
	const base64 = utf8ToBase64(JSON.stringify(config), false);
	return `chatbox://provider/import?config=${encodeURIComponent(base64)}`;
}

/**
 * 构建 OpenCat (iOS / macOS) 一键导入 Deep Link
 * 协议格式：opencat://team/join?domain={url}&token={key}
 */
export function buildOpenCatUrl(params: {
	baseUrl: string;
	apiKey: string;
}): string {
	return `opencat://team/join?domain=${encodeURIComponent(params.baseUrl)}&token=${encodeURIComponent(params.apiKey)}`;
}

/**
 * 构建 NextChat (ChatGPT-Next-Web) 网页直达链接
 * 格式：https://app.nextchat.dev/#/?settings={"key":"...","url":"..."}
 */
export function buildNextChatUrl(params: {
	baseUrl: string;
	apiKey: string;
}): string {
	const settings = JSON.stringify({ key: params.apiKey, url: params.baseUrl });
	return `https://app.nextchat.dev/#/?settings=${encodeURIComponent(settings)}`;
}

/**
 * 构建 LobeChat 网页直达链接
 * 格式：https://chat-preview.lobehub.com/?settings={"keyVaults":{"openai":{"apiKey":"...","baseURL":"..."}}}
 */
export function buildLobeChatUrl(params: {
	baseUrl: string;
	apiKey: string;
}): string {
	const settings = JSON.stringify({
		keyVaults: {
			openai: {
				apiKey: params.apiKey,
				baseURL: params.baseUrl,
			},
		},
	});
	return `https://chat-preview.lobehub.com/?settings=${encodeURIComponent(settings)}`;
}

/** 快速配置区块（一键导入 Cherry Studio、Chatbox、OpenCat、NextChat、LobeChat 等客户端） */
function quickConfigSection(data: PortalData): HTMLElement {
	const wrapper = el('div', { class: 'portal-section' });
	const head = el('div', { class: 'portal-label' }, [t('quickConfig')]);
	const row = el('div', { class: 'portal-row quick-config-row' });

	const providerId = parseProviderIdFromBaseUrl(data.endpoints?.anthropic.base || data.callUrl);
	const siteName = getSiteTitle();
	const apiKey = data.token ?? '';

	const tools = [
		{
			name: 'Cherry Studio',
			url: buildCherryStudioUrl({ id: providerId, name: siteName, baseUrl: data.callUrl, apiKey }),
			hint: t('cherryStudioHint'),
		},
		{
			name: 'Chatbox',
			url: buildChatboxUrl({ id: providerId, name: siteName, callUrl: data.callUrl, apiKey }),
			hint: t('chatboxHint'),
		},
		{
			name: 'OpenCat',
			url: buildOpenCatUrl({ baseUrl: data.callUrl, apiKey }),
			hint: t('openCatHint'),
		},
		{
			name: 'NextChat',
			url: buildNextChatUrl({ baseUrl: data.callUrl, apiKey }),
			hint: t('nextChatHint'),
		},
		{
			name: 'LobeChat',
			url: buildLobeChatUrl({ baseUrl: data.callUrl, apiKey }),
			hint: t('lobeChatHint'),
		},
	];

	for (const tool of tools) {
		const btn = el('a', {
			'class': 'btn small ghost quick-config-btn',
			'href': tool.url,
			'target': '_blank',
			'rel': 'noopener noreferrer',
			'title': tool.hint,
			'aria-label': tool.hint,
		}, [tool.name]);
		row.append(btn);
	}

	wrapper.append(head, row);
	return wrapper;
}

/** 轮换确认弹窗 */
function confirmRotate(trigger: HTMLElement, onRotate: () => Promise<void>): void {
	const text = el('p', { class: 'modal-text' }, [t('rotateConfirm')]);
	const cancel = el('button', { class: 'btn ghost modal-action', type: 'button' }, [t('cancel')]);
	const confirm = el('button', { class: 'btn primary modal-action', type: 'button' }, [t('rotate')]);

	cancel.addEventListener('click', () => closeModal());
	confirm.addEventListener('click', async () => {
		confirm.disabled = true;
		cancel.disabled = true;
		closeModal(false);
		await onRotate();
	});

	openModal(trigger, 'rotate', [text, cancel, confirm], cancel);
}

/**
 * 把卡片切换为居中提示布局
 *
 * 提示态没有 .portal-section 撑开上下留白，必须换成四边等距的 notice-card，
 * 否则 .portal-card 的 `6px 18px` 会让上下比左右窄，按钮也会贴着下边沿。
 */
function renderNotice(card: HTMLElement, children: HTMLElement[]): void {
	card.classList.add('notice-card');
	card.append(...children);
}

/** 已登录用户的页面卡片 */
export function renderPortal(container: HTMLElement, data: PortalData, handlers: PortalHandlers): void {
	const card = el('section', { class: 'card portal-card' });

	if (!data.eligible) {
		renderNotice(card, [
			el('h2', { class: 'notice-title' }, [t('notEligibleTitle')]),
			el('p', { class: 'notice-text dim' }, [t('notEligibleText')]),
			userIdBlock(data.userId),
			el('a', { class: 'btn ghost', href: '/api/auth/logout' }, [t('logout')]),
		]);
		container.replaceChildren(card);
		return;
	}

	if (!data.token) {
		const message = data.tokenError === 'verification_unavailable'
			? t('verificationUnavailable')
			: t('tokenUnavailable');
		const retry = el('button', { class: 'btn primary', type: 'button' }, [t('retry')]);
		retry.addEventListener('click', () => {
			void load(container, handlers);
		});
		renderNotice(card, [el('p', { class: 'notice-text dim' }, [message]), retry]);
		container.replaceChildren(card);
		return;
	}

	const rotate = el('button', { class: 'btn small ghost', type: 'button' }, [t('rotate')]);
	rotate.addEventListener('click', () => {
		confirmRotate(rotate, async () => {
			await handlers.onRotate();
		});
	});

	card.append(
		callSection(data),
		section(t('personalToken'), data.token, [copyButton(data.token), rotate]),
		quickConfigSection(data),
	);

	const modelSection = el('div', { class: 'portal-section' });
	modelSection.append(el('div', { class: 'portal-label' }, [t('models')]));
	if (data.models.length) {
		const list = el('div', { class: 'model-list' });
		for (const model of data.models) {
			list.append(modelChip(model));
		}
		modelSection.append(list);
	}
	else {
		modelSection.append(el('p', { class: 'notice-text dim' }, [
			data.modelsUnavailable ? t('modelsUnavailable') : t('modelsEmpty'),
		]));
	}
	card.append(modelSection);

	container.replaceChildren(card);
}

/** 加载中 */
export function renderPortalLoading(container: HTMLElement): void {
	const card = el('section', { class: 'card portal-card' });
	renderNotice(card, [el('p', { class: 'notice-text dim' }, [t('loading')])]);
	container.replaceChildren(card);
}

/** 未登录：登录引导卡片 */
export function renderGuest(container: HTMLElement, providerName: string): void {
	const card = el('section', { class: 'card portal-card' });
	const login = el('button', { class: 'btn primary', type: 'button' }, [t('login')]);
	login.addEventListener('click', () => openLoginModal(login, providerName));
	renderNotice(card, [
		el('h2', { class: 'notice-title' }, [t('loginRequired')]),
		el('p', { class: 'notice-text dim' }, [t('loginHint')]),
		login,
	]);
	container.replaceChildren(card);
}

/**
 * 登录被拒：说明原因并展示用户自己的 UUID
 *
 * 未登录用户没有会话，无法从 /api/portal 取到 ID，服务端会在回调失败时
 * 用短期签名 Cookie 暂存身份，由 /api/auth/status 读一次后作废。
 */
export function renderDenied(container: HTMLElement, info: DeniedInfo): void {
	const card = el('section', { class: 'card portal-card' });
	const message = info.reason === 'unavailable' ? t('loginDeniedUnavailable') : t('loginDeniedGroup');
	const retry = el('button', { class: 'btn primary', type: 'button' }, [t('retryLogin')]);
	retry.addEventListener('click', () => {
		window.location.href = '/api/auth/login';
	});
	renderNotice(card, [
		el('h2', { class: 'notice-title' }, [t('loginDeniedTitle')]),
		el('p', { class: 'notice-text dim' }, [message]),
		userIdBlock(info.userId, info.username),
		retry,
	]);
	container.replaceChildren(card);
}

/** 请求失败：错误信息 + 重试 */
export function renderPortalError(container: HTMLElement, message: string, onRetry: () => void): void {
	const card = el('section', { class: 'card portal-card' });
	const retry = el('button', { class: 'btn primary', type: 'button' }, [t('retry')]);
	retry.addEventListener('click', onRetry);
	renderNotice(card, [el('p', { class: 'notice-text dim' }, [message]), retry]);
	container.replaceChildren(card);
}

/** 加载并渲染（轮换后复用） */
export async function load(container: HTMLElement, handlers: PortalHandlers): Promise<void> {
	renderPortalLoading(container);
	try {
		const data = await loadPortal();
		renderPortal(container, data, handlers);
	}
	catch (ex) {
		if (ex instanceof ApiError && ex.status === 401) {
			// 会话过期：交给 main 的登录态订阅重新渲染登录引导
			return;
		}
		renderPortalError(container, t('loadFailed'), () => {
			void load(container, handlers);
		});
	}
}
