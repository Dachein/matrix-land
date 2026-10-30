import { useCallback, useEffect, useState } from "react";
import type { AdminUserProfile } from "../../shared/types";

export type AsyncListState = "loading" | "ready" | "error";

const ADMIN_USERS_TIMEOUT_MS = 15000;

export function useAdminUsers(currentUserId: string) {
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [users, setUsers] = useState<AdminUserProfile[]>([]);
  const [state, setState] = useState<AsyncListState>("loading");
  const reload = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ADMIN_USERS_TIMEOUT_MS);

    async function loadUsers() {
      setState("loading");
      setError("");

      try {
        const response = await fetch("/api/admin/users", { signal: controller.signal });

        if (!response.ok) {
          throw new Error("admin_users_unavailable");
        }

        const payload = await response.json() as { users?: AdminUserProfile[] };

        if (!controller.signal.aborted) {
          setUsers(Array.isArray(payload.users) ? payload.users : []);
          setState("ready");
        }
      } catch (caught) {
        if (disposed) {
          return;
        }

        setUsers([]);
        setError(timedOut ? "admin_users_timeout" : caught instanceof Error ? caught.message : "admin_users_unavailable");
        setState("error");
      } finally {
        clearTimeout(timeout);
      }
    }

    void loadUsers();

    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [currentUserId, revision]);

  return { error, reload, setUsers, state, users };
}
