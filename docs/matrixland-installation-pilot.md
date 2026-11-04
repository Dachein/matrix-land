# Matrix Land SI 独立安装试验

## 目标与当前状态

使用项目专用 Cloudflare Account，按外部机构首次安装的流程，从源码完成初始化、部署、登录、功能验收和一次升级。官网上线不代表软件验收完成。

已在控制台确认项目独立账号存在，最近一次读取的账号名为 `Frontier Workspace Lab`，Workers & Pages 中只有官网 `matrixland-website`。用户已确定将账号命名为 **Matrixlab**；控制台实际改名尚待目标账号权限，未完成。该账号与其他项目账号分开；本方案中官网与产品仍属于同一个项目账号，并非两者之间的账号级隔离。

2026-11-04 本轮已通过类型检查、生产构建、2,175 项自动化测试（含安装器 14 项）、12 项本地浏览器场景，以及 auth、gateway、apps、mcp、mail、mate、knowledge、live、stream、miniapp、backup 共 11 个 Worker 的部署打包检查。浏览器场景使用模拟 API，安装器安装/中断恢复/升级测试使用模拟 Cloudflare 和本地 SQLite，不能替代真实云端验收。尚未创建产品云端资源，也没有提交付费订阅。

## 2026-11-04 执行记录与缺项

- 当前软件源码位于 `/Users/dachein/projects-lab/matrix-land-si`，此前目录名为 `Matrix lab`。修复了构建配置和测试辅助代码将带空格的文件路径错误编码为 `%20` 的问题；修复后全部自动化测试通过。官网保留独立源码与 Git 历史，不加入软件仓库。
- 当前 Wrangler OAuth 仅列出原账号 `564a7c7a43d48994d03569252c45f2cd`。对目标独立账号和目标 Zone 的只读 API 请求均返回 HTTP 403、错误码 9109。不能用原账号替代目标账号部署。
- 安装令牌、独立运行令牌、本地凭据库密码尚未配置。安装器现会在创建状态和资源前校验所有配置引用的凭据，重试时也重新检查；补充了缺失运行令牌和模型凭据的回归测试。
- 安装计划中“必须 Workers Paid”的过时表述已修正；尚未验证免费计划的真实 CPU 用量、配额和各产品开通情况。安装器没有自动订阅付费计划的步骤。
- 邮件发送能力、管理员实际收信和首次认领尚未验收。现有邮箱策略是域名级白名单，不能当作指定单一邮箱的限制。
- 用户确认目前没有 LiteLLM 服务，后续另行准备。第一阶段关闭模型模块，Mate 的真实模型调用留待第二阶段验收。
- 本次浏览器验证覆盖应用显示/隐藏/恢复、中英文字段、知识上传后的目录隔离、并发刷新及用户切换隔离，共 12 项通过。共享测试夹具补齐了品牌/模块 API，已验证的主页和知识导航用例改为当前路径路由。其他仍使用历史 hash 路由的浏览器用例需继续迁移，未宣称整个浏览器套件通过。
- 生产构建仍提示知识库横幅引用了缺失图片 `/assets/workspace-ai-miniapp-banner-bg.jpg`；这是待清理的视觉资源缺项，构建已成功。
- 官网 HTTPS 请求返回 200；本次对 `play.matrixland.si` 的 HTTPS 请求连接被重置，尚无可验收的产品入口。真实登录、知识上传、应用发布、模型调用、升级和恢复仍未完成云端验收。

本轮日志位于本机 `/tmp/matrixland-play-quality-final-20261104.log`、`/tmp/matrixland-play-installer-20261104.log`、`/tmp/matrixland-play-deployment-20261104.log`、`/tmp/matrixland-play-browser-fixed-20261104.log`。这些临时日志不包含部署凭据，重启或临时目录清理后可能消失。

## 部署布局

| 用途 | 规划 |
| --- | --- |
| 官网与 Blog（已上线） | `https://matrixland.si` |
| 产品试用入口（待部署） | `https://play.matrixland.si` |
| 安装实例标识 | `matrixland-lab` |
| Cloudflare Account | `Matrixlab`（控制台待改名），`44420482579679f9392919a4dcd2a980` |
| 服务根域名 | `matrixland.si` |
| 产品 Pages 项目 | `matrixland-lab-portal` |
| Worker、数据库、存储等 | 安装器生成 `matrixland-lab-` 前缀资源 |

产品服务使用 `auth.matrixland.si`、`apps.matrixland.si`、`knowledge.matrixland.si` 等独立主机名。`apps` 为应用服务，`play` 为用户体验入口。完整列表以安装器生成的计划为准。官网使用原来的 Pages 项目，产品安装不接管其资源。

## 分阶段验收

第一阶段使用免费方案，模型配置设为 `{"mode":"disabled"}`。计划启用 `knowledge`、`studio`、`discussions`、`connections`，验证邮箱登录与管理员认领、知识文档上传和检索、工作室应用创建发布、讨论以及连接权限。实际执行仍需部署/运行令牌、可用发件地址和相关 Cloudflare 产品能力。

第一阶段同时包含设置页面：成员管理 `/admin/people`、登录策略 `/admin/identity`、运行与验收 `/admin/operations` 和个人设置。已新增并通过 3 项模拟 API 的浏览器测试，覆盖无模型/备份模块时访问运行页、登录策略审阅后保存并重新读取、成员管理入口；个人设置和所有页面的真实云端权限仍待上线验收。

授权使用 Cloudflare 的 [API Token 预填链接机制](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/)，账号范围限定为上述独立账号，Zone 范围限定为 `matrixland.si`。部署令牌与工作室运行令牌分别创建。本地安装器支持通过 URL 片段预填非敏感配置，并立即清除片段；不从 URL 读取 Token 或凭据库密码，相关行为已通过本地浏览器检查。管理员须核对默认邮箱域策略并填写实际可用的发件地址后生成计划。

第二阶段在 LiteLLM 服务准备后，通过同一实例的升级流程启用模型和 Mate。当前安装器中 `mail` 依赖 Mate 与模型，因此邮件模块也放在第二阶段；第一阶段的登录验证码发信属于 Auth，仍然必须单独配置和验收。Stream、小程序和备份等扩展模块按各自前置条件另行验证，不把这些未测模块计入第一阶段通过项。

## 执行前需要补齐

1. 核对所选模块需要的 R2、邮件等产品能力，先评估 Workers Free 的可用范围，不把订阅 Workers Paid 作为统一前置条件。Workers Free 的 HTTP 请求 CPU 时间限额为 10 ms，当前免费方案能否承载完整产品尚未实测。需要更高额度时再选择 Workers Paid；其基础费为 5 USD/月，额外用量及其他产品另计，并非整个产品总成本上限。实际以提交时账单为准。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/) · [计费说明](https://developers.cloudflare.com/workers/platform/pricing/)。
2. 配置限定本账号和本 Zone 的部署 API Token。工作室、邮件、Stream、备份还需要独立的运行令牌。密钥在本机安装器或受控终端输入，不写入 Git 或聊天。
3. 确定能实际收信的管理员邮箱、注册邮箱域策略和经过验证的系统发件地址。现有安装器按邮箱域放行，不能把 `gmail.com` 当成“仅允许一个 Gmail 地址”的限制。
4. 第二阶段为 Mate 和邮件模块配置 LiteLLM。可以接入已有服务，也可以准备独立 Linux 主机由安装器部署。需要明确模型、Team、运行凭据与预算；此项不阻塞第一阶段不依赖模型的模块。

这些条件未齐备前，不生成含虚构模型地址、邮箱或凭据的可执行正式计划。

## 安装与验收顺序

1. 使用开源交付所提供的同一安装器，填写机构品牌、域名、账号、邮箱策略、模块和模型配置。
2. 生成并核对安装计划，检查资源名称、账号、Zone、域名和所选模块。
3. 执行安装，记录各步骤结果；遇到故障使用同一实例状态重试，不手工绕过安装器补出一个无法复现的环境。
4. 在 `play.matrixland.si` 实际收取验证码、登录并认领首位管理员。
5. 验收知识上传与检索、应用创建与发布、Mate 的真实模型调用和所需连接权限；邮件、讨论、Stream 等按所选模块分别验收。
6. 在同一测试实例验证再次执行的幂等性、可恢复的中断重试及一次版本升级。备份与恢复分别检查，升级前成功导出不等于完成恢复验收。
7. 将每个真实失败点反馈为安装器修复、明确的前置检查或安装文档，最终保留可复现的安装记录。

只有云端安装、登录及核心业务验收通过后，才把本实例标记为“可试用”；完成升级和恢复验证后，再报告相应交付能力已通过实测。

## 本地入口

```sh
npm ci
npm run test:installer
npm run verify:deployment
npm run setup
```

部署打包检查使用 `wrangler deploy --dry-run`，不创建云端资源。实际执行与凭据保存方式见 [安装手册](installation.md)，当前版本边界见 [交付说明](delivery.md)。
