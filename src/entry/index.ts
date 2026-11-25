import { CONFIG, isLoopbackUrl } from '../config/config';
import venRouter from '../router';
import { startPruneScheduler } from '../service/prune-scheduler';
import logger from '../utils/logger';
import { Venation } from '../utils/venation';
import { VenNodeDriver } from '../utils/venation/driver';

(async () => {
	const driver = new VenNodeDriver(logger);
	const venation = new Venation(logger);
	venation.addDriver(driver);
	await venRouter(venation);

	// 启动服务器
	driver.listen(CONFIG.host, CONFIG.port);
	logger.info(`Server started on ${CONFIG.host}:${CONFIG.port}`);

	// 客户端访问不到服务端视角的回环地址，这类配置几乎总是错的；
	// 但容器编排里可能出现自引用域名，因此只告警、不阻止启动
	if (CONFIG.keycordon.enabled && isLoopbackUrl(CONFIG.keycordon.url)) {
		logger.warn(`KEYCORDON_URL=${CONFIG.keycordon.url} is a loopback address; clients outside this host cannot reach it`);
	}

	// 定期清理已失去资格的 Key（无数据库设计下撤销完全依赖它）
	startPruneScheduler();
})();
