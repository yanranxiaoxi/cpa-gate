# KeyCordon 集成改造方案

> 状态：**已实现**（本文保留为实现记录与验收依据）
> 目标版本：cpa-gate（本文所有路径均相对 `cpa-gate/`）
> 关联项目：`../keycordon`（Go，反向代理，扫描并替换请求体中的密钥）

本文是可执行的实施清单：每个小节列出改动文件、改动内容与验收方式，后续按此执行。

---

## 0. 前置确认（已与项目负责人确认）

| 编号 | 议题 | 结论 |
| --- | --- | --- |
| 1 | 8318 端口暴露公网的防滥用 | **在 keycordon 项目内单独处理**，本方案不作为问题 |
| 2 | 主密钥持久化 | 镜像**强制**由 `KEYCORDON_MASTER_KEY` 环境变量提供，不落盘 |
| 3 | keycordon 进程异常 | **fail fast**：任一进程退出，容器整体退出 |
| 4 | `CPA_MANAGEMENT_URL` 作为默认 upstream 的陷阱 | 按建议处理：启动时校验，指向自身端口直接拒绝启动 |
| 5 | 页面开关打开时，快速配置的 deep link | **跟着换成 KeyCordon 地址** |
| 6 | 开关状态的持久化 | localStorage 持久化；环境变量只作**首次默认值** |
| 7 | 窄屏布局 | 两个开关在 ≤720px 时换到独立一行 |
| 8 | 镜像内 keycordon 的来源 | 构建时从软件包仓库取**最新非 nightly 版本**的 `linux_amd64` 二进制；允许不可复现 |
| 9 | 反向代理必须保留客户端凭据 | 写入部署文档，并给出 Caddy / nginx 最小配置 |
| 10 | `/api/config` 的 1 小时缓存 | 无所谓（本方案把 keycordon 字段放在 `/api/portal`，不受影响） |
| 11 | `providerId` 因域名变化而不同 | 符合预期：用户在客户端里会看到两个独立条目 |
| 12 | 地址推导 | 复用现有 `endpoints()`，不重复实现路径规则 |
| 13 | keycordon 的 `mode: observe` 灰度 | 写入部署文档 |

---

### 0.1 已实测确认的事实（避免方案落空）

| 事项 | 实测结果 |
| --- | --- |
| 包仓库匿名可读 | `GET https://gitlab.soraharu.com/api/v4/projects/168/packages?package_type=generic` 无需 token 即返回 `0.1.0` 与 `nightly` |
| 二进制可下载 | `keycordon_0.1.0_linux_amd64`：14,139,552 字节，`ELF 64-bit LSB executable, x86-64, statically linked, stripped`；下载地址返回 **302**，必须 `curl -L` |
| 版本列表顺序 | API 默认按 `created_at` 排序，返回 `nightly` 在前——**不能取第一条**，必须自己按语义化版本排序并排除 `nightly` |
| `master_key_scope: env` | 配置项有效；缺失时 keycordon 自身报 `vault: environment variable KEYCORDON_MASTER_KEY is not set` |
| `protocols.extra_dir` | 默认值 `~/.config/keycordon/protocols` 在容器内不存在，`os.Stat` 失败即跳过，无需挂载也无需覆盖 |
| `limits.max_body_bytes` 默认 | **8 MiB**（不是 32 MiB），`max_decoded_bytes` / `max_response_bytes` 为 16 MiB；超限返回 413 且**不透传** |
| 健康检查免鉴权 | `/_keycordon/healthz` 在 caller 凭据校验**之前**处理，匿名 `curl` 即可，返回 `{status, version, mode, master_key_fingerprint, …}` |
| `serve` 的 flag | `-config FILE`、`-listen ADDR`、`-upstream URL` 三个，`-upstream` 覆盖配置文件里的值 |
| entrypoint 脚本 | 已在本机用 `sh` 跑通 6 个场景（见 4.5） |

---

## 1. 环境变量设计

### 1.1 cpa-gate 进程读取（两个镜像都有）

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `KEYCORDON_ENABLED` | 否 | `false` | `true` 时启用集成：`/api/portal` 下发 KeyCordon 地址，页面显示开关 |
| `KEYCORDON_URL` | 启用时必填 | — | KeyCordon 的**外部暴露地址**（客户端实际访问的地址），如 `https://kc.example.com`。仅用于展示，服务端不会去连接它 |
| `KEYCORDON_DEFAULT_ON` | 否 | `false` | 页面开关的**首次**默认状态；用户手动切换后以 localStorage 为准 |

### 1.2 `-keycordon` 镜像额外读取

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `KEYCORDON_UPSTREAM` | 否 | `$CPA_MANAGEMENT_URL` | 打包进来的 keycordon 的上游地址（容器内可达地址） |
| `KEYCORDON_MASTER_KEY` | **是** | — | 主密钥，64 位 hex 或 base64 的 32 字节。缺失则容器拒绝启动 |

> **命名说明**：前三个属于 cpa-gate 的展示配置，后两个属于 keycordon 进程本身。四个变量在 `-keycordon` 镜像中**同时存在**，文档必须写清区别——尤其 `KEYCORDON_URL`（外部）与 `KEYCORDON_UPSTREAM`（容器内）不要混用。
>
> 生成主密钥：
> ```sh
> head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
> ```

### 1.3 启动期校验（`src/config/config.ts`）

```ts
/** 布尔型环境变量：与既有 OIDC_ALLOW_INSECURE 保持同一约定 */
const envFlag = (name: string) => process.env[name] === 'true' || process.env[name] === '1';

/**
 * KeyCordon 集成的展示地址
 *
 * 只在 `KEYCORDON_ENABLED` 为真时校验：未启用时允许留空，
 * 这样基础镜像的用户完全不需要关心这三个变量。
 */
function resolveKeycordon(): { enabled: boolean; url: string; defaultOn: boolean } {
	const enabled = envFlag('KEYCORDON_ENABLED');
	const defaultOn = envFlag('KEYCORDON_DEFAULT_ON');
	if (!enabled) {
		return { enabled: false, url: '', defaultOn };
	}
	const url = trimSlash(validateEnvVar('KEYCORDON_URL', process.env.KEYCORDON_URL));
	let parsed: URL;
	try {
		parsed = new URL(url);
	}
	catch {
		throw new Error(`Invalid environment variable KEYCORDON_URL: not a valid URL: ${url}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`Invalid environment variable KEYCORDON_URL: only http/https allowed, got ${parsed.protocol}`);
	}
	return { enabled, url, defaultOn };
}
```

`CONFIG.keycordon = resolveKeycordon();`

规则：

1. `enabled === false` → 其余字段忽略，`url` 允许为空（基础镜像的行为完全不变）；
2. `enabled === true` 且 `url` 为空 → 抛错退出，信息写明 `Required environment variable KEYCORDON_URL is not set`；
3. `url` 必须能被 `new URL()` 解析且协议为 `http:` / `https:`，否则抛错；
4. 末尾斜杠用既有的 `trimSlash()` 去掉，避免下发 `https://kc.example.com//v1`；
5. 回环地址（`localhost` / `127.0.0.1` / `::1` / `[::1]`）只打 **warn**，不阻止启动：客户端无法访问回环地址，通常说明配错了，但容器编排里可能出现自引用域名，硬拦会把合法部署挡在门外。

> 遵循项目的既有风格：配置在该模块顶层求值、启动即失败，不做延迟校验。
>
> `config.ts` 里没有 logger（它只做纯求值），因此回环 warn 放在 `src/entry/index.ts` 里、`logger` 可用之后：
>
> ```ts
> if (CONFIG.keycordon.enabled && isLoopbackUrl(CONFIG.keycordon.url)) {
>     logger.warn(`KEYCORDON_URL=${CONFIG.keycordon.url} is a loopback address; clients outside this host cannot reach it`);
> }
> ```
>
> `isLoopbackUrl()` 放在 `config.ts` 里导出（纯函数，便于单测），判断 `new URL(url).hostname` 是否属于 `localhost` / `127.0.0.0/8` / `::1`。

---

## 2. 服务端改动

### 2.1 `src/controller/portal.controller.ts`

**复用现有推导函数**（不新增路径规则）：

```ts
/** 各协议的调用地址；base 决定站点根，缺省用 CPA_API_BASE_URL */
function endpoints(base: string = CONFIG.cpa.apiBaseUrl) {
    return {
        openai: { base: `${base}/v1`, full: `${base}/v1/chat/completions` },
        anthropic: { base, full: `${base}/v1/messages` },
        gemini: { base: `${base}/v1beta`, full: `${base}/v1beta/models/{model}:generateContent` },
    };
}
```

`callUrl()` 保持不变（仍取 `endpoints().openai.base`）。

`GET /api/portal` 的响应体新增字段（**仅在 `CONFIG.keycordon.enabled` 为真时下发**）：

```jsonc
{
  // …既有字段
  "keycordon": {
    "callUrl": "https://kc.example.com/v1",
    "endpoints": { "openai": {…}, "anthropic": {…}, "gemini": {…} },
    "defaultOn": false
  }
}
```

实现要点：

- `keycordon.callUrl = endpoints(CONFIG.keycordon.url).openai.base`
- `keycordon.endpoints = endpoints(CONFIG.keycordon.url)`
- 未启用时**整个字段省略**（不是 `null`、不是空对象），前端据此判断是否渲染开关
- `/api/portal` 已有 `Cache-Control: no-store`，无需额外处理

`GET /api/config` **不改**（避免 1 小时缓存带来的困惑，见议题 10）。

### 2.2 `src/frontend/types.ts`

```ts
/** KeyCordon 集成（未启用时后端不下发该字段） */
export interface KeycordonConfig {
    /** KeyCordon 外部地址的 OpenAI 兼容基址（已含 /v1） */
    callUrl: string;
    /** KeyCordon 外部地址的各协议调用地址 */
    endpoints: Endpoints;
    /** 开关首次默认状态；用户手动切换后以 localStorage 为准 */
    defaultOn: boolean;
}

export interface PortalData {
    // …既有字段
    keycordon?: KeycordonConfig;
}
```

---

## 3. 前端改动

### 3.1 地址切换机制：从 1 组地址扩展到 2×2 矩阵

现状：每个地址元素带 `data-base` / `data-full`，`applyFullUrl()` 按「完整 URL」开关就地替换文本。

改造后需要同时考虑两个维度：**是否走 KeyCordon** × **是否显示完整 URL**。继续用数据属性，不做 DOM 重建：

```ts
/**
 * 生成一个可切换显示形态的 URL 元素
 *
 * 四个 data-* 保存「直连 / KeyCordon」×「基址 / 完整路径」的全部组合，
 * 切换开关时只改文本、不重建 DOM；复制按钮在点击时读取当前文本，
 * 因此复制的就是屏幕上看到的地址。
 */
function urlCode(base: string, full: string, className: string, alt?: ProtocolEndpoint): HTMLElement {
    return el('code', {
        'class': `${className} mono url-value`,
        'data-base': base,
        'data-full': full,
        'data-kc-base': alt?.base ?? '',
        'data-kc-full': alt?.full ?? '',
    }, [currentUrl(base, full)]);
}
```

> 初始文本不用在这里算：`renderPortal()` 末尾统一调一次 `applyUrls()`，首帧就是正确值，避免两处逻辑分叉。

统一的重算函数（替换现有 `applyFullUrl()`）：

```ts
/** 一个地址元素在「两个开关」下的最终文本 */
function resolveUrlText(node: HTMLElement, kc: boolean): string | null {
    const d = node.dataset;
    const base = kc && d.kcBase ? d.kcBase : d.base;
    const full = kc && d.kcFull ? d.kcFull : d.full;
    if (!base || !full) {
        return null;
    }
    return showFullUrl ? full : base;
}

/** 按两个开关的当前状态刷新所有地址元素与导入链接 */
function applyUrls(): void {
    const kc = useKeycordon === true;
    for (const node of document.querySelectorAll<HTMLElement>('.url-value')) {
        const text = resolveUrlText(node, kc);
        if (text !== null) {
            node.textContent = text;
        }
    }
    applyQuickConfigHrefs(kc);      // 见 3.3
}
```

「完整 URL」开关的回调从 `applyFullUrl()` 改为 `applyUrls()`。

> 注意：`el()` 是 `setAttribute(key, value)` 原样写入，所以属性名必须带前缀写成 `'data-kc-base'`；读取时用 `node.dataset.kcBase`（会自动去掉 `data-` 并转驼峰）。写成 `'kcBase'` 会变成属性 `kcBase`，`dataset` 读不到。

### 3.2 KeyCordon 开关

三态：`boolean | null`（`null` = 用户从未选择过，尚未决定）。

```ts
/** KeyCordon 开关的 localStorage 键 */
const KEYCORDON_KEY = 'cpa-keycordon';

/** 用户的选择：null 表示从未选择，此时用服务端的 defaultOn */
let useKeycordon: boolean | null = readKeycordonPreference();

function readKeycordonPreference(): boolean | null {
    try {
        const raw = localStorage.getItem(KEYCORDON_KEY);
        return raw === '1' ? true : raw === '0' ? false : null;
    }
    catch {
        return null;    // 隐私模式：退回到底层默认值
    }
}
```

渲染时解析一次（**只在拿到 `PortalData` 之后**）：

```ts
function resolveKeycordon(data: PortalData): boolean {
    if (!data.keycordon) {
        return false;                       // 后端未启用
    }
    if (useKeycordon === null) {
        useKeycordon = data.keycordon.defaultOn;
    }
    return useKeycordon;
}
```

开关 DOM：

```ts
/** KeyCordon 开关（仅在后端下发 keycordon 字段时渲染） */
function keycordonSwitch(onChange: (on: boolean) => void): HTMLElement {
    const input = el('input', { class: 'switch-input', type: 'checkbox' }) as HTMLInputElement;
    input.checked = useKeycordon === true;
    input.addEventListener('change', () => {
        useKeycordon = input.checked;
        saveKeycordonPreference(useKeycordon);
        onChange(useKeycordon);
    });
    return el('label', { class: 'switch', title: t('keycordonHint') }, [
        input,
        el('span', { class: 'switch-track' }),
        el('span', { class: 'switch-text' }, [t('keycordonToggle')]),
    ]);
}
```

```ts
function saveKeycordonPreference(value: boolean): void {
    try {
        localStorage.setItem(KEYCORDON_KEY, value ? '1' : '0');
    }
    catch { /* 忽略 */ }
}
```

### 3.3 快速配置 deep link 跟随切换（议题 5）

`quickConfigSection()` 里的三个 `<a>` 需要两组 URL。保留既有构建函数，各算一次：

```ts
const directBase = data.callUrl;
const kcBase = data.keycordon?.callUrl;

// providerId 取自域名，两组地址必须各算一次（议题 11：域名不同 → id 不同）
const directId = parseProviderIdFromBaseUrl(data.endpoints?.anthropic.base || directBase);
const kcId = kcBase ? parseProviderIdFromBaseUrl(kcBase) : '';

const tools = [
    {
        name: 'Cherry Studio',
        href: buildCherryStudioUrl({ id: directId, name: siteName, baseUrl: directBase, apiKey }),
        hrefKc: kcBase
            ? buildCherryStudioUrl({ id: kcId, name: siteName, baseUrl: kcBase, apiKey })
            : '',
        hint: t('cherryStudioHint'),
    },
    // Chatbox 用 callUrl，OpenCat 用 baseUrl，各自同理
];
```

渲染时为每个 `<a>` 写入 `href`（直连，作为默认值）、`data-href` 与 `data-href-kc`：

```ts
const a = el('a', {
    class: 'btn small ghost quick-config-btn',
    href: tool.href,
    'data-href': tool.href,
    'data-href-kc': tool.hrefKc,
    target: '_blank',
    rel: 'noopener noreferrer',
    title: tool.hint,
    'aria-label': tool.hint,
}, [tool.name]);
```

由 `applyQuickConfigHrefs(kc)` 统一切换：

```ts
/** 切换快速配置链接；未提供 KeyCordon 版本时保持直连 */
function applyQuickConfigHrefs(kc: boolean): void {
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[data-href]')) {
        const { href, hrefKc } = a.dataset;
        a.href = kc && hrefKc ? hrefKc : href ?? a.href;
    }
}
```

> 属性必须写成 `'data-href-kc'`，读取时是 `dataset.hrefKc`（`-kc` 转驼峰成 `Kc`）。写成 `'hrefKc'` 会变成无意义属性，`dataset` 读不到。

> 开关状态变化时，`applyUrls()` 与 `applyQuickConfigHrefs()` 必须一起执行（`applyUrls()` 内部已调用后者），否则会出现「页面地址已换、导入链接没换」的不一致。

### 3.4 布局（议题 7）

把两个开关放进同一个容器，取代现在直接塞进 `.portal-label-extra` 的单个节点：

```ts
const actions = el('div', { class: 'portal-label-extra switch-group' });
if (data.keycordon) {
    actions.append(keycordonSwitch(() => applyUrls()));
}
actions.append(fullUrlSwitch());
```

CSS：

```css
/* 标签右侧的开关组；窄屏时整组换到独立一行 */
.portal-label-extra {
    margin-left: auto;
}

.switch-group {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

@media (max-width: 720px) {
    /* 两个开关在窄屏放不下，独占一行并靠左 */
    .portal-label-extra {
        flex-basis: 100%;
        margin-left: 0;
    }

    .switch-group {
        justify-content: flex-start;
    }
}
```

文案要短，完整说明放 `title`：中文「KeyCordon 隐私保护」/ 英文「KeyCordon privacy」。

### 3.5 国际化（`public/locales/{zh-Hans,en}.json`）

| key | zh-Hans | en |
| --- | --- | --- |
| `keycordonToggle` | `KeyCordon 隐私保护` | `KeyCordon privacy` |
| `keycordonHint` | `启用后，下面三个地址将指向 KeyCordon 代理；发送给模型的请求中的密钥会被替换成占位符` | `When on, the three endpoints below point at the KeyCordon proxy, which replaces secrets in requests with placeholders` |

### 3.6 需要重构的既有函数

| 函数 | 改动 |
| --- | --- |
| `currentUrl()` | 保留不动，只按 `showFullUrl` 选形态；地址组的选择交给 `resolveUrlText()` |
| `applyFullUrl()` | 删除，由 `applyUrls()` 取代 |
| `urlCode()` | 增加可选的 `alt?: ProtocolEndpoint` 参数，写入 `data-kc-base` / `data-kc-full` |
| `endpointRow()` | 增加 `alt` 参数并透传给 `urlCode()` |
| `callSection()` | 主行与两条附加行都传入 KeyCordon 的 `ProtocolEndpoint`；`.portal-label-extra` 里的单个开关改为 `.switch-group` |
| `quickConfigSection()` | 生成两组 deep link，写到 `data-href` / `data-href-kc` |
| `renderPortal()` | 开头调 `resolveKeycordon(data)`，末尾调 `applyUrls()` |

`renderPortal()` 的调用时机很关键：

```ts
export function renderPortal(container, data, handlers) {
    // …
    if (!data.eligible) { /* 早退，不涉及地址 */ }
    if (!data.token) { /* 早退，不涉及地址 */ }

    resolveKeycordon(data);         // 1. 先定下开关状态

    card.append(
        callSection(data),
        section(t('personalToken'), data.token, [copyButton(data.token), rotate]),
        quickConfigSection(data),
    );
    // …modelSection

    container.replaceChildren(card); // 2. 节点进 DOM
    applyUrls();                     // 3. 再统一刷新（querySelectorAll 只能看到已入树的节点）
}
```

必须在 `replaceChildren` **之后**调用 `applyUrls()`：`document.querySelectorAll` 看不到游离节点，提前调用等于什么都没做，首帧会显示 `urlCode()` 里的初始文本（直连地址），开关却是打开的——正好是最容易误判为「开关无效」的表现。

`section()` 的 `headExtra` 参数保持原样，KeyCordon 开关只出现在调用地址区块，不扩散到「个人 Token」等其它区块。

---

## 4. 镜像改造

### 4.1 新增文件

| 路径 | 作用 |
| --- | --- |
| `Dockerfile.keycordon` | 在基础镜像之上加入 keycordon 二进制与双进程入口 |
| `keycordon-integration/entrypoint.sh` | 双进程编排 + 参数校验 + fail fast |
| `keycordon-integration/config.yaml` | keycordon 容器内配置（env 主密钥、监听 8318） |
| `.gitignore` | 追加 `keycordon-integration/keycordon-linux-amd64`（构建时下载的二进制，不入版本库） |

> **目录名说明**：现有 `.dockerignore` 排除了 `config`，因此 keycordon 的配置文件不能放在 `config/` 下，否则进不了构建上下文。

### 4.2 `keycordon-integration/config.yaml`

只写**需要偏离默认值**的项，其余交给 keycordon 自己的默认值（默认值随上游版本演进，抄一遍会僵化）：

```yaml
# 打包进 -keycordon 镜像的 keycordon 配置。
# 上游由 entrypoint.sh 通过 -upstream 传入（KEYCORDON_UPSTREAM 或 CPA_MANAGEMENT_URL）。

# 容器内必须监听 0.0.0.0，否则宿主/其它容器都连不上
listen: 0.0.0.0:8318

mode: enforce

vault:
  # 主密钥只从环境变量读取：容器内没有持久卷，file 模式每次重启都会重新生成，
  # 导致历史占位符全部失效并让上游 prompt cache 重算
  master_key_scope: env
  master_key_env: KEYCORDON_MASTER_KEY

caller:
  # 监听 0.0.0.0 时要求请求带凭据，否则所有匿名客户端共用一个 vault
  require_on_non_loopback: true

log:
  level: info
  format: json
```

**不要**在配置文件里重复这些默认值（`protocols.unsupported_ai_policy: reject`、`protocols.detect_unregistered: true`、`request.inject_instruction/inject_always: true`、`restore.enabled: true`、`limits.*`）——它们是 keycordon 的内置默认，重写一遍只会让将来升级时误判「这是我们刻意定的」。

`protocols.extra_dir` 也刻意**不写**：默认值 `~/.config/keycordon/protocols` 在容器内指向 user 10001 的 home，`os.Stat` 失败即跳过，无副作用；写空串同样是跳过，但显式声明容易让人以为需要挂载。

### 4.3 关于请求体上限（写入部署文档的注意事项）

keycordon 默认 `limits.max_body_bytes: 8 MiB`，**超限直接 413**，不会透传。这与 CLIProxyAPI 直连时的行为不同，因此：

- 只发文本的用户无感知（8 MiB 覆盖 2M token 纯文本请求）
- 一次请求带多张图片（十张 4 MiB PNG ≈ 53 MiB）会 413
- 文档要给出覆盖方式：挂载自定义配置把 `limits.max_body_bytes` 调大，并提醒「内存 = 并发数 × max_decoded_bytes」

### 4.4 `keycordon-integration/entrypoint.sh`

```sh
#!/bin/sh
# cpa-gate + keycordon 双进程入口。
# 任一进程退出即整体退出（fail fast），避免「开关显示已启用但实际没生效」。
set -eu

die() { echo "[entrypoint] $*" >&2; exit 1; }

[ -n "${KEYCORDON_MASTER_KEY:-}" ] \
  || die "KEYCORDON_MASTER_KEY is required (64-char hex or base64 of 32 bytes)"

UPSTREAM="${KEYCORDON_UPSTREAM:-${CPA_MANAGEMENT_URL:-}}"
[ -n "$UPSTREAM" ] \
  || die "KEYCORDON_UPSTREAM is empty and CPA_MANAGEMENT_URL is not set"

# 防止把 keycordon 自己当成上游：一旦成环，请求会在两个代理之间往返
case "$UPSTREAM" in
  *:8318|*:8318/*) die "KEYCORDON_UPSTREAM must not point at keycordon itself (8318): $UPSTREAM" ;;
esac

# 容器内的 127.0.0.1 指向容器自己；除非上游与本站同容器，否则通常配错了
case "$UPSTREAM" in
  http://127.0.0.1:*|http://localhost:*|'http://[::1]:'*)
    echo "[entrypoint] warn: KEYCORDON_UPSTREAM=$UPSTREAM is loopback; nothing is likely listening there in this container" >&2 ;;
esac

echo "[entrypoint] keycordon upstream: $UPSTREAM"

keycordon serve -config /etc/keycordon/config.yaml -upstream "$UPSTREAM" &
KC_PID=$!
node /home/node/app/index.js &
NODE_PID=$!

shutdown() {
  trap - TERM INT
  kill -TERM "$KC_PID" "$NODE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# 轮询存活：BusyBox ash 没有可移植的 `wait -n`，这里用 kill -0 判断
rc=0
while kill -0 "$KC_PID" 2>/dev/null && kill -0 "$NODE_PID" 2>/dev/null; do
  sleep 1
done
if ! kill -0 "$KC_PID" 2>/dev/null; then
  wait "$KC_PID" || rc=$?
  echo "[entrypoint] keycordon exited (rc=$rc); stopping container" >&2
else
  wait "$NODE_PID" || rc=$?
  echo "[entrypoint] cpa-gate exited (rc=$rc); stopping container" >&2
fi

trap - TERM INT
kill -TERM "$KC_PID" "$NODE_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit "$rc"
```

> 注意 `exit 0` 只用于 `shutdown()`：`docker stop` 是人为操作，不该报失败。进程自己挂掉时用 `exit "$rc"` 保留退出码，便于 `docker inspect` 与重启策略判断。

### 4.5 entrypoint 已做的验证

脚本已在本机用 `sh` 逐项跑过（把两条命令换成 `sleep` / `exit` 桩）：

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 未设 `KEYCORDON_MASTER_KEY` | 退出 1，报错 | ✅ `exit=1` |
| 未设 `KEYCORDON_UPSTREAM` 且无 `CPA_MANAGEMENT_URL` | 退出 1，报错 | ✅ `exit=1` |
| `KEYCORDON_UPSTREAM=http://x:8318` | 退出 1，防环 | ✅ `exit=1` |
| 未设 `KEYCORDON_UPSTREAM`，`CPA_MANAGEMENT_URL` 为回环 | warn 后继续运行 | ✅ 打印 warn 并启动 |
| keycordon 以 7 退出 | 整体退出 7 | ✅ `exit=7` |
| 向 entrypoint 发 SIGTERM | 两个子进程都收到 TERM，无残留 | ✅ 两侧都写入标记，`leftover children: 0` |

### 4.6 `Dockerfile.keycordon`

复用现有 `Dockerfile` 的全部内容（node 基础、pnpm 安装、`dist/` 拷贝、非 root、日志目录授权），在其上追加：

```dockerfile
FROM docker.io/library/node:24-alpine
# …与 Dockerfile 完全相同的前半段（ENV / WORKDIR / pnpm install / COPY dist / logs / USER node）

# tini 作为 PID 1：回收僵尸进程并把信号转给整个进程组
RUN apk add --no-cache tini

# keycordon：构建期由 CI 从软件包仓库下载的静态二进制（CGO_ENABLED=0）
ARG KEYCORDON_VERSION=unknown
LABEL org.opencontainers.image.keycordon.version=$KEYCORDON_VERSION
COPY --chmod=0755 keycordon-integration/keycordon-linux-amd64 /usr/local/bin/keycordon
COPY keycordon-integration/config.yaml /etc/keycordon/config.yaml
COPY --chmod=0755 keycordon-integration/entrypoint.sh /usr/local/bin/entrypoint.sh

# 该镜像默认就启用集成；忘记设置 KEYCORDON_URL 会在启动时立刻失败（fail fast）
ENV KEYCORDON_ENABLED=true

EXPOSE 3001
EXPOSE 8318

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:3001/api/config >/dev/null \
   && wget -q -O- http://127.0.0.1:8318/_keycordon/healthz >/dev/null \
   || exit 1

ENTRYPOINT ["/sbin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
```

要点：

- 二进制是静态链接（已实测：`ELF 64-bit LSB executable, x86-64, statically linked`），可直接跑在 alpine 上，无需 Go 运行时
- `tini -g` 让信号发给整个进程组，`docker stop` 才能同时终止两个子进程
- `HEALTHCHECK` 同时探测两个端口：keycordon 挂了容器即被标记 unhealthy。`/_keycordon/healthz` 在 caller 凭据校验**之前**处理（已实测），因此匿名 `wget` 可用
- **不声明 `VOLUME`**：主密钥走环境变量，容器内无需持久化目录
- `ENV KEYCORDON_ENABLED=true` 是一个**可推翻的取舍**：好处是 `-keycordon` 镜像开箱即用，不会出现「装了 keycordon 但页面没开关」的困惑；代价是忘了给 `KEYCORDON_URL` 时容器直接退出（fail fast，符合议题 3）。若希望「装了也不启用」，删掉这行、改为运行时显式 `-e KEYCORDON_ENABLED=true` 即可

---

## 5. CI 改造（`.gitlab-ci.yml`）

### 5.1 新增变量

变量必须写在 `docker-build-keycordon` **自己的** `variables:` 块里。写进别的 job（或误放在 `docker-build` 的块里）不会继承——GitLab 的 job 级 `variables` 只作用于该 job，`set -u` 下会直接报 `KEYCORDON_PROJECT_ID: parameter not set`。

```yaml
docker-build-keycordon:
  # …stage / tags / image / services
  variables:
    DOCKER_HOST: tcp://docker:2375
    DOCKER_TLS_CERTDIR: ''
    CONTAINER_IMAGE_NAME: cpa-gate
    # keycordon 软件包仓库（公开项目，可匿名读取；已实测可取到版本列表与二进制）
    KEYCORDON_PROJECT_ID: 168
    KEYCORDON_PACKAGE_NAME: keycordon
    KEYCORDON_IMAGE_TAG: latest-keycordon
```

`CONTAINER_IMAGE_NAME` 同样要在这个 job 里重复声明：`docker-build` 那份不会跨 job 继承。

### 5.2 新增 job

```yaml
docker-build-keycordon:
  stage: docker
  tags: [linux, docker, amd64, mpc]
  image: docker.io/library/docker:cli
  services:
    - name: docker.io/library/docker:dind
      alias: docker
  variables:
    DOCKER_HOST: tcp://docker:2375
    DOCKER_TLS_CERTDIR: ''
  dependencies:
    - npm-build
  before_script:
    # docker:cli 基于 alpine，默认不带 curl
    - apk add --no-cache curl
    - echo "$DOCKERHUB_PASSWORD" | docker login -u "$DOCKERHUB_USER" --password-stdin docker.io
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin $CI_REGISTRY
  script:
    # 1. 取软件包仓库里最新的发布版本（排除 nightly，按语义化版本排序）
    - |
      set -eu
      api="${CI_API_V4_URL}/projects/${KEYCORDON_PROJECT_ID}/packages"
      ver=$(curl -sf "${api}?package_type=generic&per_page=100" \
        | grep -o '"version":"[^"]*"' | cut -d'"' -f4 \
        | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
        | awk -F. '{printf "%09d%09d%09d %s\n", $1, $2, $3, $0}' \
        | sort | tail -1 | cut -d' ' -f2-)
      [ -n "$ver" ] || { echo "软件包仓库里没有可用于打镜像的发布版本" >&2; exit 1; }
      echo "keycordon version: $ver"
      echo "KEYCORDON_VERSION=$ver" > build.env
    # 2. 下载 linux/amd64 二进制到构建上下文（302 需 -L）
    - |
      set -eu
      . ./build.env
      base="${CI_API_V4_URL}/projects/${KEYCORDON_PROJECT_ID}/packages/generic/${KEYCORDON_PACKAGE_NAME}/${KEYCORDON_VERSION}"
      curl -fL --retry 3 -o keycordon-integration/keycordon-linux-amd64 \
        "${base}/keycordon_${KEYCORDON_VERSION}_linux_amd64"
      chmod 0755 keycordon-integration/keycordon-linux-amd64
    # 3. 构建、打标签、推送
    - |
      set -eu
      . ./build.env
      docker build --pull --provenance=false --sbom=false \
        --build-arg KEYCORDON_VERSION="$KEYCORDON_VERSION" \
        -f Dockerfile.keycordon \
        -t "$CONTAINER_IMAGE_NAME:$KEYCORDON_IMAGE_TAG" .
      docker tag "$CONTAINER_IMAGE_NAME:$KEYCORDON_IMAGE_TAG" "docker.io/$DOCKERHUB_USER/$CONTAINER_IMAGE_NAME:$KEYCORDON_IMAGE_TAG"
      docker push "docker.io/$DOCKERHUB_USER/$CONTAINER_IMAGE_NAME:$KEYCORDON_IMAGE_TAG"
      docker tag "$CONTAINER_IMAGE_NAME:$KEYCORDON_IMAGE_TAG" "$CI_REGISTRY_IMAGE:$KEYCORDON_IMAGE_TAG"
      docker push "$CI_REGISTRY_IMAGE:$KEYCORDON_IMAGE_TAG"
```

说明：

- **不 pin 版本**（议题 8 明确允许不可复现）：每次构建取软件包仓库里最新的发布版本，排障时从镜像 `LABEL org.opencontainers.image.keycordon.version` 反查
- **不用 `sort -V`**：`docker:cli` 是 alpine，BusyBox 的 `sort` 没有 `-V`。改用 `awk` 把每段版本号补零后按字符串排序，已验证对 `0.1.0` / `0.10.0` / `1.0.0` 都正确
- **不能取 API 第一条**：实测 API 默认按创建时间排序，`nightly` 排在最前
- 打包顺序：`npm-build` 产出 `dist/` → 本 job 下载二进制 → `docker build` 一次完成
- 失败即失败：取不到版本或下载失败时直接 `exit 1`，不会产出「没有 keycordon 的 `-keycordon` 镜像」
- 基础镜像的 `docker-build` job 完全不动，两个 job 并行产出 `latest` 与 `latest-keycordon`

### 5.3 `.gitignore` 追加（**不是** `.dockerignore`）

```
keycordon-integration/keycordon-linux-amd64
```

CI 构建时该文件由 job 下载到构建上下文里，本地开发时不应把它提交进版本库。

> **关键**：这里必须写进 `.gitignore`，**绝不能**写进 `.dockerignore`。`.dockerignore` 会把文件从构建上下文中剔除，而 `Dockerfile.keycordon` 里有一句 `COPY keycordon-integration/keycordon-linux-amd64 /usr/local/bin/keycordon`——一旦被排除，`docker build` 会直接报 `COPY failed: file not found in build context`，整个 job 失败。
>
> 现有 `.dockerignore` 里排除 `config`、`src`、`public/assets` 是为了缩小上下文，二进制文件不属于这一类：它**必须**在上下文里。

---

## 6. 部署文档

### 6.1 新增章节（README / README.zh-Hans / SPECS）

必须写清的四点：

1. **两个端口的用途**：3001 = cpa-gate 页面；8318 = keycordon 代理（客户端调用）
2. **`KEYCORDON_URL` 必须是外部可达地址**：用户在反向代理后暴露的 HTTPS 地址，不是容器内地址
3. **反向代理必须原样转发客户端凭据**：`Authorization` / `x-api-key` / `x-goog-api-key` / `?key=` / `?auth_token=`。keycordon 用它们划分 vault；丢失凭据会导致**不同客户端共用一个 vault**
4. **防滥用由部署者负责**：`KEYCORDON_ENABLED` 打开后，8318 是新增公网入口，必须在反向代理层加速率/并发限制（议题 1 的代码级修复在 keycordon 项目内进行）

### 6.2 最小反向代理配置

Caddy：

```
kc.example.com {
    # 保留客户端凭据（Caddy 默认转发，无需额外配置；不要加 request_header -Authorization）
    reverse_proxy 127.0.0.1:8318

    # 防滥用：按 IP 限流（需 caddy-ratelimit 插件）
    rate_limit {
        zone kc {
            key {remote_host}
            events 60
            window 1m
        }
    }
}
```

nginx：

```nginx
server {
    listen 443 ssl;
    server_name kc.example.com;

    # 限流区必须定义在 http{} 层，这里写出来只是提醒它和下面的 location 配套
    # limit_req_zone $binary_remote_addr zone=kc:10m rate=60r/m;

    location / {
        proxy_pass http://127.0.0.1:8318;
        proxy_http_version 1.1;
        # SSE 必须关闭缓冲，否则流式响应会被攒着一起发
        proxy_buffering off;
        proxy_set_header Host $host;
        # 关键：原样转发凭据（以下三行是 nginx 默认值，显式写出以防误删）
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Api-Key $http_x_api_key;
        proxy_set_header X-Goog-Api-Key $http_x_goog_api_key;

        limit_req zone=kc burst=20 nodelay;
    }
}
```

> 两个易错点：
> 1. `proxy_buffering off` 对本项目尤其重要——LLM 都是流式响应，nginx 默认缓冲会让用户以为「卡住了」
> 2. **不要**加 `proxy_set_header Authorization ""` 之类的「清洗凭据」配置。keycordon 靠这个头划分 vault，清掉之后所有客户端共用一个 vault，A 的占位符可以被 B 还原
>
> Caddy 侧同理：默认行为就是正确的，只有 `request_header -Authorization` 才会破坏它。

另外 nginx 的 `client_max_body_size` **默认只有 1 MB**，比 keycordon 的 8 MiB 上限更早触发 413。文档要直接给出：

```nginx
client_max_body_size 16m;   # 留余量给 keycordon 的 8 MiB body / 16 MiB decoded
```

### 6.3 上线灰度（议题 13）

文档里给出三步：

1. 先以 `mode: observe` 启动（只记录命中，不改写），观察一周误报
2. 确认无异常后改为 `mode: enforce`
3. 出问题时把 `KEYCORDON_DEFAULT_ON=false`，用户回到原始地址，keycordon 继续保留日志

> 修改 `mode` 需要挂载自己的配置覆盖 `/etc/keycordon/config.yaml`，或重新构建镜像。文档里给出前者（挂载只读文件）。

### 6.4 `docker run` 示例

```bash
docker run -d --name cpa-gate \
  -p 3001:3001 \
  -p 127.0.0.1:8318:8318 \
  -e CPA_MANAGEMENT_URL='http://cliproxyapi:8317' \
  -e CPA_MANAGEMENT_KEY='…' \
  -e SESSION_SECRET='…' \
  -e KEYCORDON_ENABLED=true \
  -e KEYCORDON_URL='https://kc.example.com' \
  -e KEYCORDON_DEFAULT_ON=false \
  -e KEYCORDON_MASTER_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
  docker.io/yanranxiaoxi/cpa-gate:latest-keycordon
```

要点：

- `-p 127.0.0.1:8318:8318` —— 只绑回环，由同机反向代理暴露，避免直接公网可达
- `KEYCORDON_UPSTREAM` 省略时取 `CPA_MANAGEMENT_URL`（本例即 `http://cliproxyapi:8317`）
- `KEYCORDON_MASTER_KEY` 一旦更换，**所有历史占位符失效**，上游 prompt cache 重算一次。文档必须加粗提示

### 6.5 `.env.example`

新增一节：

```bash
# ===== KeyCordon 隐私保护（可选）=====
# true 时页面显示「KeyCordon 隐私保护」开关，并把调用地址切换到 KeyCordon
KEYCORDON_ENABLED=false
# KeyCordon 的外部暴露地址（客户端实际访问的地址）；启用时必填
KEYCORDON_URL=
# 开关的首次默认状态；用户手动切换后以浏览器 localStorage 为准
KEYCORDON_DEFAULT_ON=false

# 以下两项仅 -keycordon 镜像使用
# 打包进来的 keycordon 的上游地址；留空则取 CPA_MANAGEMENT_URL
KEYCORDON_UPSTREAM=
# 主密钥（必填）：64 位 hex 或 base64 的 32 字节。更换会导致历史占位符失效
KEYCORDON_MASTER_KEY=
```

---

## 7. 验收清单

### 7.1 基础镜像（不受影响）

- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm build` 通过
- [ ] `KEYCORDON_ENABLED` 未设置时，页面与改动前**完全一致**（无开关、地址不变、deep link 不变）
- [ ] `GET /api/portal` 响应里**没有** `keycordon` 字段

### 7.2 启用集成

- [ ] `KEYCORDON_ENABLED=true` 但 `KEYCORDON_URL` 为空 → 启动失败，错误信息明确
- [ ] `KEYCORDON_URL=ftp://x` → 启动失败
- [ ] `KEYCORDON_URL=http://127.0.0.1:8318` → 启动成功但日志有 warn
- [ ] `KEYCORDON_URL=https://kc.example.com/`（带尾斜杠）→ 下发地址不含双斜杠
- [ ] 页面右上角出现两个开关：**KeyCordon 隐私保护**（左）**完整 URL**（右）
- [ ] 开关默认状态跟随 `KEYCORDON_DEFAULT_ON`
- [ ] 切换后刷新页面，状态被记住（localStorage `cpa-keycordon`）
- [ ] 清空 localStorage 后刷新，回到 `KEYCORDON_DEFAULT_ON`
- [ ] 开关打开：主地址、Anthropic、Gemini 三条**同时**变成 KeyCordon 地址
- [ ] 两个开关的四种组合都正确（KeyCordon × 完整 URL），且地址的路径前缀不错位（`/v1`、`/v1beta`、根）
- [ ] 开关打开 +「完整 URL」打开 → 显示 `<kc>/v1/chat/completions`；关闭 → 显示 `<kc>/v1`
- [ ] 复制按钮复制的是屏幕上看到的地址
- [ ] 开关打开：Cherry Studio / Chatbox / OpenCat 的 deep link **也指向 KeyCordon**（解 base64 或看地址栏确认）
- [ ] 三个 deep link 的 `id` 随域名变化（KeyCordon 域名与 CPA 域名不同 → 两个独立条目）
- [ ] 375px 宽度下：两个开关换到独立一行，不挤压、不溢出

### 7.3 `-keycordon` 镜像

- [ ] 镜像 tag 形如 `latest-keycordon`，同时推到 Docker Hub 与 GitLab Registry
- [ ] `docker inspect` 可见 `Config.ExposedPorts` 含 `3001/tcp` 与 `8318/tcp`
- [ ] 未设置 `KEYCORDON_MASTER_KEY` → 容器立即退出，日志说明原因
- [ ] `KEYCORDON_UPSTREAM=http://x:8318` → 容器拒绝启动（防环）
- [ ] 未设置 `KEYCORDON_UPSTREAM` → 自动取 `CPA_MANAGEMENT_URL`，日志打印实际使用的上游
- [ ] 3001 与 8318 均监听成功
- [ ] `curl 127.0.0.1:8318/_keycordon/healthz` 返回版本与指纹
- [ ] `docker stop` 后两个进程**都**退出（`docker ps -a` 无残留）
- [ ] 杀掉 keycordon 进程 → 整个容器退出（fail fast）
- [ ] 通过 8318 发一次真实 LLM 请求，上游收到占位符、客户端拿回原文（`mode: observe` 亦可验证检测生效）
- [ ] `HEALTHCHECK` 在 keycordon 挂掉后把容器标记为 unhealthy

### 7.4 CI

- [ ] 软件包仓库无发布版本时 job 失败并给出明确信息
- [ ] 下载到的是 `linux_amd64`（`file` 显示 ELF x86-64）
- [ ] 构建日志打印了实际使用的 keycordon 版本
- [ ] 基础镜像 job 不受影响（仍产出 `latest`）

---

## 8. 风险与已知限制（写入文档，不视为缺陷）

| 项 | 说明 |
| --- | --- |
| 不可复现构建 | keycordon 版本随包仓库最新发布版本浮动（议题 8 已确认接受）。排障时从镜像 `LABEL org.opencontainers.image.keycordon.version` 反查 |
| 单容器双进程 | 两个进程共享同一 cgroup 限额。keycordon 的内存峰值 ≈ 并发数 × `max_decoded_bytes`（默认 16 MiB），需按宿主机能力估算 |
| 请求体上限 | 默认 `max_body_bytes: 8 MiB`，超出直接 413 且**不透传**。带多张图片的请求会被拒，需挂载自定义配置调大（已实测该默认值） |
| 主密钥变更 | 会让所有历史占位符失效、上游 prompt cache 重算。文档需加粗 |
| 8318 的防滥用 | 代码级防护在 keycordon 项目内解决；在此之前部署者必须在反向代理加限流 |
| 开关是「客户端侧」选择 | 服务端不感知用户是否真的走 KeyCordon。用户关掉开关即绕过，这是**有意为之**（隐私保护是可选能力，不是强制策略） |
| `KEYCORDON_URL` 与实际部署漂移 | 服务端只回显该值，不会校验可达性。配置错误的表现是「地址打开了但连不上」 |
| 前端与 SW 缓存 | 新增的 i18n key 与脚本变化靠 `main-<hash>.js` 的内容哈希自动失效（构建脚本会回写 `index.html` 与 `sw.js`），无需手改 `CACHE_VERSION`。若排版异常，先让用户强刷 |
| 镜像体积 | +约 14 MB（静态二进制）+ tini，可接受 |
| 多架构 | 目前仅 amd64（与现有 CI runner 一致）。包仓库已提供 arm64 / darwin / windows 二进制，将来扩展无需改拉取逻辑，只需加 `--platform` |
| vault 与上游凭据 | keycordon 按客户端凭据划分 vault，因此**同一个 CPA 密钥共用同一个 vault**。同一用户在多台设备上用同一密钥时不隔离，符合 keycordon 的既有设计 |
| 许可证 | keycordon 项目当前未附 LICENSE 文件，而 cpa-gate 是 MIT。把二进制打进镜像分发前需先确认 keycordon 的许可条款（已列为执行前的前置项） |

---

## 9. 改动文件总览

| 类型 | 文件 |
| --- | --- |
| 新增 | `docs/keycordon-integration.md`（本文） |
| 新增 | `Dockerfile.keycordon` |
| 新增 | `keycordon-integration/entrypoint.sh` |
| 新增 | `keycordon-integration/config.yaml` |
| 修改 | `src/config/config.ts` |
| 修改 | `src/controller/portal.controller.ts` |
| 修改 | `src/frontend/types.ts` |
| 修改 | `src/frontend/portal.ts` |
| 修改 | `public/css/style.css` |
| 修改 | `public/locales/zh-Hans.json`、`public/locales/en.json` |
| 修改 | `.gitignore` |
| 修改 | `.gitlab-ci.yml` |
| 修改 | `.env.example` |
| 修改 | `README.md`、`README.zh-Hans.md`、`SPECS.md` |

**不改动**：`src/router/index.ts`、`src/service/*`（keycordon 只在页面展示层生效，服务端不代理它）、`.dockerignore`（见 5.3 的说明）。

---

## 10. 实施顺序建议

1. **配置与后端**：`config.ts` → `portal.controller.ts` → `types.ts`（此时可用 curl 验证 `/api/portal` 的 JSON）
2. **前端显示**：`portal.ts` 的地址矩阵 + 开关 + deep link + CSS + i18n（本地起服务验收 7.2）
3. **镜像**：`Dockerfile.keycordon` + `entrypoint.sh` + `config.yaml`（本地 `podman build` 验收 7.3；构建时需先手动下载二进制放到 `keycordon-integration/keycordon-linux-amd64`）
4. **CI**：`.gitlab-ci.yml` + `.gitignore`（验收 7.4）
5. **文档**：`.env.example` → README ×2 → SPECS

---

## 11. 执行前需要你确认的两件事

1. **keycordon 的许可证**：仓库里目前没有 `LICENSE` 文件（`docs/`、`README.md` 都没提）。cpa-gate 是 MIT，把 keycordon 二进制打进对外分发的镜像属于再分发，需要先确认它的许可条款。请在 keycordon 项目里补一个 LICENSE，或明确声明可以这样分发。
2. **`ENV KEYCORDON_ENABLED=true`**：见 4.6 的取舍说明。如果你希望 `-keycordon` 镜像默认不启用、由部署者显式打开，现在说，改一行即可。

除这两点外，本方案没有阻塞项。等你指示后我按第 10 节的顺序执行。

---

## 12. 实现记录

已按第 10 节的顺序全部落地。实现过程中发现并修正了方案里三处会导致失败的细节：

| 项 | 方案原文 | 实际实现 | 原因 |
| --- | --- | --- | --- |
| 二进制忽略 | 写进 `.dockerignore` | 改写进 `.gitignore` | `.dockerignore` 会把文件从构建上下文剔除，`COPY keycordon-integration/keycordon-linux-amd64` 会直接报 `file not found in build context` |
| 版本排序 | `sort -V` | `awk` 补零后 `sort` | CI 用的 `docker:cli` 基于 alpine，BusyBox 的 `sort` 没有 `-V` |
| 变量位置 | 写在 `docker-build` 的 `variables:` 块 | 移进 `docker-build-keycordon` 自己的块 | GitLab 的 job 级变量不跨 job 继承，首次云端流水线因此报 `KEYCORDON_PROJECT_ID: parameter not set` |

验收结果（全部实测）：

- 配置校验：缺 `KEYCORDON_URL`、`ftp://`、非法 URL 三种都启动失败；回环地址只告警并在日志中可见。
- 接口：未启用时 `/api/portal` 完全没有 `keycordon` 字段；启用后三协议地址路径前缀与直连一致。
- 前端：两个开关的四种组合、`localStorage` 持久化、清空后回落到 `defaultOn`、deep link 跟随切换、375px 下开关换行且无溢出、中英文案均正确。
- 镜像：用真实 keycordon 0.1.1 二进制验证 entrypoint 的 6 个场景（缺主密钥 / 缺 upstream / upstream 指向 8318 / 回环告警 / 子进程退出 / SIGTERM 传播），全部符合预期。
- 端到端：请求经 keycordon 后上游只看到 `<SECRET_GITHUB_TOKEN_…>`，客户端拿回原文；9 MiB 请求体返回 413。
- CI：本地模拟版本选择，从 `0.1.0`、`nightly`、`0.1.1` 中正确选出 `0.1.1` 并下载到静态 ELF。

未在本地完成的部分：镜像 `podman build`。Docker Hub 拉取 `node:24-alpine` 超时，改用真实二进制直接验证 entrypoint 与 keycordon 的协作（逻辑等价），镜像构建由 CI 完成。
