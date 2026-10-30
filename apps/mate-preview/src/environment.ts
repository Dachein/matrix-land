import type { WorkspaceMateEnvironmentContext } from "../../../sdk/mate/dist/environment.js";

export type PreviewEnvironment = {
  schemaVersion: "workspace.mate-environment/v1";
  revision: number;
  host: {
    appId: "workspace-mate-preview";
    surface: "debug" | "preview";
  };
  location: {
    kind: "host.semantic";
    ref: string;
    route: string;
  };
  summary: {
    label: string;
    state: "candidate";
    facets: {
      releaseVersion?: number;
      runtimeMode: "preview";
    };
  };
};

export type PreviewEnvironmentInput = {
  coordinate: string;
  debug: boolean;
  releaseId: string;
  releaseVersion?: number;
  revision: number;
  mateId: string;
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{3,180}$/;

export function createPreviewEnvironment(input: PreviewEnvironmentInput): PreviewEnvironment {
  const mateId = previewIdentifier(input.mateId, "mate_id_invalid");
  const releaseId = previewIdentifier(input.releaseId, "release_id_invalid");
  const coordinate = normalizePreviewSemanticCoordinate(input.coordinate);
  const revision = normalizedRevision(input.revision);
  const route = previewHostPath(mateId, releaseId, input.debug);
  const releaseVersion = normalizedVersion(input.releaseVersion);
  return {
    schemaVersion: "workspace.mate-environment/v1",
    revision,
    host: {
      appId: "workspace-mate-preview",
      surface: input.debug ? "debug" : "preview"
    },
    location: {
      kind: "host.semantic",
      ref: coordinate,
      route
    },
    summary: {
      label: coordinate,
      state: "candidate",
      facets: {
        ...(releaseVersion === undefined ? {} : { releaseVersion }),
        runtimeMode: "preview"
      }
    }
  };
}

export function createLiveMateEnvironment(input: {
  presentation: "embedded" | "standalone";
  revision: number;
  mateId: string;
}): WorkspaceMateEnvironmentContext {
  const mateId = previewIdentifier(input.mateId, "mate_id_invalid");
  return {
    schemaVersion: "workspace.mate-environment/v1",
    revision: normalizedRevision(input.revision),
    host: {
      appId: "workspace-mate-workspace",
      surface: input.presentation
    },
    location: {
      kind: "mate.conversation",
      ref: `mate:${mateId}`,
      route: `/mates/${encodeURIComponent(mateId)}${input.presentation === "embedded" ? "/embed" : ""}`
    },
    summary: {
      label: mateId,
      state: "live",
      facets: { runtimeMode: "live" }
    }
  };
}

export function defaultPreviewSemanticCoordinate(mateId: string, releaseId: string) {
  const mate = previewIdentifier(mateId, "mate_id_invalid");
  const release = previewIdentifier(releaseId, "release_id_invalid");
  return `mate:${mate}/release:${release}`;
}

export function normalizePreviewSemanticCoordinate(value: unknown) {
  return boundedText(value, 500, "preview_semantic_coordinate_invalid");
}

export function previewHostPath(mateId: string, releaseId: string, debug = false) {
  const mate = previewIdentifier(mateId, "mate_id_invalid");
  const release = previewIdentifier(releaseId, "release_id_invalid");
  const query = new URLSearchParams({ release });
  if (debug) query.set("debug", "1");
  return `/mates/${encodeURIComponent(mate)}/preview?${query}`;
}

export function readPreviewHostRoute(value: Pick<Location, "hash" | "pathname" | "search">) {
  const raw = value.hash.startsWith("#/")
    ? value.hash.slice(1)
    : `${value.pathname}${value.search}`;
  const url = new URL(raw, "https://preview.invalid");
  const match = url.pathname.match(/^\/mates\/([^/]+)\/preview$/);
  if (!match?.[1]) return undefined;
  try {
    const mateId = previewIdentifier(decodeURIComponent(match[1]), "mate_id_invalid");
    const releaseId = previewIdentifier(url.searchParams.get("release") ?? "", "release_id_invalid");
    return {
      debug: url.searchParams.get("debug") === "1",
      releaseId,
      mateId
    };
  } catch {
    return undefined;
  }
}

function previewIdentifier(value: unknown, code: string) {
  const identifier = typeof value === "string" ? value.trim() : "";
  if (!IDENTIFIER_PATTERN.test(identifier)) throw new Error(code);
  return identifier;
}

function boundedText(value: unknown, maximum: number, code: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(code);
  return text;
}

function normalizedVersion(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function normalizedRevision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("preview_environment_revision_invalid");
  return Number(value);
}
