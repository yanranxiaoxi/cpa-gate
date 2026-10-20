import type { Venation } from '../utils/venation';
import admin from '../controller/admin.controller';
import auth from '../controller/auth.controller';
import frontend from '../controller/frontend.controller';
import portal from '../controller/portal.controller';
import sessionMid from '../middleware/session.middleware';
import traceMid from '../middleware/trace.middleware';

/** 匹配非 /api 开头的完整路径（前端页面与静态资源），排除 /api 及其子路径 */
const STATIC_PATH_REGEX = /(?!\/api(?:\/|$)).*/;

export default async (ven: Venation) => {
	await ven.router('', traceMid).then(async (root) => {
		// ===== API 组（携带会话解析中间件）=====
		await root.router('/api', sessionMid).then(async (api) => {
			// 公共配置
			api.get('/config', portal.config);

			// 认证
			await api.router('/auth').then((authSub) => {
				authSub.get('/status', auth.status);
				authSub.get('/login', auth.login);
				authSub.get('/callback', auth.callback);
				authSub.get('/logout', auth.logout);
			});

			// 登录用户页面数据
			api.get('/portal', portal.portal);
			api.post('/token/rotate', portal.rotate);

			// 运维清理接口（环境变量 Key 鉴权）
			api.post('/admin/keys/prune', admin.prune);
		});

		// ===== 前端页面与静态资源（其余所有 GET）=====
		root.get(STATIC_PATH_REGEX, frontend.staticFiles);
	});
};
