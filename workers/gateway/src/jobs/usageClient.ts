import { createLiteLlmAdminClient } from "../litellmAdmin.ts";
import type { Env } from "../types.ts";
import {
  mergeMaps,
  normalizeTokenUserMap,
  normalizeUserBudgetMap,
  shanghaiSpendQueryRange
} from "./usageAggregation.ts";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_SPEND_LOG_PAGES_PER_DAY = 500;

export function createLiteLlmSnapshotClient(env: Env, fetchImpl: typeof fetch = fetch) {
  const adminJson = createLiteLlmAdminClient(env, fetchImpl);

  return {
    async listUserBudgets() {
      const budgets = new Map<string, number>();
      const seen = new Set<string>();

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const payload = await adminJson(`/user/list?page=${page}&page_size=${PAGE_SIZE}`);
        const pageRowCount = collectionLength(payload, ["users", "data"]);
        const current = normalizeUserBudgetMap(payload);
        let added = 0;
        current.forEach((budget, userId) => {
          if (!seen.has(userId)) {
            seen.add(userId);
            added += 1;
          }
          budgets.set(userId, budget);
        });
        if (!payloadHasMore(payload, page, pageRowCount) || added === 0) {
          break;
        }
      }

      return budgets;
    },

    async listTokenUsers() {
      const userByToken = new Map<string, string>();
      const seen = new Set<string>();

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const payload = await adminJson(`/key/list?return_full_object=true&page=${page}&size=${PAGE_SIZE}`);
        const pageRowCount = collectionLength(payload, ["keys", "data"]);
        const current = normalizeTokenUserMap(payload);
        let added = 0;
        current.forEach((_userId, tokenId) => {
          if (!seen.has(tokenId)) {
            seen.add(tokenId);
            added += 1;
          }
        });
        mergeMaps(userByToken, current);
        if (!payloadHasMore(payload, page, pageRowCount) || added === 0) {
          break;
        }
      }

      return userByToken;
    },

    async *spendLogPages(fromDate: string, toDate: string) {
      const queryRange = shanghaiSpendQueryRange(fromDate, toDate);
      let totalPages = 1;

      for (let page = 1; page <= totalPages; page += 1) {
        const search = new URLSearchParams({
          start_date: queryRange.startDate,
          end_date: queryRange.endDate,
          page: String(page),
          page_size: String(PAGE_SIZE),
          sort_by: "startTime",
          sort_order: "asc"
        });
        const payload = await adminJson(`/spend/logs/v2?${search.toString()}`);
        const record = readRecord(payload);
        const logs = record.data;
        const reportedPage = nonNegativeInteger(record.page);
        const reportedTotalPages = nonNegativeInteger(record.total_pages ?? record.totalPages);

        if (!Array.isArray(logs)
          || reportedPage !== page
          || reportedTotalPages === undefined) {
          throw new Error("litellm_spend_logs_invalid_payload");
        }
        if (reportedTotalPages > MAX_SPEND_LOG_PAGES_PER_DAY) {
          throw new Error("litellm_spend_logs_truncated");
        }

        totalPages = Math.max(totalPages, reportedTotalPages);
        yield logs;
      }
    }
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function collectionLength(value: unknown, keys: string[]) {
  if (Array.isArray(value)) {
    return value.length;
  }
  const record = readRecord(value);
  for (const key of keys) {
    if (Array.isArray(record[key])) {
      return record[key].length;
    }
  }
  return 0;
}

function payloadHasMore(value: unknown, page: number, pageRowCount: number) {
  const record = readRecord(value);
  const explicit = record.has_more ?? record.hasMore;
  if (typeof explicit === "boolean") {
    return explicit;
  }

  const totalPages = positiveNumber(record.total_pages ?? record.totalPages ?? record.pages);
  if (totalPages !== undefined) {
    return page < totalPages;
  }

  const totalRows = positiveNumber(record.total_count ?? record.totalCount ?? record.total);
  if (totalRows !== undefined) {
    return page * PAGE_SIZE < totalRows;
  }

  return pageRowCount >= PAGE_SIZE;
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}
