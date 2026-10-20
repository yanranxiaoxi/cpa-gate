import type { Theme } from './theme';
import type { AuthStatus, SiteText } from './types';
import * as api from './api';
import { getSiteConfig, loadConfig } from './api';
import { renderAuth } from './auth';
import { getLang, initI18n, setLang, SUPPORTED_LANGS, t } from './i18n';
import { load, renderDenied, renderGuest, renderPortalError } from './portal';
import { initScrollChrome } from './scroll-chrome';
import { initTheme, toggleTheme } from './theme';
import { ApiError } from './types';
import { el, textWithLinks, toast } from './ui';

const ROOT_ID = 'app';

/** 当前语言的服务端品牌文案（未配置时返回空对象） */
function siteText(): SiteText {
	return getSiteConfig().site?.[getLang()] ?? {};
}

/** 站点标题：当前语言的 SITE_TITLE_* 优先，否则用语言包默认文案 */
function siteTitle(): string {
	return siteText().title || t('appName');
}

/** 站点副标题：当前语言的 SITE_SUBTITLE_* 优先，否则用语言包默认文案 */
function siteSubtitle(): string {
	return siteText().subtitle || t('brandSub');
}

/** 站点描述：当前语言的 SITE_DESCRIPTION_* 优先，否则用语言包默认文案 */
function siteDescription(): string {
	return siteText().description || t('tagline');
}

/** 已应用到 `<html>` 的主题 */
function currentTheme(): Theme {
	return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** 主题按钮图标：深色主题下显示 ☀（点击切回浅色），浅色主题下显示 ☾ */
function themeIcon(theme: Theme): string {
	return theme === 'dark' ? '☀' : '☾';
}

function buildHeader(): HTMLElement {
	const header = el('header', { class: 'topbar' });
	const inner = el('div', { class: 'container topbar-inner' });

	const brand = el('a', { class: 'brand', href: '/' }, [
		el('span', { class: 'brand-name' }, [siteTitle()]),
		el('span', { class: 'brand-sub' }, [siteSubtitle()]),
	]);

	const langSelect = el('select', { 'class': 'select lang-select', 'aria-label': t('language') });
	for (const meta of SUPPORTED_LANGS) {
		const option = el('option', { value: meta.code }, [meta.label]);
		option.selected = meta.code === getLang();
		langSelect.append(option);
	}
	langSelect.addEventListener('change', () => {
		void setLang(langSelect.value);
	});

	const themeBtn = el('button', { 'class': 'icon-btn', 'type': 'button', 'title': t('toggleTheme'), 'aria-label': t('toggleTheme') }, [
		themeIcon(currentTheme()),
	]);
	themeBtn.addEventListener('click', () => {
		const theme = toggleTheme();
		themeBtn.setAttribute('aria-label', theme === 'dark' ? t('themeToLight') : t('themeToDark'));
		themeBtn.textContent = themeIcon(theme);
	});

	const userArea = el('div', { class: 'user-area', id: 'user-area' });

	inner.append(brand, el('div', { class: 'topbar-actions' }, [langSelect, themeBtn, userArea]));
	header.append(inner);
	return header;
}

function buildMain(): HTMLElement {
	const main = el('main', { class: 'container' });
	const heading = el('h1', { class: 'page-title' }, [siteTitle()]);
	const tagline = el('p', { class: 'page-tagline' }, [siteDescription()]);
	const portal = el('div', { class: 'portal-wrap', id: 'portal' });
	main.append(heading, tagline, portal);
	return main;
}

function buildFooter(): HTMLElement {
	const footer = el('footer', { class: 'container footer' });
	footer.append(
		el('p', {}, textWithLinks(t('footerNote'))),
		el('p', { class: 'footer-meta' }, [`${siteTitle()} · ${siteSubtitle()}`]),
	);
	return footer;
}

function registerServiceWorker(): void {
	if (!('serviceWorker' in navigator)) {
		return;
	}
	void navigator.serviceWorker.register('/sw.js').catch(() => {
		// SW 注册失败不阻塞页面
	});
}

/**
 * 处理回调错误标记（?login=failed|forbidden|unavailable），提示后清理 URL
 *
 * 带有 denied 身份（服务端暂存的签名 Cookie）时由拒绝卡片说明原因，避免重复提示。
 */
function handleLoginFlag(hasDenied: boolean): void {
	const params = new URLSearchParams(window.location.search);
	const flag = params.get('login');
	if (!flag) {
		return;
	}
	if (!hasDenied) {
		const message = flag === 'forbidden'
			? t('loginForbidden')
			: flag === 'unavailable'
				? t('loginUnavailable')
				: t('loginFailed');
		toast(message, 'error');
	}
	params.delete('login');
	const query = params.toString();
	window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

async function main(): Promise<void> {
	const root = document.getElementById(ROOT_ID);
	if (!root) {
		return;
	}

	await initI18n();
	initTheme();
	await loadConfig();

	document.documentElement.lang = getLang();
	document.title = siteTitle();
	// 描述同时用于页面副标题与搜索引擎摘要
	const metaDescription = document.querySelector('meta[name="description"]');
	if (metaDescription) {
		metaDescription.setAttribute('content', siteDescription());
	}

	root.append(buildHeader(), buildMain(), buildFooter());

	// 小屏滚动时收起顶栏；页脚是普通文档流内容，不需要收起
	initScrollChrome({ top: document.querySelector<HTMLElement>('.topbar') });

	const portalEl = document.getElementById('portal');
	const userArea = document.getElementById('user-area');
	if (!portalEl || !userArea) {
		return;
	}

	const handlers = {
		onRotate: async (): Promise<void> => {
			try {
				const result = await api.rotateToken();
				toast(result.incomplete ? t('rotateIncomplete') : t('rotateDone'), result.incomplete ? 'info' : 'success');
				await load(portalEl, handlers);
			}
			catch (ex) {
				const message = ex instanceof ApiError && ex.status === 409 ? t('busy') : t('rotateFailed');
				toast(message, 'error');
			}
		},
	};

	let status: AuthStatus;
	try {
		status = await api.loadAuthStatus();
	}
	catch {
		renderPortalError(portalEl, t('loadFailed'), () => window.location.reload());
		return;
	}

	renderAuth(userArea, status);

	// 登录态变化（会话过期自动登出）时刷新用户区与主卡片
	api.onAuthChange((next) => {
		renderAuth(userArea, next);
		if (!next.loggedIn) {
			renderGuest(portalEl, next.providerName || t('ssoLogin'));
		}
	});

	handleLoginFlag(Boolean(status.denied));

	if (!status.authEnabled) {
		renderPortalError(portalEl, t('authDisabled'), () => window.location.reload());
	}
	else if (status.loggedIn) {
		await load(portalEl, handlers);
	}
	else if (status.denied) {
		renderDenied(portalEl, status.denied);
	}
	else {
		renderGuest(portalEl, status.providerName || t('ssoLogin'));
	}

	registerServiceWorker();
}

void main();
