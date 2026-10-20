export type ToastType = 'info' | 'error' | 'success';

let toastTimer: number | undefined;

/**
 * 简易 toast 提示
 */
export function toast(message: string, type: ToastType = 'info'): void {
	let box = document.getElementById('toast-box');
	if (!box) {
		box = document.createElement('div');
		box.id = 'toast-box';
		box.className = 'toast-box';
		document.body.appendChild(box);
	}
	const item = document.createElement('div');
	item.className = `toast toast-${type}`;
	item.textContent = message;
	box.appendChild(item);
	window.clearTimeout(toastTimer);
	toastTimer = window.setTimeout(() => {
		box?.replaceChildren();
	}, 3500);
}

/**
 * 创建元素的小工具
 */
export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	children: Array<HTMLElement | string> = [],
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		node.setAttribute(key, value);
	}
	for (const child of children) {
		node.append(child);
	}
	return node;
}

/**
 * 把文案中的 Markdown 行内链接语法 `[文字](url)` 渲染为 DOM 节点数组。
 *
 * 用于 footerNote 这类需要内嵌链接的文案；只接受 http/https 链接，
 * 其余按纯文本处理，避免 javascript: 等危险协议（文案来自本地 locale 文件，
 * 但仍按不可信输入处理）。不解析其它 Markdown 语法。
 */
export function textWithLinks(text: string): Array<HTMLElement | string> {
	const nodes: Array<HTMLElement | string> = [];
	const regex = /\[([^\]]+)\]\(([^)\s]+)\)/g;
	let lastIndex = 0;
	for (const match of text.matchAll(regex)) {
		const [full, label, href] = match;
		const index = match.index ?? 0;
		if (index > lastIndex) {
			nodes.push(text.slice(lastIndex, index));
		}
		if (/^https?:\/\//i.test(href)) {
			const a = document.createElement('a');
			a.textContent = label;
			a.href = href;
			a.target = '_blank';
			a.rel = 'noopener noreferrer';
			nodes.push(a);
		}
		else {
			// 非法协议：原样输出为文本
			nodes.push(full);
		}
		lastIndex = index + full.length;
	}
	if (lastIndex < text.length) {
		nodes.push(text.slice(lastIndex));
	}
	return nodes.length ? nodes : [text];
}

/**
 * 生成文件名对应的下载文件名（从 translatedFileUrl 中解析）
 */
export function fileNameFromUrl(url: string): string {
	try {
		const name = new URL(url).pathname.split('/').filter(Boolean).pop();
		return name || 'translation';
	}
	catch {
		return 'translation';
	}
}

/**
 * 触发浏览器下载
 */
export function triggerDownload(url: string): void {
	const a = document.createElement('a');
	a.href = url;
	a.download = fileNameFromUrl(url);
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
}

/**
 * 复制文本到剪贴板
 *
 * 优先使用 Clipboard API；不可用（非安全上下文、旧浏览器）时退化为
 * 临时 textarea + execCommand，失败返回 false 由调用方提示。
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	}
	catch {
		// 退化为下面的兜底方案
	}
	try {
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.setAttribute('readonly', '');
		textarea.style.position = 'fixed';
		textarea.style.opacity = '0';
		document.body.appendChild(textarea);
		textarea.select();
		const ok = document.execCommand('copy');
		textarea.remove();
		return ok;
	}
	catch {
		return false;
	}
}
