# GameGo

**面向游戏运营、市场营销与发行人员的中文行业情报工作台。**

**A Chinese-language gaming intelligence workspace for live ops, marketing, and publishing teams.**

[访问网站 / Live website](https://sayhiby0.github.io/gamego/) · [中文介绍](#chinese) · [English](#english)

无需登录即可浏览公开情报；使用 AI 助手时，自行配置阿里云百炼 API Key。

Browse public intelligence without an account. Bring your own Alibaba Cloud Model Studio (Bailian) API key to use the AI assistant.

---

<a id="chinese"></a>

## 中文介绍

### GameGo 是什么？

GameGo 将游戏资讯、榜单、玩家反馈与实用 AI Skills 汇集到一个工作台，帮助从业者回答三个问题：**发生了什么、哪些游戏值得关注、有哪些可参考的运营与营销做法。**

网站以中文阅读为主，面向全行业，重点关注中国手游与全球 PC／Steam。它不是游戏商城，也不是实时、全覆盖的舆情监控平台；每条内容尽量保留来源，并区分事实、玩家观点与 AI 推论。

### 主要功能

| 模块 | 可以做什么 |
| --- | --- |
| 今日情报 | 浏览中文资讯摘要，按平台、市场、游戏、事件类别和关键词筛选；查看原文及单独标注的 AI 行业启发。 |
| 游戏榜单 | 分别查看人气、口碑与商业表现，保留各来源的指标定义、样本范围和更新时间，不混成一个“综合热度分”。 |
| 玩家动向 | 从当期榜单动态选择游戏，整理玩家反馈、运营动作与证据缺口，不使用固定追踪名单。 |
| Skills 导航 | 发现资讯研究、竞品分析、运营与营销相关的精选工具；链接到原项目，不自动安装或执行第三方 Skill。 |
| AI 助手 | 使用 `game-daily` 整理近期资讯，或使用 `game-monitor` 调查一款游戏、对比两款游戏；支持流式回复、来源查看、停止、重试和 Markdown 报告下载。 |

公开采集计划每天北京时间 **09:00 左右**运行，GitHub Actions 可能延迟。每日最多 30 条资讯、每榜最多 20 款游戏；玩家动向最多 6 款，手游不超过 4 款、PC 不超过 2 款，证据不足时不补足配额。网站提供日期切换，最多保留近 30 份日快照；Skills 元数据按七天间隔刷新。

### 如何使用 AI 助手

1. 打开[在线网站](https://sayhiby0.github.io/gamego/)，进入“AI 助手”。公开资讯和榜单无需 API Key。
2. 阅读板块内的“购买与接入指南”，开通百炼普通模型 API，并创建有对应地域和模型权限的专用 Key。**Coding Plan 专用 Key 或聊天会员不适用。**
3. 选择页面提供的地域与模型，粘贴 Key 并保存；按需选择“记住在此浏览器”，默认不勾选。
4. 主动点击“测试连接”并确认可能产生的少量费用。保存配置和选择预设问题不会自动调用模型。
5. 选择研究方式并开始分析，结合回复中的原文来源核验结论。

**截至 2026-09-25**，线上已完成北京地域 `qwen-flash-2025-07-28` 的真实连接、流式回复与客户端停止测试。实际可选组合以页面列表为准；暂不支持任意模型服务商或自定义接口地址。网站界面和主要输出目前为中文，英文 README 不代表已有英文版界面。

示例问题：

- `game-daily`：整理近期游戏发行动态，区分事实与行业启发。
- `game-monitor`：调查一款游戏近期的玩家反馈与运营活动。
- `game-monitor`：对比两款游戏的近期口碑，说明样本范围与缺失信息。

### 费用与隐私

- **公开内容**：由站主承担 AI 加工费用，按北京时间自然月设置人民币 **20 元**预算上限；异常请求的未知费用保留保守占用。
- **AI 助手**：测试、分析和重试从访客自己的百炼账户计费，不占用公共内容预算，也不会回退使用站主 Key。本站不代充值、不补贴、不另设访客月度金额上限；价格与账户余额以百炼为准。
- **数据路径**：访客的 Key 会经过本站 Cloudflare Worker 中转并用于百炼请求，不在本站后端持久保存。问题与必要上下文会发送给模型服务商，并受其数据政策约束。
- **可选本机保存**：只有明确勾选后，API 配置才写入浏览器 `localStorage`。这不是加密保险箱；同源脚本、同一 GitHub Pages 域名下其他项目、有权限的扩展或可访问浏览器的人可能读取它。共享设备不建议记住。
- **聊天记录**：仅存在当前页面内存，刷新或关闭页面后不可恢复，记住 Key 不会保存聊天。
- **清除与撤销**：清除 API 配置会中止本页任务并清空本页对话，但不等于在百炼撤销 Key。停止请求也不保证已受理的调用免于计费。

请勿把真实 Key 放入源码、Issue、截图、聊天或公开文件。

### 技术架构

```text
GitHub Actions 定时任务
  → Python 采集公开来源
  → Worker 公共内容接口：预算预占 → 百炼加工 → 费用结算
  → 校验公开 JSON → GitHub Pages

访客浏览器
  → GitHub Pages：静态页面与公开数据
  → Cloudflare Worker：访客 Key、受控取证、百炼调用、流式回复

Cloudflare D1
  → 公共费用账本、缓存、短期限流与任务状态
  → 不保存访客 Key、聊天或报告正文
```

- 前端：原生 HTML、CSS、JavaScript ES modules。
- 后端：Cloudflare Workers + D1。
- 采集：Python 标准库。
- 自动化：GitHub Actions + GitHub Pages。
- 测试：Node.js 内置测试运行器 + Python `unittest`。

### 本地运行

建议使用 **Node.js 24** 和 **Python 3.13**（与 CI 一致），并确保 `node`、`npm`、`python` 在命令行可用。项目没有需要安装的 npm 或 Python 第三方运行依赖。

```bash
git clone https://github.com/sayhiby0/gamego.git
cd gamego
npm run dev
```

访问 `http://127.0.0.1:8000`。开发服务同时提供静态页面与本地后端，默认使用内存数据库，**默认不启用模型调用**。它不会自动导入线上 `wrangler.json` 的模型配置，也不会创建云资源；重启后本地数据库状态丢失。

如需本地配置，将 [`.env.example`](.env.example) 复制为 `.dev.vars` 后按需填写；不要提交该文件。默认内存账本禁止启用付费公共内容加工，避免重启清空预算记录。

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 推荐的本地开发入口；静态站点与本地 API，默认端口 8000。 |
| `npm start` | 仅预览静态站点，端口 8000；不会启动本地 API，页面仍读取 `site/config.json` 中的后端地址。 |
| `npm test` | 运行 JavaScript 与 Python 回归测试；默认使用模拟响应，不调用真实模型。 |
| `npm run check` | 校验公开数据与站点产物，检查敏感字段及凭据泄漏。 |
| `npm run collect` | 联网采集并更新 `site/data/`；配置真实内容服务与 Key 后，AI 加工可能产生费用。 |

两个预览命令不要同时占用同一端口。若只想阅读或开发界面，无需运行采集或配置真实 Key。

### 部署与项目结构

前端由 GitHub Pages 托管，后端单独部署到 Cloudflare Workers，并使用持久化 D1。Pages 发布工作流**不会自动部署 Worker**。

自行部署前需要：

1. 创建自己的 Worker 和 D1，应用 [`backend/migrations/`](backend/migrations/) 中的迁移。
2. 修改 [`wrangler.json`](wrangler.json) 的账号、数据库、站点来源、公开数据地址及经验证的模型配置；修改 [`site/config.json`](site/config.json) 指向自己的后端，不要直接沿用本项目资源。
3. 在 Worker 配置 `CONTENT_SERVICE_TOKEN`、`RATE_LIMIT_SECRET`；在 GitHub Actions Secrets 配置站主的 `CONTENT_API_KEY` 和相同的 `CONTENT_SERVICE_TOKEN`。访客 Key 不放入这些配置。
4. 审核 [Pages 工作流](.github/workflows/site.yml) 和[真实调用验收工作流](.github/workflows/verify-live.yml) 中的仓库／分支限制，再启用自己的自动化与 Pages 发布。真实调用验收需要明确确认费用，不能用普通单元测试代替。

免费云服务档位仍有配额和网络限制，不保证永久免费或任何网络下均可访问。

| 路径 | 内容 |
| --- | --- |
| [`site/`](site/) | 页面、前端脚本与可公开的 JSON 快照。 |
| [`backend/`](backend/) | Worker、模型适配、预算账本、安全边界与 D1 迁移。 |
| [`scripts/`](scripts/) | 数据采集、内容加工、公开校验、本地开发与真实验收脚本。 |
| [`config/`](config/) | 数据来源与精选 Skills 配置。 |
| [`tests/`](tests/) | JavaScript 和 Python 回归测试。 |
| [`.github/workflows/`](.github/workflows/) | 定时采集、静态发布与手动真实调用验收。 |
| [`SPEC.md`](SPEC.md) | 需求规格、来源核验证据与阶段性验收记录；其中历史计划不等于全部已实现。 |

### 当前边界

- 已上线公开站点，但数据覆盖仍不完整，部分手游／TapTap 等渠道可能不可用。请查看页面的“数据覆盖”、时间戳和缺失原因，不将旧数据当作今日更新。
- Steam 不代表所有 PC 游戏，TapTap 不代表整个手游市场；在线人数、评分、收入排名和销量是不同指标。没有可信金额或份数时不推算数字。
- AI 摘要与行业启发可能出错，不能替代原文核验；样本不足、预算不足或模型输出校验失败时会明确降级，不编造结论。
- 助手使用受限的研究流程，不是任意联网搜索或第三方 Skill 执行平台。真实模型联调通过不等于全部数据来源、手机布局、并发隔离及免费档性能已全面验收。
- 原始文章、数据和第三方 Skills 的权利归各自权利人；来源链接不代表获得全文转载或商业再分发授权。

---

<a id="english"></a>

## English

### What is GameGo?

GameGo brings gaming news, rankings, player feedback, and practical AI Skills into one workspace for live ops, marketing, and publishing teams. It helps answer three questions: **What happened? Which games deserve attention? What can we learn for operations and marketing?**

The website and its primary output are in Chinese, with a focus on Chinese mobile games and global PC/Steam coverage. It is neither a game store nor an exhaustive, real-time monitoring service. Source links and the distinction between facts, player opinions, and AI interpretation are central to the project.

### Features

| Area | What it offers |
| --- | --- |
| Daily intelligence | Chinese news summaries; filters for platform, market, game, event category, and keywords; original sources and separately labeled AI insights. |
| Game rankings | Separate popularity, reception, and commercial-performance views with source definitions, sample scope, and timestamps—not an invented combined score. |
| Player signals | Games selected dynamically from available rankings, with player feedback, operational developments, and explicit evidence gaps. |
| Skills directory | Curated research, competitive-analysis, operations, and marketing tools. Links open the original projects; no automatic installation or execution. |
| AI assistant | `game-daily` for news research; `game-monitor` for a single-game investigation or two-game comparison. Includes streaming responses, sources, stop/retry controls, and Markdown export. |

Public collection is scheduled for approximately **09:00 Beijing time (UTC+8)** each day; GitHub Actions may run late. Limits are up to 30 news items per day, 20 games per ranking, and six player-signal selections—at most four mobile and two PC games, without filling evidence gaps just to meet a quota. Date selection covers up to 30 daily snapshots. Skills metadata refreshes at seven-day intervals.

### Use the assistant

1. Open the [live website](https://sayhiby0.github.io/gamego/) and select “AI 助手”. Public browsing requires neither an account nor an API key.
2. Follow the built-in setup guide to enable Alibaba Cloud Model Studio (Bailian) and create a dedicated **standard model API key** with the appropriate region and model permissions. Coding Plan keys and chat subscriptions are not supported.
3. Select an available region/model, paste your key, and save. “Remember in this browser” is optional and off by default.
4. Explicitly run the connection test and confirm the potential small charge. Saving settings or selecting a suggested prompt does not invoke the model.
5. Start a research request and verify the response against its source links.

**As of September 25, 2026**, the Beijing-region `qwen-flash-2025-07-28` model has passed live connection, streaming-response, and client-stop tests. The available options shown in the UI are authoritative. Arbitrary providers and custom API endpoints are not supported. This English README does not imply an English-language interface.

Example tasks include summarizing recent game releases, investigating a game's player feedback and live operations, or comparing two games' recent reception while identifying sampling limitations.

### Costs and privacy

- **Public content:** AI processing is funded by the operator, with a **CNY 20 cap per Beijing-calendar month**. Uncertain request costs retain conservative budget reservations.
- **Assistant:** Tests, analyses, and retries are billed to the visitor's own Bailian account. They do not use the public-content budget or fall back to the operator's key. GameGo does not provide credit or impose a separate visitor monthly spending cap; check the provider's current pricing and balance.
- **Request path:** Your key passes through the site's Cloudflare Worker to call Bailian; it is not persisted on the site's backend. Prompts and necessary context are sent to the model provider and are subject to its data policies.
- **Optional local storage:** Explicit consent stores API settings in browser `localStorage`, not an encrypted vault. Same-origin scripts—including other projects on the same GitHub Pages domain—privileged extensions, or people with browser access may read them. Avoid remembering keys on shared devices.
- **No chat history:** Conversations exist only in the current page's memory. Refreshing or closing the page loses them, even when API settings are remembered.
- **Clearing is not revocation:** Clearing API settings stops the current page's task and clears its conversation; it does not revoke the provider key. Stopping a request does not guarantee that an accepted call will not be billed.

Never put real keys in source code, issues, screenshots, chats, or public files.

### Architecture

```text
Scheduled GitHub Actions
  → Python public-source collection
  → Worker content endpoint: budget reservation → Bailian → settlement
  → Validated public JSON → GitHub Pages

Visitor browser
  → GitHub Pages: static UI and public data
  → Cloudflare Worker: visitor key, controlled research, model calls, streaming

Cloudflare D1
  → Public cost ledger, caches, short-lived rate limits and job state
  → No visitor keys, conversations, or report bodies
```

The stack uses plain HTML/CSS/JavaScript ES modules, Cloudflare Workers and D1, Python's standard library, and GitHub Actions/Pages. Tests use Node.js's built-in test runner and Python `unittest`.

### Run locally

Recommended versions are **Node.js 24** and **Python 3.13**, matching CI. Ensure `node`, `npm`, and `python` are on your PATH. No third-party npm or Python runtime dependencies need to be installed.

```bash
git clone https://github.com/sayhiby0/gamego.git
cd gamego
npm run dev
```

Open `http://127.0.0.1:8000`. The development server serves both the UI and local API, uses an in-memory database, and **disables model calls by default**. It neither imports production model settings from `wrangler.json` automatically nor creates cloud resources. Restarting loses local database state.

For optional configuration, copy [`.env.example`](.env.example) to `.dev.vars` and edit it locally. Never commit that file. The default in-memory ledger refuses paid public-content processing because restarting would erase budget records.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Recommended local UI and API development server; port 8000 by default. |
| `npm start` | Static-only preview on port 8000; no local API. The page still uses the backend address in `site/config.json`. |
| `npm test` | JavaScript and Python regression tests with simulated responses, not live model calls. |
| `npm run check` | Validate public assets and data, including checks for sensitive fields and credentials. |
| `npm run collect` | Collect over the network and update `site/data/`. AI processing may incur charges when a real content service and key are configured. |

Do not run both preview commands on the same port. Reading the site or developing its UI does not require collection or a real key.

### Deployment and repository layout

GitHub Pages hosts the frontend; Cloudflare Workers and persistent D1 provide the separately deployed backend. The Pages workflow **does not deploy the Worker**.

To deploy your own instance:

1. Create your own Worker and D1 database, and apply [`backend/migrations/`](backend/migrations/).
2. Update account/database bindings, site origin, public-data URL, and verified model settings in [`wrangler.json`](wrangler.json). Point [`site/config.json`](site/config.json) to your own backend rather than reusing this project's resources.
3. Configure `CONTENT_SERVICE_TOKEN` and `RATE_LIMIT_SECRET` as Worker secrets. Configure the operator's `CONTENT_API_KEY` and matching `CONTENT_SERVICE_TOKEN` in GitHub Actions Secrets. Visitor keys do not belong in these settings.
4. Review the repository/branch guards in the [Pages workflow](.github/workflows/site.yml) and [live acceptance workflow](.github/workflows/verify-live.yml) before enabling your own automation and Pages deployment. Live acceptance requires explicit cost confirmation; unit tests are not a substitute.

Free cloud tiers still have quotas and network limitations. Free hosting forever or access from every network is not guaranteed.

| Path | Contents |
| --- | --- |
| [`site/`](site/) | UI, frontend modules, and public JSON snapshots. |
| [`backend/`](backend/) | Worker, model adapter, budget ledger, security boundaries, and D1 migrations. |
| [`scripts/`](scripts/) | Collection, content processing, public validation, local development, and live acceptance. |
| [`config/`](config/) | Source registry and curated Skills configuration. |
| [`tests/`](tests/) | JavaScript and Python regression tests. |
| [`.github/workflows/`](.github/workflows/) | Scheduled collection, static publishing, and manual live acceptance. |
| [`SPEC.md`](SPEC.md) | Chinese requirements, source checks, and milestone acceptance records; historical plans are not a claim of complete implementation. |

### Current limitations

- The public site is live, but source coverage is incomplete. Some mobile/TapTap channels may be unavailable. Consult the coverage panel, timestamps, and missing-data notices rather than treating old data as a fresh update.
- Steam is not the entire PC market; TapTap is not the entire mobile market. Concurrent players, ratings, revenue rankings, and units sold are different metrics. Missing revenue or sales figures are not invented.
- AI summaries and insights can be wrong. Check the original sources. Insufficient evidence, exhausted budgets, or invalid model output result in explicit reduced coverage rather than fabricated conclusions.
- The assistant runs bounded research workflows, not arbitrary web browsing or third-party Skill execution. Successful model integration does not mean all sources, mobile layouts, concurrent-user isolation, or free-tier performance have been fully validated.
- Original articles, data, and third-party Skills belong to their respective rights holders. Linking to a source does not grant full-text republication or commercial redistribution rights.
