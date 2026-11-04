# Matrix Land SI

官网：https://matrixland.si。原项目名 Frontier Workspace；内部包名、协议与安装器标识保持兼容。

企业独立部署的 AI 工作区。企业使用自己的 Cloudflare 账号、域名、身份目录和模型服务；品牌、Logo、8 组配色和模块在安装时配置。

**版本：0.1.0，首次独立源码交付。** 本版已通过本地自动化、构建、部署包编译与安装器模拟验证；尚未在真实企业账号完成首次部署验收。请先在测试实例验证，再投入生产。

## 开始

需要 Node.js 22.18+ 与 npm。下载或克隆代码后：

```sh
npm ci
npm run setup
```

打开终端显示的一次性本机链接。填写企业配置，生成并审阅计划，再点击执行。生成计划不创建云资源；执行计划会在指定账号创建资源、发布服务和配置域名。

安装器只监听 `127.0.0.1`，默认端口 5194。凭据在本机内存中使用，持久化密钥以密码加密保存到 `.workspace/<实例标识>/vault.json`。不要将 `.workspace`、实例配置或计划文件加入公共仓库。

首次部署前，请按[安装与升级手册](docs/installation.md)准备 Cloudflare 邮件能力、令牌和 DNS。首次登录后使用指定管理员邮箱领取工作区所有权，在管理页完成集成验收。

## 品牌与官网

- [Matrix Land SI 品牌升级规划](docs/matrixland-brand-plan.md)
- [官网与 Blog](https://matrixland.si/) 是独立项目，单独维护源码、Git 历史与部署；不包含在本软件仓库或源码交付包中。

## 源码交付

软件仓库使用名称 `matrix-land-si`，对外名称为 **Matrix Land SI**。内部包名、CLI 和协议标识继续保持兼容。

```sh
npm run release:source
```

在本地 `release/` 生成 `matrix-land-si-0.1.0-candidate.zip`、`candidate.json` 和 `CANDIDATE-SHA256SUMS`。归档排除凭据、实例状态、依赖、构建产物与独立官网；仍为真实云端验收前的候选版本。`release/` 不提交到 Git。

## 产品

| 栏目 | 用途 |
| --- | --- |
| Mate | 企业助手、对话、任务与工具调用 |
| 知识库 | 文件、文件夹、访问范围与检索 |
| 资源中心 | 浏览和使用应用、Skills |
| 工作室 | 创建、配置、发布应用和 Mate |
| 讨论 | 团队知识交流 |
| 模型服务 | LiteLLM 模型、访问密钥、预算与用量 |
| 连接 | MCP 与外部工具连接 |
| 运行与验收 | 实例版本、登录与模型验证、所有权移交 |

模块按需启用，安装器补齐必要依赖。基础安装仅包含 Portal、Auth、两套数据库和媒体存储；Mate 会引入工作室、模型、连接和邮件服务。

LiteLLM 支持接入已有服务，也支持通过 SSH 部署固定镜像版本的 LiteLLM、PostgreSQL 和 Caddy。Entra ID 支持已有应用与辅助创建；默认登录为邮箱白名单加验证码。无需先安装人事目录连接器。

## 验证与开发

```sh
npm run test:quality
npm run quality:design-system
npm run verify:deployment
npm run setup:plan -- config/installation.example.json install-plan.json
```

`verify:deployment` 只编译部署包，不发布云服务。示例配置中的账号和域名是占位值，不能用于实际执行。浏览器集成测试另外通过 `npm run test:e2e` 运行；部分测试需要对应的本地或部署环境，参见各 Playwright 配置。

```sh
npm run dev
```

本地登录外观预览：`/__local/workspace-login`；组件与品牌工作台：`/__local/brand-studio`。这两个开发预览不发送真实登录验证码。

## 目录与文档

- `apps/portal`：企业入口；`src/portal`：共享界面与设计系统。
- `workers`：Auth、Apps、Mate、Knowledge、MCP、Gateway、Live、Mail、Stream、Miniapp、Backup。
- `packages/installer`：本机安装服务、CLI、Cloudflare 与外部服务编排。
- `schemas`：正式部署使用的空库基线与后续迁移，不含员工数据。
- `packages/cli`、`packages/mate-sdk`、`sdk`：客户端与 SDK 源码；未自动发布 npm 包。
- [安装、升级与恢复](docs/installation.md)
- [交付状态与验证范围](docs/delivery.md)
- [产品与命名蓝图](docs/frontier-workspace-product-blueprint.md)
- [前端规范](docs/frontier-workspace-frontend-standard.md)
- [贡献说明](CONTRIBUTING.md)、[安全说明](SECURITY.md)

项目代码采用 [MIT License](LICENSE)。第三方依赖保留各自许可证；产品名称不表示关联服务提供方的授权或背书。

## 本地 CLI

发布到 npm 前，使用本版本的本地归档，不依赖 `@latest`：

```sh
npm pack ./packages/cli
npm install -g ./frontier-workspace-cli-0.1.0.tgz
frontier-workspace version
frontier-workspace auth login --auth-url https://auth.workspace.example.com --api-url https://mcp.workspace.example.com --mcp-url https://mcp.workspace.example.com/mcp
```

请替换为自己的实例地址。安装器不会把 CLI 发布到公共包仓库。
