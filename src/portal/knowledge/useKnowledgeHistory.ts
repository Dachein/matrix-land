import { useLayoutEffect, useRef, useState } from "react";
import type { KnowledgeItem, KnowledgeTranslate } from "./types";
import type {
  KnowledgeAuditCategory,
  KnowledgeAuditScope,
  KnowledgeChangeSummary,
  KnowledgeChangeListResponse,
  KnowledgeChangeDetailResponse,
  KnowledgeDiffResponse
} from "./workspaceTypes";
import { errorMessage, knowledgeFetch } from "./utils";

// Own audit list pagination, selected change details and stored diffs.
export function useKnowledgeHistory({ t, setMessage, userId }: {
  t: KnowledgeTranslate;
  setMessage: (message: string) => void;
  userId: string;
}) {
  const [historyTarget, setHistoryTarget] = useState<KnowledgeItem>();
  const [historyChanges, setHistoryChanges] = useState<KnowledgeChangeSummary[]>([]);
  const [historyDetail, setHistoryDetail] = useState<KnowledgeChangeDetailResponse>();
  const [historyDiff, setHistoryDiff] = useState<KnowledgeDiffResponse>();
  const [historyCategory, setHistoryCategory] = useState<KnowledgeAuditCategory>("all");
  const [historySearch, setHistorySearch] = useState("");
  const [historyPage, setHistoryPage] = useState(1);
  const [historyCursor, setHistoryCursor] = useState("");
  const [historyCursorStack, setHistoryCursorStack] = useState<string[]>([]);
  const [historyNextCursor, setHistoryNextCursor] = useState<string | null>(null);
  const [historyScope, setHistoryScope] = useState<KnowledgeAuditScope>();
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const requests = useRef({ page: 0, detail: 0 });

  useLayoutEffect(() => {
    closeChangeHistory();
    return () => {
      requests.current.page++;
      requests.current.detail++;
    };
  }, [userId]);

  async function openChangeHistory(item: KnowledgeItem) {
    if (!item.capabilities.canReadChangeAudit) {
      return;
    }
    setHistoryTarget(item);
    setHistoryCategory("all");
    setHistorySearch("");
    setHistoryPage(1);
    setHistoryCursor("");
    setHistoryCursorStack([]);
    setHistoryNextCursor(null);
    setHistoryScope(undefined);
    await loadHistoryPage(item, {
      category: "all",
      cursor: "",
      cursorStack: [],
      page: 1,
      query: ""
    });
  }

  async function loadHistoryPage(
    item: KnowledgeItem,
    input: {
      category: KnowledgeAuditCategory;
      cursor: string;
      cursorStack: string[];
      page: number;
      query: string;
    }
  ) {
    const pageRequest = ++requests.current.page;
    const detailRequest = ++requests.current.detail;
    setHistoryChanges([]);
    setHistoryDetail(undefined);
    setHistoryDiff(undefined);
    setIsHistoryLoading(true);
    try {
      const params = new URLSearchParams({
        category: input.category,
        limit: "10",
        objectId: item.id
      });
      if (input.cursor) params.set("cursor", input.cursor);
      if (input.query.trim()) params.set("q", input.query.trim());
      const response = await knowledgeFetch<KnowledgeChangeListResponse>(
        `/api/audit/changes?${params.toString()}`
      );
      if (requests.current.page !== pageRequest) return;
      const changes = response.changes ?? [];
      setHistoryCategory(input.category);
      setHistoryCursor(input.cursor);
      setHistoryCursorStack(input.cursorStack);
      setHistoryNextCursor(response.nextCursor ?? null);
      setHistoryPage(input.page);
      setHistoryScope(response.scope);
      setHistoryChanges(changes);
      const first = changes[0];
      if (first) {
        await selectHistoryChange(first.id);
      }
    } catch (error) {
      if (requests.current.page === pageRequest) setMessage(errorMessage(error, t("knowledge.historyLoadFailed")));
    } finally {
      // A selected detail owns the loading indicator once the list has loaded.
      if (requests.current.page === pageRequest && requests.current.detail === detailRequest) setIsHistoryLoading(false);
    }
  }

  async function searchChangeHistory() {
    if (!historyTarget) return;
    await loadHistoryPage(historyTarget, {
      category: historyCategory,
      cursor: "",
      cursorStack: [],
      page: 1,
      query: historySearch
    });
  }

  async function changeHistoryCategory(category: KnowledgeAuditCategory) {
    if (!historyTarget) return;
    await loadHistoryPage(historyTarget, {
      category,
      cursor: "",
      cursorStack: [],
      page: 1,
      query: historySearch
    });
  }

  async function nextHistoryPage() {
    if (!historyTarget || !historyNextCursor) return;
    await loadHistoryPage(historyTarget, {
      category: historyCategory,
      cursor: historyNextCursor,
      cursorStack: [...historyCursorStack, historyCursor],
      page: historyPage + 1,
      query: historySearch
    });
  }

  async function previousHistoryPage() {
    if (!historyTarget || historyPage <= 1) return;
    const previousCursor = historyCursorStack.at(-1) ?? "";
    await loadHistoryPage(historyTarget, {
      category: historyCategory,
      cursor: previousCursor,
      cursorStack: historyCursorStack.slice(0, -1),
      page: Math.max(1, historyPage - 1),
      query: historySearch
    });
  }

  async function selectHistoryChange(changeSetId: string) {
    const pageRequest = requests.current.page;
    const detailRequest = ++requests.current.detail;
    const isCurrent = () => requests.current.page === pageRequest && requests.current.detail === detailRequest;
    setHistoryDetail(undefined);
    setHistoryDiff(undefined);
    setIsHistoryLoading(true);
    try {
      const detail = await knowledgeFetch<KnowledgeChangeDetailResponse>(
        `/api/audit/changes/${encodeURIComponent(changeSetId)}`
      );
      if (!isCurrent()) return;
      setHistoryDetail(detail);
      const diffItem = detail.items?.find((item) => item.diff?.status === "ready");
      if (diffItem) {
        const diff = await knowledgeFetch<KnowledgeDiffResponse>(
          `/api/audit/change-items/${encodeURIComponent(diffItem.id)}/diff?maxBytes=200000`
        );
        if (isCurrent()) setHistoryDiff(diff);
      }
    } catch (error) {
      if (isCurrent()) setMessage(errorMessage(error, t("knowledge.historyLoadFailed")));
    } finally {
      if (isCurrent()) setIsHistoryLoading(false);
    }
  }

  function closeChangeHistory() {
    requests.current.page++;
    requests.current.detail++;
    setIsHistoryLoading(false);
    setHistoryTarget(undefined);
    setHistoryChanges([]);
    setHistoryDetail(undefined);
    setHistoryDiff(undefined);
    setHistoryCategory("all");
    setHistorySearch("");
    setHistoryPage(1);
    setHistoryCursor("");
    setHistoryCursorStack([]);
    setHistoryNextCursor(null);
    setHistoryScope(undefined);
  }

  return {
    historyTarget,
    historyChanges,
    historyDetail,
    historyDiff,
    historyCategory,
    historySearch,
    setHistorySearch,
    historyPage,
    historyNextCursor,
    historyScope,
    isHistoryLoading,
    openChangeHistory,
    searchChangeHistory,
    changeHistoryCategory,
    nextHistoryPage,
    previousHistoryPage,
    selectHistoryChange,
    closeChangeHistory,
  };
}
