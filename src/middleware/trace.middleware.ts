import type { IMiddleware } from '../utils/interface';
import logger from '../utils/logger';
import { applySecurityHeaders } from '../utils/security-headers';
import { traceId } from '../utils/utils';

const tracingMid: IMiddleware = async (ctx, next) => {
	// traceId 已经在创建 ctx 时设置，这里只需要设置响应头
	const requestId = ctx.req.headers['x-request-id'] ?? traceId();
	ctx.logger = logger.child({ traceId: requestId });
	ctx.res.setHeader('x-request-id', requestId);
	// 所有响应（含静态资源与 /api）统一附加安全头
	applySecurityHeaders(ctx.res);
	await next();
};

export default tracingMid;
