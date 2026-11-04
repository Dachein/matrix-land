# Matrix land 独立安装试验

2026-11-04，在项目专用 Cloudflare 账号 Frontier Workspace Lab 上，从本仓库安装器完成真实云端部署。官网 `https://matrixland.si` 保留独立源码、Git 历史和 `matrixland-website` Pages 项目。产品与官网仍在同一 Cloudflare 账号和 DNS Zone 内，不属于账号级隔离。

## 已验证

- 产品入口：`https://play.matrixland.si`；安装实例 `matrixland-lab`，产品 Pages 项目 `matrixland-lab-portal`。
- 启用 connections、discussions、knowledge、studio；部署 auth、apps、knowledge、mcp、live 五个 Worker。产品入口与各服务健康检查通过。
- 创建四个 D1、五个 R2 和两条 Queue，均使用 `matrixland-lab-` 前缀；R2 已由账号持有人激活。安装器没有升级 Workers 付费计划；供应商超额费用仍按账号订阅计费。
- 安装器配置精确邮箱白名单，仅允许指定的管理员邮箱。真实发送验证码、收信、验证登录、一次性认领管理员通过；同域的其他邮箱被拒绝。浏览器已登录进入工作区。
- 真实知识目录创建、107 字节测试文件上传与下载通过，文件内容一致。
- 管理员运行设置与 Apps MCP 工具发现通过。
- 执行真实升级：升级前四个数据库均已备份，资源 ID、认证密钥和已有知识文件保留。
- 知识库备份从同一 Cloudflare 导出快照生成，以支持 FTS5 表。已在本地恢复并检查完整性，再导入独立临时 D1，核对两条知识对象及外键检查；临时数据库已删除。这是数据库恢复验收，未宣称完成 R2 对象灾难恢复。

## 实测反馈到源码的修复

- 精确邮箱限制覆盖验证码、自注册、会话与 Entra 身份校验；管理员不能通过域策略放宽安装白名单。
- 首次上传 Worker 后，针对供应商短暂元数据不可见的特定错误有限重试。
- Pages 配置移除不支持的账号字段；Functions 预编译成稳定的 Worker 产物再发布。
- 首次登录前初始化默认团队，避免全新 Core 数据库中的用户外键错误。
- FTS5 数据库升级备份使用供应商快照，重建虚拟表与检索索引，按外键依赖导入普通表数据。

## 验收边界

模型模块关闭；目前没有 LiteLLM 服务。Mate 真实模型调用、Entra 登录、入站应用邮件、Stream、小程序及备份模块未启用，也未作云端验收。当前实例仅供首位管理员试用，不代表生产容量、安全审计或全部供应商功能已经验收。

工作室应用创建、部署发布、讨论写入与前端最终检查仍随本轮验收推进。结果应以当前交付记录及实际接口结果为准，不能把工具列表返回成功当作应用发布成功。

## 私有安装材料

安装配置、步骤状态、加密凭据库、业务数据库导出和验收日志保存在本机 `.workspace/matrixland-lab/`，已被 Git 忽略。凭据库密码由本机钥匙串保管；这些文件和密码不进入公开仓库。官网源码也不进入本仓库。

开源地址：<https://github.com/Dachein/matrix-land>，采用 MIT 许可证；贡献与私密漏洞报告入口见仓库 README、CONTRIBUTING 和 SECURITY。

安装步骤见 [installation.md](installation.md)，交付边界见 [delivery.md](delivery.md)。
