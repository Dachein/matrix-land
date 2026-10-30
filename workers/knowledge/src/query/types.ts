export type KnowledgeServiceQueryAction = "tree" | "glob" | "search" | "grep" | "read";

export type KnowledgeQueryLedgerContext = {
  queryId: string;
  queryStepId: string;
  startedAt: number;
};
