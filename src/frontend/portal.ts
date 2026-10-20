import type { DeniedInfo, PortalData } from './types';
import { loadPortal } from './api';
import { closeModal, openLoginModal, openModal } from './auth';
import { t } from './i18n';
import { ApiError } from './types';
import { copyText, el, toast } from './ui';

export interface PortalHandlers {
	/** 轮换后重新加载页面数据 */
	onRotate: () => Promise<void>;
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

/** 一项信息：标签 + 值 + 操作按钮 */
function section(label: string, value: string, actions: HTMLButtonElement[], mono = true): HTMLElement {
	const wrapper = el('div', { class: 'portal-section' });
	const head = el('div', { class: 'portal-label' }, [label]);
	const row = el('div', { class: 'portal-row' });
	const code = el('code', { class: `portal-value${mono ? ' mono' : ''}` }, [value]);
	row.append(code, ...actions);
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
		section(t('callUrl'), data.callUrl, [copyButton(data.callUrl)]),
		section(t('personalToken'), data.token, [copyButton(data.token), rotate]),
	);

	const modelSection = el('div', { class: 'portal-section' });
	modelSection.append(el('div', { class: 'portal-label' }, [t('models')]));
	if (data.models.length) {
		const list = el('div', { class: 'model-list' });
		for (const model of data.models) {
			list.append(el('span', { class: 'model-chip mono' }, [model]));
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
