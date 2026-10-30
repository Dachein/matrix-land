export type AuthSecuritySourceFile = {
  content: string;
  contentType?: string;
  path: string;
};

export type AuthSecurityPreflightInput = {
  entrypoint?: string;
  loginRequired: boolean;
  sourceFiles: AuthSecuritySourceFile[];
};

export type AuthSecurityFindingSeverity = "critical" | "warning";

export type AuthSecurityFinding = {
  code: string;
  how: string;
  line?: number;
  message: string;
  path?: string;
  severity: AuthSecurityFindingSeverity;
  why: string;
};

export type AuthSecurityPreflightReport = {
  findings: AuthSecurityFinding[];
  inspectedFileCount: number;
  loginRequired: boolean;
  ok: boolean;
  status: "blocked" | "passed" | "warning";
  summary: {
    critical: number;
    warnings: number;
  };
};

const RUNTIME_EXTENSION = /\.(?:cjs|cts|js|jsx|mjs|mts|py|ts|tsx)$/i;
const CLOUDFLARE_PAGES_RUNTIME = /(?:^|\/)_worker\.bundle$/i;
const NON_RUNTIME_PATH = /(?:^|\/)(?:__tests__|docs?|examples?|fixtures?|tests?)(?:\/|$)|\.(?:spec|test)\.[^.]+$/i;
const UNTRUSTED_IDENTITY_HEADER = /^(?:cf-access-[a-z0-9-]+|x-workspace-(?:admin|department|group|org|permission|provider|role|scope|team|tenant|user)(?:s|-|$))/i;
const LOCAL_ONLY_MARKER = /\bisLocalHost\s*\(|\blocalhost\b|127\.0\.0\.1|\[::1\]/i;

/**
 * Pure source inspection used before an app is eligible for publication.
 * It is deliberately dependency-free so callers can run it before Env or D1 exist.
 */
export function inspectAuthSecurityPreflight(input: AuthSecurityPreflightInput): AuthSecurityPreflightReport {
  const sourceFiles = Array.isArray(input.sourceFiles) ? input.sourceFiles : [];
  const runtimeFiles = reachableRuntimeFiles(sourceFiles, input.entrypoint)
    .map((file) => ({ ...file, inspectedContent: maskComments(file.content) }));
  const findings: AuthSecurityFinding[] = [];

  for (const file of runtimeFiles) {
    inspectIdentityHeaders(file.path, file.inspectedContent, findings);
    inspectSessionSecrets(file.path, file.inspectedContent, findings);
    inspectDevBypass(file.path, file.inspectedContent, findings);
  }

  if (input.loginRequired && !hasPlatformAuthIntegration(runtimeFiles.map((file) => file.inspectedContent))) {
    if (runtimeFiles.length === 0) {
      findings.push({
        code: "AUTH_STATIC_EDGE_ENFORCEMENT_UNVERIFIED",
        how: "Call apps_app_read with action=get and this appId to refresh the canonical App context, then follow developerContext.nextActions to apps_app_read(action=auth_sdk). Install the returned @frontier-workspace/auth package and upload an inspectable Pages _worker.bundle that enforces WorkspaceBrowserAppSession before serving protected content.",
        message: "loginRequired is enabled but this bundle has no inspectable server runtime that can enforce it.",
        severity: "critical",
        why: "A manifest flag does not protect static files; without a verified edge handler, anonymous callers can receive the application content."
      });
    } else {
      findings.push({
        code: "AUTH_PLATFORM_INTEGRATION_MISSING",
        how: "Call apps_app_read with action=get and this appId to refresh the canonical App context, then follow developerContext.nextActions to apps_app_read(action=auth_sdk) and use the returned @frontier-workspace/auth Worker example. The public handler must complete WorkspaceBrowserAppSession callback/session verification or WorkspaceAuthResource token verification and fail closed.",
        message: "loginRequired is enabled but no executable platform Auth exchange or verified resource-session integration was found.",
        severity: "critical",
        why: "A manifest flag or development identity does not prove that the public handler authenticated the caller."
      });
    }
  }

  findings.sort(compareFindings);
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const warnings = findings.length - critical;
  return {
    findings,
    inspectedFileCount: runtimeFiles.length,
    loginRequired: input.loginRequired === true,
    ok: critical === 0,
    status: critical > 0 ? "blocked" : warnings > 0 ? "warning" : "passed",
    summary: { critical, warnings }
  };
}

export class AuthSecurityPreflightError extends Error {
  readonly code = "auth_security_preflight_failed";
  readonly report: AuthSecurityPreflightReport;
  readonly status = 422;

  constructor(report: AuthSecurityPreflightReport) {
    super("auth_security_preflight_failed");
    this.name = "AuthSecurityPreflightError";
    this.report = report;
  }
}

/** Returns the report or throws one stable, machine-readable error for blockers. */
export function assertAuthSecurityPreflight(input: AuthSecurityPreflightInput): AuthSecurityPreflightReport {
  const report = inspectAuthSecurityPreflight(input);
  if (!report.ok) {
    throw new AuthSecurityPreflightError(report);
  }
  return report;
}

function isRuntimeSource(path: string) {
  const normalized = String(path || "").replace(/\\/g, "/");
  return (RUNTIME_EXTENSION.test(normalized) || CLOUDFLARE_PAGES_RUNTIME.test(normalized))
    && !NON_RUNTIME_PATH.test(normalized);
}

function isExecutableSource(path: string) {
  const normalized = normalizeSourcePath(path);
  return RUNTIME_EXTENSION.test(normalized) || CLOUDFLARE_PAGES_RUNTIME.test(normalized);
}

/**
 * Restrict authentication evidence to the deployed entry module and its
 * statically reachable local modules. This prevents an unused SDK example in
 * another source file from making an anonymous entrypoint look protected.
 * Dynamic/control-flow proof still belongs to preview black-box certification.
 */
function reachableRuntimeFiles(files: AuthSecuritySourceFile[], entrypoint?: string) {
  if (!entrypoint) {
    return files.filter((file) => isRuntimeSource(file.path));
  }

  const executable = new Map(files
    .filter((file) => isExecutableSource(file.path))
    .map((file) => [normalizeSourcePath(file.path), file]));
  const seeds = new Set<string>();
  const normalizedEntrypoint = normalizeSourcePath(entrypoint);
  if (executable.has(normalizedEntrypoint)) {
    seeds.add(normalizedEntrypoint);
  }
  for (const path of executable.keys()) {
    if (CLOUDFLARE_PAGES_RUNTIME.test(path)) {
      seeds.add(path);
    }
  }

  const reachable = new Set<string>();
  const pending = [...seeds];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (reachable.has(path)) continue;
    const file = executable.get(path);
    if (!file) continue;
    reachable.add(path);
    for (const specifier of localModuleSpecifiers(maskComments(file.content))) {
      const resolved = resolveLocalModule(path, specifier, executable);
      if (resolved && !reachable.has(resolved)) {
        pending.push(resolved);
      }
    }
  }

  return [...reachable].map((path) => executable.get(path)!).filter(Boolean);
}

function localModuleSpecifiers(source: string) {
  const specifiers: string[] = [];
  const pattern = /(?:\bimport\s*(?:[^"'`]*?\s+from\s*)?|\bexport\s+[^"'`]*?\s+from\s*|\brequire\s*\(|\bimport\s*\()\s*["'`]([^"'`]+)["'`]/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1]?.startsWith(".")) specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveLocalModule(
  importer: string,
  specifier: string,
  files: Map<string, AuthSecuritySourceFile>
) {
  const directory = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";
  const base = normalizeSourcePath(`${directory}/${specifier}`);
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => `${base}${extension}`),
    ...["ts", "tsx", "mts", "js", "jsx", "mjs", "cjs"].map((extension) => `${base}/index.${extension}`)
  ];
  return candidates.find((candidate) => files.has(candidate));
}

function normalizeSourcePath(value: string) {
  const output: string[] = [];
  for (const part of String(value || "").replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop();
    else output.push(part);
  }
  return output.join("/");
}

function inspectIdentityHeaders(path: string, source: string, findings: AuthSecurityFinding[]) {
  const headerRead = /(?:\bheaders|\brequest\s*\.\s*headers|\breq\s*\.\s*headers|new\s+Headers\s*\([^)]*\))\s*(?:\.\s*get\s*\(\s*(["'`])([^"'`]+)\1|\[\s*(["'`])([^"'`]+)\3\s*\])/gi;
  const helperRead = /\b(?:header[A-Za-z_$]*|(?:get|read)[A-Za-z_$]*header[A-Za-z_$]*)\s*\(\s*[^,\n]{1,160},\s*(["'`])([^"'`]+)\1/gi;
  const directRead = /\.\s*(?:get|header|getHeader)\s*\(\s*(["'`])([^"'`]+)\1/gi;
  const seen = new Set<string>();
  for (const match of source.matchAll(headerRead)) {
    const header = (match[2] || match[4] || "").trim();
    addIdentityHeaderFinding(path, source, match.index ?? 0, header, seen, findings);
  }
  for (const match of source.matchAll(helperRead)) {
    addIdentityHeaderFinding(path, source, match.index ?? 0, (match[2] || "").trim(), seen, findings);
  }
  for (const match of source.matchAll(directRead)) {
    addIdentityHeaderFinding(path, source, match.index ?? 0, (match[2] || "").trim(), seen, findings);
  }
}

function addIdentityHeaderFinding(
  path: string,
  source: string,
  index: number,
  header: string,
  seen: Set<string>,
  findings: AuthSecurityFinding[]
) {
  if (!UNTRUSTED_IDENTITY_HEADER.test(header)) return;
  const line = lineAt(source, index);
  const key = `${line}:${header.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({
    code: "AUTH_UNTRUSTED_IDENTITY_HEADER",
    how: "Remove this identity source from the public handler. Derive identity only from a platform-signed session/token with issuer, audience and expiry checks.",
    line,
    message: `Public app source reads untrusted identity header ${header.toLowerCase()}.`,
    path,
    severity: "critical",
    why: "A public client controls ordinary HTTP headers; presence of an x-workspace-* or CF identity header is not proof that platform Auth created it."
  });
}

function inspectSessionSecrets(path: string, source: string, findings: AuthSecurityFinding[]) {
  const fallback = /(?:env|process\s*\.\s*env)(?:\s*\?\.|\s*\.|\s*\[)[^;\n]{0,320}?(?:\|\||\?\?)\s*(["'`])([^"'`\r\n]{4,})\1/gi;
  for (const match of source.matchAll(fallback)) {
    if (!containsSessionSecretName(match[0])) continue;
    findings.push(secretFinding(path, source, match.index ?? 0, "A session-signing secret falls back to a source-code literal."));
  }

  const literalAssignment = /\b([A-Za-z_$][\w$]{2,})\s*=\s*(["'`])([^"'`\r\n]{4,})\2/g;
  for (const match of source.matchAll(literalAssignment)) {
    if (!isSessionSecretName(match[1]) || looksLikeErrorLabel(match[3])) continue;
    findings.push(secretFinding(path, source, match.index ?? 0, `Session-signing key ${match[1]} is hard-coded in runtime source.`));
  }

  const literalProperty = /\b([A-Za-z_$][\w$]{2,})\s*:\s*(["'`])([^"'`\r\n]{4,})\2/g;
  for (const match of source.matchAll(literalProperty)) {
    if (!isRuntimeAuthSecretName(match[1]) || looksLikeErrorLabel(match[3])) continue;
    findings.push(secretFinding(path, source, match.index ?? 0, `Authentication key ${match[1]} is hard-coded in runtime source.`));
  }
}

function secretFinding(path: string, source: string, index: number, message: string): AuthSecurityFinding {
  return {
    code: "AUTH_SESSION_SECRET_IN_SOURCE",
    how: "Require a deployment secret of sufficient entropy and fail closed with a configuration error when it is missing; never use a production fallback.",
    line: lineAt(source, index),
    message,
    path,
    severity: "critical",
    why: "Anyone who can read the bundle can mint valid application sessions when the signing key is predictable."
  };
}

function inspectDevBypass(path: string, source: string, findings: AuthSecurityFinding[]) {
  const match = /\b(?:env|process\s*\.\s*env)\s*(?:\?\.|\.|\[\s*["'`])\s*DEV_AUTH_BYPASS\b/i.exec(source);
  if (!match) return;
  const localOnly = LOCAL_ONLY_MARKER.test(source);
  findings.push({
    code: localOnly ? "AUTH_LOCAL_DEV_BYPASS_PRESENT" : "AUTH_DEV_BYPASS_EXPOSED",
    how: localOnly
      ? "Keep the hostname guard and ensure production configuration cannot set the bypass flag."
      : "Remove the bypass or require both an explicit development flag and a strict localhost hostname check.",
    line: lineAt(source, match.index),
    message: localOnly
      ? "A development auth bypass exists but is visibly constrained to a local host."
      : "A development auth bypass is not visibly constrained to localhost.",
    path,
    severity: localOnly ? "warning" : "critical",
    why: localOnly
      ? "Local bypasses remain deployment-sensitive and should be reviewed even when source guards are present."
      : "A production-set flag could turn an anonymous request into an authenticated user."
  });
}

function hasPlatformAuthIntegration(sources: string[]) {
  const source = sources.join("\n");
  const officialBrowserAppSession = /\bworkspace-browser-app-session-v1\b/.test(source)
    && /__Secure-workspace_app_session/.test(source)
    && /__Secure-workspace_app_auth_state/.test(source)
    && /\/v1\/app-login\/exchange/.test(source)
    && /Set-Cookie/.test(source);
  const stateBound = /\b(?:AUTH_STATE_COOKIE|authStateCookie|expectedState|workspace_auth_state)\b/i.test(source);
  const createsLocalSession = /\b(?:createSessionToken|sessionCookie|Set-Cookie)\b/i.test(source);
  const browserAppSession = /\bnew\s+WorkspaceBrowserAppSession\s*\(/.test(source)
    && /\.\s*callback\s*\(/.test(source)
    && /\.\s*(?:read|require)\s*\(/.test(source);
  const sdkLaunchExchange = /\bnew\s+WorkspaceAuthServer\s*\(/.test(source)
    && /\.\s*exchangeLaunch\s*\(/.test(source)
    && /\bredirectUri\b/.test(source)
    && stateBound
    && createsLocalSession;
  const directLaunchExchange = /\/v1\/app-login\/exchange/i.test(source)
    && /\b(?:fetch|fetchImpl|[A-Za-z_$][\w$]*\.fetch)\s*\(/.test(source)
    && /\bmethod\s*:\s*["']POST["']/i.test(source)
    && /\bAuthorization\b[^\n]{0,240}(?:\bBasic\b|\bbasicAuth\s*\(|\bbtoa\s*\()/i.test(source)
    && /\bvalid\b/.test(source)
    && /\bappId\b/.test(source)
    && /\bredirectUri\b/.test(source)
    && stateBound
    && createsLocalSession;
  const resourceVerification = /\bnew\s+WorkspaceAuthResource\s*\(/.test(source)
    && /\.\s*(?:requireAccess|verifyAccessToken)\s*\(/.test(source);
  return officialBrowserAppSession || browserAppSession || sdkLaunchExchange || directLaunchExchange || resourceVerification;
}

function containsSessionSecretName(value: string) {
  const names = value.match(/[A-Za-z_$][\w$]*/g) ?? [];
  return names.some(isSessionSecretName);
}

function isSessionSecretName(value: string) {
  const normalized = value.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
  const hasAuthPurpose = /(?:^|_)(?:AUTH|COOKIE|JWT|SESSION)(?:_|$)/.test(normalized);
  const isKeyMaterial = /(?:^|_)(?:KEY|SECRET)$/.test(normalized);
  return hasAuthPurpose && isKeyMaterial;
}

function isRuntimeAuthSecretName(value: string) {
  const normalized = value.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
  return isSessionSecretName(value)
    || normalized === "APP_SECRET"
    || normalized === "WORKSPACE_AUTH_APP_SECRET";
}

function looksLikeErrorLabel(value: string) {
  return /(?:error|missing|not[_ -]?configured|required|secret[_ -]?name)/i.test(value);
}

function lineAt(source: string, index: number) {
  return source.slice(0, index).split("\n").length;
}

function compareFindings(left: AuthSecurityFinding, right: AuthSecurityFinding) {
  if (left.severity !== right.severity) return left.severity === "critical" ? -1 : 1;
  const path = (left.path ?? "").localeCompare(right.path ?? "");
  if (path !== 0) return path;
  const line = (left.line ?? 0) - (right.line ?? 0);
  return line !== 0 ? line : left.code.localeCompare(right.code);
}

/** Masks comments while preserving offsets and executable string literals. */
function maskComments(source: string) {
  let result = "";
  let mode: "block" | "code" | "double" | "line" | "single" | "template" = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === "line") {
      if (char === "\n") {
        mode = "code";
        result += char;
      } else result += " ";
      continue;
    }
    if (mode === "block") {
      if (char === "*" && next === "/") {
        result += "  ";
        index += 1;
        mode = "code";
      } else result += char === "\n" ? "\n" : " ";
      continue;
    }
    if (mode === "code" && char === "/" && next === "/") {
      result += "  ";
      index += 1;
      mode = "line";
      continue;
    }
    if (mode === "code" && char === "/" && next === "*") {
      result += "  ";
      index += 1;
      mode = "block";
      continue;
    }
    result += char;
    if (char === "\\" && mode !== "code") {
      if (next !== undefined) {
        result += next;
        index += 1;
      }
      continue;
    }
    if (mode === "code" && char === "'") mode = "single";
    else if (mode === "code" && char === '"') mode = "double";
    else if (mode === "code" && char === "`") mode = "template";
    else if (mode === "single" && char === "'") mode = "code";
    else if (mode === "double" && char === '"') mode = "code";
    else if (mode === "template" && char === "`") mode = "code";
  }
  return result;
}
