/** 上游（CLIProxyAPI / Keycloak）调用失败的分类错误 */
export class UpstreamError extends Error {
	public readonly code: string;
	public readonly status: number | null;

	public constructor(code: string, message: string, status: number | null = null) {
		super(message);
		this.name = 'UpstreamError';
		this.code = code;
		this.status = status;
	}
}

/** 清理/轮换互斥锁等待超时 */
export class LockTimeoutError extends Error {
	public constructor() {
		super('Another key operation is still running');
		this.name = 'LockTimeoutError';
	}
}

/** 轮换时新 Key 已创建，但旧 Key 未完全删除 */
export class RotateIncompleteError extends Error {
	public readonly token: string;

	public constructor(token: string, cause: unknown) {
		super(`Failed to remove old keys: ${(cause as Error)?.message ?? 'unknown error'}`);
		this.name = 'RotateIncompleteError';
		this.token = token;
	}
}
