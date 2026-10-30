-- Backfill production routing-card metadata for the six registered Agent knowledge services.
-- The INSERT is intentionally scoped to existing services so this migration is safe in
-- development databases that do not contain the production registrations.

INSERT OR IGNORE INTO knowledge_service_profiles (service_id)
SELECT id
FROM knowledge_services
WHERE id IN (
  'ksvc_f92247df-5b25-45a1-bb4b-33a03419b5dd',
  'ksvc_d5ca22d2-8e4b-41ef-b96f-2140cd8089f4',
  'ksvc_dc4d3fd4-ce66-4d0b-bec9-769d3302102f',
  'ksvc_d8df3b3d-5c0f-4b14-969d-d85bcd2954d6',
  'ksvc_ff9fd96f-9f0f-484f-ba10-c039041be27b',
  'ksvc_951e1bb5-4bcc-42d5-879c-2d051f9cc0b9'
);

UPDATE knowledge_services
SET description = 'Workspace Dubai 员工手册，覆盖 DIFC 员工的薪酬福利、考勤休假、入离调转、绩效晋升、行为合规与个人资料隐私。',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'ksvc_f92247df-5b25-45a1-bb4b-33a03419b5dd';

UPDATE knowledge_service_profiles
SET category = 'employee-handbook',
    tags_json = '["Dubai","DIFC","员工手册","薪酬福利","考勤休假","DEWS","绩效晋升","行为合规","个人资料隐私"]',
    languages_json = '["en"]',
    coverage_json = '["Dubai／DIFC 员工适用的雇佣与日常工作指引","薪酬、DEWS、奖金、津贴、医疗及其他员工福利","考勤，以及年假、病假、产假、陪产假和 Hajj 假等休假安排","入职、离职、内部调动、绩效评估、职级与晋升","员工行为、合规要求和个人资料隐私"]',
    not_for_json = '["Dubai／DIFC 以外实体员工的适用政策","个别劳动争议、法律、税务或签证意见","手册版本之后发布但尚未收录的最新政策"]',
    maintenance_team = 'Workspace Human Resources',
    updated_at = CURRENT_TIMESTAMP
WHERE service_id = 'ksvc_f92247df-5b25-45a1-bb4b-33a03419b5dd';

UPDATE knowledge_services
SET description = '一壶科技（深圳）员工手册，覆盖深圳员工的薪酬福利、五险一金、考勤休假、入离调转、绩效晋升、行为合规与个人信息保护。',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'ksvc_d5ca22d2-8e4b-41ef-b96f-2140cd8089f4';

UPDATE knowledge_service_profiles
SET category = 'employee-handbook',
    tags_json = '["深圳","一壶科技","员工手册","五险一金","薪酬福利","考勤休假","入离调转","绩效晋升","行为合规","个人信息保护"]',
    languages_json = '["zh-CN"]',
    coverage_json = '["一壶科技（深圳）员工适用的雇佣与日常工作指引","薪酬、五险一金、奖金、津贴、推荐奖励、餐补交通及体检福利","考勤，以及年假、病假、婚假、产假和陪产假等休假安排","入职、离职、内部调动、绩效评估、职级与晋升","员工行为、合规要求和个人信息保护"]',
    not_for_json = '["一壶科技（深圳）以外实体员工的适用政策","个别劳动争议、法律、税务或社保意见","手册版本之后发布但尚未收录的最新补充规定"]',
    maintenance_team = 'Workspace Human Resources',
    updated_at = CURRENT_TIMESTAMP
WHERE service_id = 'ksvc_d5ca22d2-8e4b-41ef-b96f-2140cd8089f4';

UPDATE knowledge_services
SET description = 'Workspace Singapore 员工手册，覆盖新加坡员工的薪酬福利、CPF／SDL、考勤休假、入离调转、绩效晋升、行为合规与隐私。',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'ksvc_dc4d3fd4-ce66-4d0b-bec9-769d3302102f';

UPDATE knowledge_service_profiles
SET category = 'employee-handbook',
    tags_json = '["Singapore","员工手册","CPF","SDL","薪酬福利","考勤休假","入离调转","绩效晋升","行为合规","个人资料隐私"]',
    languages_json = '["en"]',
    coverage_json = '["Workspace Singapore 员工适用的雇佣与日常工作指引","薪酬、CPF、Skills Development Levy、奖金、津贴、医疗及其他员工福利","考勤，以及年假、病假、育儿假、婴儿照护假和产假等休假安排","入职、离职、内部调动、绩效评估、职级与晋升","员工行为、合规要求和个人资料隐私"]',
    not_for_json = '["Workspace Singapore 以外实体员工的适用政策","个别劳动争议、法律、税务或工作准证意见","手册版本之后发布但尚未收录的最新政策"]',
    maintenance_team = 'Workspace Human Resources',
    updated_at = CURRENT_TIMESTAMP
WHERE service_id = 'ksvc_dc4d3fd4-ce66-4d0b-bec9-769d3302102f';

UPDATE knowledge_services
SET description = '受限的私人银行供应链知识库，供 RM 比较开户候选机构、booking centre、AUM、KYC／SOW、CRS／FATCA、IMA／IAA 与 retag 要求；资料截至 2026-04-28。',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'ksvc_d8df3b3d-5c0f-4b14-969d-d85bcd2954d6';

UPDATE knowledge_service_profiles
SET category = 'private-banking',
    tags_json = '["私人银行","PB","开户","合作机构","booking centre","AUM","KYC","SOW","CRS","FATCA","IMA","IAA","retag","RM"]',
    languages_json = '["zh-CN","en"]',
    coverage_json = '["RM 用于私人银行开户候选机构的初步筛选、比较和路由","合作机构、实体与 booking centre 的已记录覆盖范围","AUM 门槛、KYC／SOW、CRS／FATCA、IMA／IAA 和 retag 等已记录约束","常见问题、客户场景、已知资料缺口和来源登记","资料时点为 2026-04-28，回答需同时说明对应实体和资料日期"]',
    not_for_json = '["替代银行、合规或管理层的最终审批与开户保证","资料时点之后的实时政策、额度、联系人、费用或产品状态","针对客户的个别法律、税务、投资或适当性意见","未迁移的客户对话、客户档案、凭证或其他敏感资料"]',
    maintenance_team = 'Workspace PB Supply Chain',
    updated_at = CURRENT_TIMESTAMP
WHERE service_id = 'ksvc_d8df3b3d-5c0f-4b14-969d-d85bcd2954d6';

UPDATE knowledge_services
SET description = 'Frontier Workspace 平台设计与操作指南，覆盖 Portal、Token、Skills／Apps、APPS、知识库、论坛、MCP、排障、模板与术语。',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'ksvc_ff9fd96f-9f0f-484f-ba10-c039041be27b';

UPDATE knowledge_service_profiles
SET category = 'platform-help',
    tags_json = '["Frontier Workspace","Portal","Token","Skills","Apps","APPS","知识库","论坛","MCP","Cloudflare","排障","操作指南"]',
    languages_json = '["zh-CN","en"]',
    coverage_json = '["Frontier Workspace 平台的快速入门、整体架构和核心术语","Token 创建、保存、测试、轮换、停用及用量查看","Skills／Apps 的发现与使用，以及 APPS 开发、审核、发布和部署","知识库、论坛、MCP 集成、权限与授权方式","常见问题排障、文档模板和平台操作说明；实现资料更新至 2026-08-12"]',
    not_for_json = '["替代 Portal 或 MCP 返回的实时版本、模型目录、价格、配额、权限和服务状态","保存或披露 API Key、OAuth Token、密码、客户资料等敏感信息","文档未覆盖且未经运行时或代码验证的实现细节"]',
    maintenance_team = 'Frontier Workspace Adoption',
    updated_at = CURRENT_TIMESTAMP
WHERE service_id = 'ksvc_ff9fd96f-9f0f-484f-ba10-c039041be27b';

UPDATE knowledge_services
SET description = 'Workspace 公司内部政策与工作资料库，覆盖 HR、Finance、Legal、Marketing 四个领域的 54 份源 PDF、提取文本与检索映射。',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'ksvc_951e1bb5-4bcc-42d5-879c-2d051f9cc0b9';

UPDATE knowledge_service_profiles
SET category = 'company-policy',
    tags_json = '["公司政策","HR","Finance","Legal","Marketing","招聘","员工福利","差旅报销","合同","印章","知识产权","品牌","对外沟通"]',
    languages_json = '["zh-CN","zh-HK","en"]',
    coverage_json = '["HR：招聘、推荐、return offer、津贴、激励、居留、能力模型、香港保险及餐饮交通资料","Finance：差旅住宿、费用报销、发票信息、账户与项目资料","Legal：法律咨询、合同起草与审阅、标准合同、印章、商标版权和律师资料","Marketing：品牌规范、公司资料与奖项、对外沟通、媒体采访、活动和发言人资料","共 54 份源 PDF；重要结论应回读对应 PDF，并核对文件日期与适用主体"]',
    not_for_json = '["替代 HR、Finance、Legal、管理层或其他政策负责人的审批","针对个人的劳动、法律、税务、合规或投资意见","未核对源 PDF 和日期即断言为最新版本或适用于所有实体","把律师介绍、市场宣传或公司资料误当成正式公司政策"]',
    maintenance_team = 'Workspace HR, Finance, Legal & Marketing',
    updated_at = CURRENT_TIMESTAMP
WHERE service_id = 'ksvc_951e1bb5-4bcc-42d5-879c-2d051f9cc0b9';
