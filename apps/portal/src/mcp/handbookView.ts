import type { McpHandbookGroup } from "../../../../src/shared/mcpHandbook";
import type { Locale } from "../../../../src/portal/i18n/resources";

export const LATEST_FEATURE_LIMIT = 10;
export type McpHandbookModuleId = McpHandbookGroup;

type BilingualCopy = {
  en: string;
  zhCN: string;
};

export type McpHandbookModule = {
  description: BilingualCopy;
  id: McpHandbookModuleId;
};

export const MCP_HANDBOOK_MODULES: readonly McpHandbookModule[] = [
  {
    id: "forum-hub",
    description: {
      en: "Read and participate in Forum discussions, and discover, consume, and submit Workspace Hub assets.",
      zhCN: "阅读和参与 Forum 讨论，并发现、使用和提交 Workspace Hub 资产。"
    }
  },
  {
    id: "knowledge",
    description: {
      en: "Retrieve, read, and maintain knowledge as a Consumer or Author.",
      zhCN: "以消费者或作者身份检索、读取和维护知识内容。"
    }
  },
  {
    id: "apps",
    description: {
      en: "Create, configure, deploy, and publish Workers, Pages, Apps, and Skills.",
      zhCN: "创建、配置、部署和发布 Worker、Pages、App 与 Skill。"
    }
  },
  {
    id: "tools",
    description: {
      en: "Use AI resources through tools/* capabilities and the models catalog.",
      zhCN: "通过 tools/* 能力与 models 模型目录使用 AI 资源。"
    }
  }
] as const;

export function latestHandbookFeatures<T>(features: readonly T[]) {
  return features.slice(0, LATEST_FEATURE_LIMIT);
}

export function localizedHandbookCopy(locale: Locale, copy: BilingualCopy) {
  return locale === "zh-CN"
    ? { primary: copy.zhCN, secondary: copy.en, secondaryLocale: "en" as const }
    : { primary: copy.en, secondary: copy.zhCN, secondaryLocale: "zh-CN" as const };
}

export function handbookModule(moduleId: McpHandbookModuleId) {
  const module = MCP_HANDBOOK_MODULES.find((entry) => entry.id === moduleId);
  if (!module) throw new Error(`Unknown MCP Handbook module: ${moduleId}`);
  return module;
}
