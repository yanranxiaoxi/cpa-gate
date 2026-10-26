import type { Theme } from './theme';
import type { AuthStatus, SiteText } from './types';
import * as api from './api';
import { getSiteConfig, getSiteTitle, loadConfig } from './api';
import { renderAuth } from './auth';
import { getLang, initI18n, setLang, SUPPORTED_LANGS, t } from './i18n';
import { load, renderDenied, renderGuest, renderPortalError } from './portal';
import { initScrollChrome } from './scroll-chrome';
import { initTheme, toggleTheme } from './theme';
import { ApiError } from './types';
import { el, textWithLinks, toast } from './ui';

const ROOT_ID = 'app';
/** 项目源码仓库：顶栏按钮跳转目标 */
const GITHUB_URL = 'https://github.com/yanranxiaoxi/cpa-gate';

/** 当前语言的服务端品牌文案（未配置时返回空对象） */
function siteText(): SiteText {
	return getSiteConfig().site?.[getLang()] ?? {};
}

/** 站点标题：当前语言的 SITE_TITLE_* 优先，否则用语言包默认文案 */
function siteTitle(): string {
	return getSiteTitle();
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

/**
 * GitHub 图标
 *
 * 用 createElementNS 而不是 innerHTML：项目里没有 HTML 拼接，
 * SVG 作为按钮内容同样按静态标记处理。
 */
function githubIcon(): SVGSVGElement {
	const NS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(NS, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	const path = document.createElementNS(NS, 'path');
	// GitHub mark（官方 16×16 路径）
	path.setAttribute('d', 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z');
	svg.append(path);
	return svg;
}

/** 顶栏 GitHub 按钮：新标签页打开，避免用户丢掉当前会话页面 */
function buildGithubLink(): HTMLAnchorElement {
	const link = el('a', {
		'class': 'icon-btn',
		'href': GITHUB_URL,
		'target': '_blank',
		'rel': 'noopener noreferrer',
		'title': t('githubLink'),
		'aria-label': t('githubLink'),
	});
	link.append(githubIcon());
	return link;
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

	inner.append(brand, el('div', { class: 'topbar-actions' }, [langSelect, themeBtn, buildGithubLink(), userArea]));
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

	// 先应用主题：不依赖语言包，避免等待网络与首屏闪白
	initTheme();
	await initI18n();
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
