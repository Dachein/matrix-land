import {
  WORKSPACE_MATE_ENVIRONMENT_SCHEMA_VERSION,
  normalizeWorkspaceMateEnvironmentContext,
  type WorkspaceMateEnvironmentContext
} from "./environment.ts";

export type WorkspaceMateEnvironmentSnapshot = Omit<WorkspaceMateEnvironmentContext, "revision" | "schemaVersion">;

export class WorkspaceMateEnvironmentController {
  private context?: WorkspaceMateEnvironmentContext;
  private lastRevision = 0;
  private readonly listeners = new Set<(context: WorkspaceMateEnvironmentContext | undefined) => void>();

  constructor(initial?: WorkspaceMateEnvironmentContext) {
    if (initial) {
      this.context = normalizeWorkspaceMateEnvironmentContext(initial);
      this.lastRevision = this.context.revision;
    }
  }

  current() {
    return this.context ? structuredClone(this.context) : undefined;
  }

  replace(snapshot: WorkspaceMateEnvironmentSnapshot) {
    const context = normalizeWorkspaceMateEnvironmentContext({
      ...snapshot,
      revision: this.lastRevision + 1,
      schemaVersion: WORKSPACE_MATE_ENVIRONMENT_SCHEMA_VERSION
    });
    this.context = context;
    this.lastRevision = context.revision;
    this.emit();
    return this.current()!;
  }

  accept(context: WorkspaceMateEnvironmentContext) {
    const normalized = normalizeWorkspaceMateEnvironmentContext(context);
    if (normalized.revision < this.lastRevision) throw new Error("mate_environment_revision_stale");
    if (normalized.revision === this.lastRevision) {
      if (this.context && JSON.stringify(normalized) === JSON.stringify(this.context)) return this.current()!;
      throw new Error(this.context ? "mate_environment_revision_conflict" : "mate_environment_revision_stale");
    }
    this.context = normalized;
    this.lastRevision = normalized.revision;
    this.emit();
    return this.current()!;
  }

  clear() {
    if (!this.context) return;
    this.context = undefined;
    this.emit();
  }

  onChange(listener: (context: WorkspaceMateEnvironmentContext | undefined) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit() {
    const context = this.current();
    this.listeners.forEach((listener) => listener(context));
  }
}
