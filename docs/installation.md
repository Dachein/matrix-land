# 安装、升级与恢复

本手册描述 0.1.0 已实现的执行流程。产品蓝图是长期约束；本版实际验收边界见 [delivery.md](delivery.md)。

## 安装前准备

- Node.js 22.18+；执行 `npm ci` 安装锁定依赖。macOS/Linux 是本轮验证环境，SSH 服务器目标为 Linux。
- 企业自己的 Cloudflare 账号、已激活 DNS Zone、Workers 付费计划及所选模块需要的产品能力。
- 一个员工入口域名与一个服务根域名，例如 `work.example.com` 和 `workspace.example.com`。当前安装器要求它们都属于同一账号、同一 DNS Zone。支持多级根域名，不填写 `*.` 或 URL 协议。
- 安装 API Token：账号读取、Zone 读取、DNS 编辑、Workers/Pages 部署，以及所选 D1、R2、Queues 等产品的管理权限。令牌权限随模块而变；使用专门的企业令牌，在 Cloudflare 内核对具体权限名称和资源范围。
- 工作室、邮件、Stream、备份使用单独的运行令牌。只授予这些模块需要的资源权限，不把个人全局 API Key 当作运行凭据。
- Cloudflare 邮件发送能力及可用的系统发件地址。部署 `send_email` 绑定不等于自动开通发送权限；发件域验证、相关产品开通及必要的邮件路由应事先完成。安装后实际收取验证码是必做验收。
- 入站邮件如需由 Mail Worker 接收，还需在 Cloudflare 配置邮件域的 DNS/MX 与路由。安装器不会覆盖企业已有邮箱域的 MX。
- 小程序需要企业自己的 AppID、微信平台配置和发布流程；仅部署 Miniapp API 不等于发布小程序。

## 图形安装

执行 `npm run setup`，打开终端给出的链接。不要把链接分享给别人。

1. 填写名称、Logo 或品牌简写、配色、域名与实例标识。
2. 配置 Cloudflare、邮箱白名单、首位管理员邮箱和可选 Entra。
3. 选择模块和 LiteLLM 接入方式。
4. 设置至少 16 字符的本地凭据库密码。
5. 生成计划并审阅；确认后执行。
6. 服务部署成功后，用指定邮箱完成真实登录，再输入一次性令牌认领所有权。
7. 在 `/admin/operations` 完成 Entra 与模型验收。

首位所有者必须使用配置中的邮箱。普通邮箱注册不自动成为管理员；不能直接停用或删除现有所有者，应先移交给有效账号。

本机会话有效期两小时。刷新可继续当前会话、计划和执行进度；停止安装服务后，应使用同一实例配置、目录和凭据库密码重新生成/执行计划，已成功的步骤会通过状态记录恢复。密码不会自动上传或找回。

## 命令行

将 `config/installation.example.json` 复制到私有位置并修改。配置仅引用环境变量，例如 `env:CLOUDFLARE_API_TOKEN`；不把真实密钥写进配置或计划。

在当前终端通过安全的本地凭据管理方式设置所引用变量，以及 `WORKSPACE_VAULT_PASSWORD`，然后：

```sh
npm run setup:plan -- /private/path/installation.json /private/path/install-plan.json
npm run setup:apply -- /private/path/install-plan.json <计划输出的完整ID>
node packages/installer/src/cli.mjs status <实例标识>
node packages/installer/src/cli.mjs claim-token <实例标识>
```

最后一个命令会显示一次性认领凭据，请只在受控终端使用。计划 ID 绑定配置、版本与源码指纹，源码修改后必须重新审阅计划。`$schema` 是配置版本标识，不依赖在线下载该地址。

## LiteLLM

已有服务：提供 HTTPS 根地址、Team ID、允许模型、月预算、管理/配置 Key 和运行 Key。安装器检查数据库就绪状态、Team 与运行 Key 的范围。若服务版本或许可不允许所需管理能力，流程会失败，不会悄悄把管理 Key 当作用户 Key。

服务器模式：提供 Linux 主机、SSH 用户、私钥文件、已核验的 `known_hosts`、`/opt/...` 安装目录、上游模型与 Key。目标主机预装 Docker、Compose、tar、ss；至少预留 5 GiB 空间，新实例的 80/443 端口应可用。配置 LiteLLM、PostgreSQL 16/17、Caddy 镜像的 SHA256 摘要；本版配置一个初始模型。DNS 应事先指向服务器，网络应允许 HTTPS 证书签发和上游模型访问。

安装器不会修改 SSH 主机校验规则。服务目录须为空或由同一实例管理；数据使用独立持久卷。升级前导出 PostgreSQL，并在无网络的临时容器内尝试恢复；恢复演练通过后才继续。

模型验收从部署后的 Cloudflare 发起，创建有效期 5 分钟、预算 0.05 USD 的临时 Key，调用一次模型并回收 Key，保存结果。实际费用和限制由模型服务执行。

## Microsoft Entra ID

已有应用模式：配置租户 ID、应用 ID、Secret 环境变量与到期时间。回调必须精确设置为 `https://<员工入口域名>/auth/entra/callback`。

辅助创建模式：提供企业租户的 Microsoft Graph 授权令牌和凭据到期时间。安装器创建单租户 Web 应用、服务主体和 Secret。租户授权由管理员负责，本地界面不会替代 Microsoft 的管理员授权流程。

先使用邮箱验证码登录并认领所有权，再在运行与验收页绑定 Microsoft 身份，完成真实 Entra 登录。使用稳定的租户与对象标识关联身份，不按邮箱前缀推断人员或部门。当前版本支持 Client Secret，不包含证书断言登录。

## 升级

保留原 `.workspace/<实例标识>` 和密码。获取目标版本源码、执行 `npm ci`，用同一实例配置生成升级计划：

```sh
npm run upgrade -- /private/path/installation.json /private/path/upgrade-plan.json
npm run setup:apply -- /private/path/upgrade-plan.json <计划输出的完整ID>
```

升级执行前导出所有已管理 D1 数据库，应用 `schemas/` 的向前迁移，保留资源标识和密钥，然后重新发布和检查服务。安装器不会自动删除被关闭模块的持久化资源。涉及数据或域名的变更，应先在测试实例验证；本版不提供一键降级或自动恢复旧版本。

## 故障恢复

执行失败后先查看步骤与错误码，修复权限、网络、DNS 或配置，再使用同一计划重试。已成功步骤不会重新执行；创建请求丢失响应时会核对状态记录和同名资源。无所有权记录的同名资源会被拒绝接管。

`.workspace/<实例标识>/state.json`、`vault.json` 和数据库导出应一起安全备份。不要删除状态以绕过冲突。进程异常退出留下锁时，先确认原进程已经终止，再移除该实例的锁文件；保留状态和凭据库。

D1 导出文件位于实例的 `backups/<计划ID前缀>/`；PostgreSQL 导出位于服务器安装目录的 `backups/`。数据库恢复属于单独的运维操作，不会因重试部署而自动覆盖当前数据。
