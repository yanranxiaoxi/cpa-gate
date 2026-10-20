import { CONFIG } from '../config/config';
import logger from '../utils/logger';
import { UpstreamError } from './errors';

/** 模型缓存（CLIProxyAPI 对所有 Key 提供同一份目录） */
let modelsCache: { expiresAt: number; models: string[] } | null = null;

/** 将上游异常统一转换为 UpstreamError，避免把底层细节泄露到响应 */
function toError(action: string, ex: unknown, status: number | null = null): UpstreamError {
	const message = ex instanceof Error ? ex.message : String(ex);
	return new UpstreamError('cpa_unavailable', `${action} failed: ${message}`, status);
}

/** 管理 API 请求；超时与网络错误统一抛出 cpa_unavailable */
async function managementRequest(path: string, init: RequestInit = {}): Promise<Response> {
	const url = `${CONFIG.cpa.managementUrl}/v0/management${path}`;
	const headers = new Headers(init.headers);
	headers.set('Authorization', `Bearer ${CONFIG.cpa.managementKey}`);
	if (init.body !== undefined) {
		headers.set('Content-Type', 'application/json');
	}
	try {
		const res = await fetch(url, {
			...init,
			headers,
			signal: AbortSignal.timeout(CONFIG.cpa.timeoutMs),
		});
		if (!res.ok) {
			throw new UpstreamError('cpa_upstream_error', `${init.method ?? 'GET'} ${path} returned ${res.status}`, res.status);
		}
		return res;
	}
	catch (ex) {
		if (ex instanceof UpstreamError) {
			throw ex;
		}
		throw toError(`${init.method ?? 'GET'} ${path}`, ex);
	}
}

/**
 * 读取 CLIProxyAPI 的客户端 Key 列表
 */
export async function listKeys(): Promise<string[]> {
	const res = await managementRequest('/api-keys');
	const data = (await res.json().catch(() => null)) as { 'api-keys'?: unknown } | null;
	const keys = data?.['api-keys'];
	if (!Array.isArray(keys)) {
		throw new UpstreamError('cpa_upstream_error', 'Unexpected api-keys response');
	}
	return keys.filter((key): key is string => typeof key === 'string');
}

/**
 * 幂等新增 Key
 *
 * PATCH { old: key, new: key }：Key 已存在时替换为自身，不存在时追加。
 * 不使用 PUT，避免覆盖其它来源的 Key。
 */
export async function ensureKey(key: string): Promise<void> {
	await managementRequest('/api-keys', {
		method: 'PATCH',
		body: JSON.stringify({ old: key, new: key }),
	});
}

/**
 * 按值删除 Key（不存在时上游同样返回成功，天然幂等）
 */
export async function deleteKey(key: string): Promise<void> {
	await managementRequest(`/api-keys?value=${encodeURIComponent(key)}`, {
		method: 'DELETE',
	});
}

/** 从 OpenAI 兼容响应中提取模型 ID */
function extractModels(payload: unknown): string[] {
	if (!payload || typeof payload !== 'object') {
		return [];
	}
	const data = payload as Record<string, unknown>;
	const list = Array.isArray(data.data)
		? data.data
		: Array.isArray(data.models)
			? data.models
			: Array.isArray(payload)
				? payload
				: [];

	const result: string[] = [];
	for (const item of list) {
		if (typeof item === 'string') {
			result.push(item);
			continue;
		}
		if (!item || typeof item !== 'object') {
			continue;
		}
		const entry = item as Record<string, unknown>;
		const id = entry.id ?? entry.name ?? entry.model;
		if (typeof id === 'string' && id.trim()) {
			result.push(id.trim());
		}
	}
	return result;
}

/**
 * 使用用户自己的 Token 查询可用模型
 *
 * 刚创建/轮换的 Key 可能需要极短时间才在上游生效，遇到 401 时做 3 次短重试。
 */
export async function listModels(token: string): Promise<{ models: string[]; unavailable: boolean }> {
	if (CONFIG.cpa.modelsCacheTtl > 0 && modelsCache && modelsCache.expiresAt > Date.now()) {
		return { models: modelsCache.models, unavailable: false };
	}

	// 始终走管理地址（服务端可达的内网地址），展示用的 CPA_API_BASE_URL 可能无法从本机回环访问
	const url = `${CONFIG.cpa.managementUrl}/v1/models`;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await fetch(url, {
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(CONFIG.cpa.timeoutMs),
			});
			if (res.status === 401 && attempt < 2) {
				await new Promise(resolve => setTimeout(resolve, 300));
				continue;
			}
			if (!res.ok) {
				logger.warn(`models request returned ${res.status}`);
				return { models: [], unavailable: true };
			}
			const payload = await res.json().catch(() => null);
			const models = [...new Set(extractModels(payload))].sort((a, b) => a.localeCompare(b));
			if (CONFIG.cpa.modelsCacheTtl > 0) {
				modelsCache = { models, expiresAt: Date.now() + CONFIG.cpa.modelsCacheTtl * 1000 };
			}
			return { models, unavailable: false };
		}
		catch (ex) {
			if (attempt < 2) {
				await new Promise(resolve => setTimeout(resolve, 300));
				continue;
			}
			logger.warn(`models request failed: ${(ex as Error)?.message ?? ex}`);
		}
	}
	return { models: [], unavailable: true };
}

/** 清空模型缓存（测试与诊断用） */
export function clearModelsCache(): void {
	modelsCache = null;
}
