/**
 * 控制器基类
 *
 * 只负责把原型方法绑定到实例，使方法可以脱离对象被解构调用
 * （路由层以 `controller.method` 的形式传递处理函数）。
 */
export class Controller {
	public constructor() {
		this.bindMethods();
	}

	private bindMethods() {
		Object.getOwnPropertyNames(Object.getPrototypeOf(this))
			.filter(method => typeof (this as any)[method] === 'function')
			.forEach((method) => {
				(this as any)[method] = (this as any)[method].bind(this);
			});
	}
}
