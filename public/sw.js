/* eslint-disable */
/* CPA Gate Service Worker
 * 缓存应用外壳（index/css/js/locales/icons）。
 * 策略：同源 GET 网络优先 + 缓存兜底，离线时可打开应用外壳。
 * 升级时修改 CACHE_VERSION 即可全量刷新缓存。 */
const CACHE_VERSION = 'cpa-shell-v2';
const CACHE_NAME = CACHE_VERSION;

const PRECACHE_URLS = [
	'/index.html',
	'/css/style.css',
	'/assets/main-EMSTU7XE.js',
	'/manifest.webmanifest',
	'/favicon.svg',
	'/locales/en.json',
	'/locales/zh-Hans.json',
	'/icons/icon-192.png',
	'/icons/icon-512.png',
	'/icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME)
			.then(cache => cache.addAll(PRECACHE_URLS))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys()
			.then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

async function networkFirst(request) {
	const cache = await caches.open(CACHE_NAME);
	const cacheKey = request.mode === 'navigate' ? '/index.html' : request.url;
	try {
		// 绕过 HTTP 缓存，确保 SW 始终拿到最新资源
		const response = await fetch(request, { cache: 'no-store' });
		if (response && response.ok) {
			const copy = response.clone();
			cache.put(cacheKey, copy).catch(() => {});
		}
		return response;
	}
	catch {
		const cached = await cache.match(cacheKey);
		if (cached) {
			return cached;
		}
		if (request.mode === 'navigate') {
			return cache.match('/index.html');
		}
		throw new Error('offline');
	}
}

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') {
		return;
	}
	const url = new URL(request.url);
	// 仅处理同源请求；/api/* 不缓存
	if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') {
		return;
	}
	event.respondWith(networkFirst(request));
});
