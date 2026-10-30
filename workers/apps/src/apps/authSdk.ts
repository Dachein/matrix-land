import type { AppsApp } from "../../../../src/shared/types";
import { buildAppDeveloperContext } from "../../../../src/shared/appsAgentHandoff";
import {
  WORKSPACE_AUTH_SDK_EMBEDDED_SHA256,
  WORKSPACE_AUTH_SDK_EMBEDDED_SIZE_BYTES,
  WORKSPACE_AUTH_SDK_EMBEDDED_VERSION,
} from "./authSdkPackageMetadata";

export const WORKSPACE_AUTH_SDK_NAME = "@frontier-workspace/auth";
export const WORKSPACE_AUTH_SDK_VERSION = WORKSPACE_AUTH_SDK_EMBEDDED_VERSION;
export const WORKSPACE_AUTH_SDK_SHA256 = WORKSPACE_AUTH_SDK_EMBEDDED_SHA256;

export function appAuthSdkHandoff(app: AppsApp) {
  const packageUrl = `${new URL(app.manifest.mcp.platformUrl).origin}/sdk/workspace-auth/v${WORKSPACE_AUTH_SDK_VERSION}.tgz`;
  const appOrigin = app.productionUrl || app.manifest.runtime.fallbackProductionUrl;
  const directoryReadScope = app.directoryReadScope === "company" ? "company" : "app";
  const developerContext = buildAppDeveloperContext(app);
  const departmentAccessTargets = app.accessTargets
    .filter((target) => target.toLowerCase().startsWith("department:"))
    .map((target) => target.slice("department:".length));
  const example = `import {
  WorkspaceAuthDirectory,
  WorkspaceBrowserAppSession,
  hasDepartmentAccess
} from "@frontier-workspace/auth";

interface Env {
  WORKSPACE_AUTH_APP_SECRET: string;
  WORKSPACE_APP_SESSION_SECRET: string;
  WORKSPACE_AUTH_ORIGIN: string;
  WORKSPACE_AUTH_AUTHORIZE_ORIGIN: string;
}

function appAuth(env: Env) {
  return new WorkspaceBrowserAppSession({
    appId: "${app.id}",
    appOrigin: "${appOrigin}",
    appSecret: env.WORKSPACE_AUTH_APP_SECRET,
    appVersion: "1.0.0",
    authOrigin: env.WORKSPACE_AUTH_ORIGIN,
    authorizeOrigin: env.WORKSPACE_AUTH_AUTHORIZE_ORIGIN,
    sessionSecret: env.WORKSPACE_APP_SESSION_SECRET
  });
}

function appDirectory(env: Env) {
  return new WorkspaceAuthDirectory({
    appId: "${app.id}",
    appSecret: env.WORKSPACE_AUTH_APP_SECRET,
    authOrigin: env.WORKSPACE_AUTH_ORIGIN
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const auth = appAuth(env);
    const directory = appDirectory(env);
    if (url.pathname === "/auth/workspace/start") return auth.start(request);
    if (url.pathname === "/auth/workspace/callback") return auth.callback(request);
    if (url.pathname === "/auth/workspace/logout") return auth.logout();
    if (url.pathname === "/auth/workspace/signed-out") return new Response("Signed out");

    if (url.pathname === "/api/auth/session") {
      const session = await auth.read(request);
      return session
        ? Response.json({ authenticated: true, workspaceUser: session.user })
        : Response.json({ authenticated: false }, { status: 401 });
    }

    // Server-only proxy: never expose WORKSPACE_AUTH_APP_SECRET or construct WorkspaceAuthDirectory in browser code.
    // Only add this route when the product actually browses or filters by organization.
    // The response is a flat node list; rebuild the tree from parentId/path instead of rendering name-only options.
    if (url.pathname === "/api/directory/departments") {
      await auth.require(request);
      return Response.json(await directory.listDepartments({
        q: url.searchParams.get("q") || undefined,
        limit: 500
      }));
    }

    // A people-only search does not need a preceding listDepartments call.
    if (url.pathname === "/api/directory/people") {
      await auth.require(request);
      return Response.json(await directory.listPeople({
        q: url.searchParams.get("q") || undefined,
        departmentId: url.searchParams.get("departmentId") || undefined,
        includeDescendants: url.searchParams.get("includeDescendants") !== "false",
        limit: 100
      }));
    }

    if (url.pathname === "/api/auth/department-access") {
      const session = await auth.require(request);
      const allowed = hasDepartmentAccess(session.user, ${JSON.stringify(departmentAccessTargets)});
      return Response.json({ allowed, departmentId: session.user.departmentId });
    }

    const session = await auth.read(request);
    if (!session) {
      const startUrl = new URL("/auth/workspace/start", url.origin);
      startUrl.searchParams.set("return_to", request.url);
      return Response.redirect(startUrl.toString(), 302);
    }
    return Response.json({ user: session.user });
  }
};`;

  return {
    schemaVersion: "workspace.apps.auth-sdk-handoff.v5",
    generatedAt: developerContext.generatedAt,
    contractVersion: developerContext.auth.contractVersion,
    package: {
      installCommand: `npm install ${packageUrl}`,
      name: WORKSPACE_AUTH_SDK_NAME,
      packageUrl: packageUrl,
      sha256: WORKSPACE_AUTH_SDK_SHA256,
      sizeBytes: WORKSPACE_AUTH_SDK_EMBEDDED_SIZE_BYTES,
      version: WORKSPACE_AUTH_SDK_VERSION
    },
    app: {
      appId: app.id,
      directoryReadScope,
      loginRequired: app.loginRequired,
      productionUrl: appOrigin
    },
    configuration: {
      authorizeEndpoint: developerContext.auth.authorizeEndpoint,
      authorizeOrigin: developerContext.auth.env.WORKSPACE_AUTH_AUTHORIZE_ORIGIN,
      authOrigin: developerContext.auth.env.WORKSPACE_AUTH_ORIGIN,
      callbackPath: developerContext.auth.callbackPath,
      sessionEndpoint: developerContext.auth.sessionEndpoint,
      logoutEndpoint: developerContext.auth.logoutEndpoint,
      tokenExchangeEndpoint: developerContext.auth.tokenExchangeEndpoint,
      env: developerContext.auth.env
    },
    capabilities: {
      authentication: {
        class: "WorkspaceBrowserAppSession",
        features: ["login_start", "one_time_code_callback", "signed_app_session", "session_read", "logout"]
      },
      directory: {
        class: "WorkspaceAuthDirectory",
        serverOnly: true,
        directoryReadScope,
        policyFiltered: directoryReadScope === "app",
        methods: {
          listDepartments: `Use only for organization browsing, department selection, or department-scoped behavior. It returns ${directoryReadScope === "company" ? "active company" : "App-admission-visible active"} departments as flat nodes; rebuild the hierarchy from parentId/path.`,
          listPeople: "Search active people by text or immutable departmentId, with optional descendant inclusion. For a people-only search, pass q directly and do not prefetch departments.",
          getPerson: "Resolve one exact immutable Workspace user id within directoryReadScope before importing or linking identity data. This does not evaluate or grant App launch admission.",
          checkAccess: "Re-evaluate one user against the current central App access policy."
        },
        endpoints: {
          departments: `${developerContext.auth.env.WORKSPACE_AUTH_ORIGIN}/v1/app-directory/departments`,
          people: `${developerContext.auth.env.WORKSPACE_AUTH_ORIGIN}/v1/app-directory/people`,
          accessCheck: `${developerContext.auth.env.WORKSPACE_AUTH_ORIGIN}/v1/app-directory/access/check`
        },
        returnedDepartmentFields: ["id", "name", "externalId", "parentId", "path", "status"],
        returnedPersonFields: ["id", "name", "email", "jobTitle", "department", "departmentId", "departmentPath", "team", "teamId", "teamPath"]
      },
      departmentAuthorization: {
        helpers: ["hasDepartmentAccess", "requireDepartmentAccess"],
        configuredDepartmentIds: departmentAccessTargets,
        rule: "Authorize with immutable departmentId/departmentPath values from the verified Workspace session; never authorize with department display text or browser input.",
        onlineCheck: "Use WorkspaceAuthDirectory.checkAccess(userId) before privileged or high-impact writes when the local App session may be stale."
      },
      appMcpAuthorization: {
        class: "WorkspaceMcpAuthorization",
        manifestSchema: "workspace.app-mcp/v1",
        roleResolver: "WorkspaceAppRoleResolver",
        effectiveRoleResolver: "resolveEffectiveAppRoles",
        roleSources: {
          local: "Read current App-local Member roles from the App database on every privileged browser/API request and every MCP discovery/execution request.",
          system: "Read app_owner/app_collaborator live from WorkspaceAuthDirectory.checkAccess for browser/API requests; Workspace Auth signs the same roles into short-lived App MCP Resource Tokens. Never copy them into the App Member table."
        },
        defaultSystemRoleInheritance: {
          app_owner: "owner when the Manifest declares owner",
          app_collaborator: "admin when the Manifest declares admin"
        },
        mappingSemantics: {
          noImplicitHierarchy: "Roles are a set, not a hierarchy. owner does not imply admin, and admin does not imply member. Map app_owner to both owner and admin when owner must pass admin-only checks.",
          ownerPrecedence: "System-role resolution is exclusive. If the same identity is owner and collaborator, Workspace Auth returns app_owner; app_owner must therefore map every App role the owner needs.",
          omittedField: "When authorization.systemRoleInheritance is omitted, app_owner inherits owner and app_collaborator inherits admin only when those conventional target roles are declared.",
          omittedKey: "When the mapping object is present but one system-role key is omitted, that key keeps its conventional default. Declare both keys for a fully explicit policy.",
          emptyList: "An explicit [] disables inheritance for that system role.",
          customTargets: "Each system role may map to one or more App-defined roles, including business roles. Every target must be declared in authorization.roles or Manifest validation fails closed."
        },
        examples: {
          integratedDefault: {
            description: "Declare owner/admin/member and omit systemRoleInheritance to use the conventional integrated policy.",
            systemRoleInheritance: "omitted"
          },
          independent: {
            description: "Keep App Center authorship separate from App-local content authorization.",
            systemRoleInheritance: {
              app_owner: [],
              app_collaborator: []
            }
          },
          custom: {
            description: "Make owners satisfy owner, admin, and reviewer checks while collaborators satisfy admin checks.",
            systemRoleInheritance: {
              app_owner: ["owner", "admin", "reviewer"],
              app_collaborator: ["admin"]
            }
          }
        },
        runtimeFlow: [
          "App Center saves owner/collaborator state and APPS synchronizes the App projection plus system-role policy version to Workspace Auth.",
          "Browser/API code reads current system roles from WorkspaceAuthDirectory.checkAccess; App MCP receives the same facts in a short-lived Resource Token.",
          "resolveEffectiveAppRoles applies the published Manifest mapping and unions inherited roles with current App-local roles.",
          "UI, browser APIs, MCP listTools, and MCP execution authorize from the same effective roles. No new Workspace login is required; already issued Resource Tokens remain bounded by their short expiry."
        ],
        roleUi: "Show inherited roles as read-only with App Center provenance. Allow editing only App-local Member and business-role assignments; never persist inherited roles in the Member table.",
        acceptanceChecks: [
          "A collaborator receives only explicitly mapped roles and cannot use an owner-only tool.",
          "An owner cannot use an admin-only tool unless app_owner maps to admin or the tool also allows owner.",
          "Authentication alone never grants Member admission, business roles, or row-level data access.",
          "App Center role changes affect both browser/API and MCP authorization without copying local rows.",
          "Empty mappings disable inheritance, unknown targets fail Manifest validation, and data ACL checks still run after RBAC succeeds."
        ],
        independentMode: "Set authorization.systemRoleInheritance.app_owner and/or app_collaborator to [] when content authorization must be independent from App Center authorship.",
        memberMapping: "A verified Workspace Auth user is an identity, not an App role. Use the Manifest defaultRole (normally member) only after the App has admitted that identity as an active Member.",
        businessRoles: "Apps may declare local business roles such as banker, reviewer, approver, or content_editor in addition to owner/admin/member. Business roles and row-level ACLs are App-owned and are not inherited from App Center unless the Manifest explicitly maps them.",
        rule: "Effective roles are the union of App-local Member and business roles plus declaratively inherited live App Center roles. Use the same resolver for UI, browser APIs, MCP listTools, and MCP execution; authentication alone never creates App membership."
      }
    },
    operationGuide: {
      callSelection: [
        {
          scenario: "people_search",
          call: "listPeople({ q, limit })",
          instruction: "Search by name or email directly. Do not call listDepartments and do not add a department selector unless the product requirement explicitly needs one."
        },
        {
          scenario: "organization_browse_or_department_selection",
          call: "listDepartments({ limit: 500 })",
          instruction: `Load the ${directoryReadScope === "company" ? "active company" : "App-admission-visible"} organization nodes without q for a complete tree candidate, check directoryReadScope/policyFiltered/hasMore, then build a hierarchy by immutable id/parentId/path.`
        },
        {
          scenario: "people_in_department_scope",
          call: "listPeople({ departmentId, includeDescendants, q, limit })",
          instruction: "Pass the selected immutable department id. Set includeDescendants explicitly according to whether the product means one node or the whole subtree."
        },
        {
          scenario: "department_authorization",
          call: "hasDepartmentAccess(session.user, allowedDepartmentIds) or requireDepartmentAccess(...)",
          instruction: "Authorize only with verified session departmentId/departmentPath values. Never use display names, browser values, email domains, or request headers."
        }
      ],
      organizationHierarchy: {
        responseShape: "flat_nodes",
        idSemantics: "id and parentId are immutable department identifiers. path is a root-to-current-node array of immutable department ids, not display labels.",
        displayInstruction: "Index nodes by id, attach each node to parentId, resolve path ids to names for breadcrumbs, and sort siblings for display. Duplicate leaf names under different parents must remain distinct.",
        rootInstruction: "Treat a node as a root only when parentId is absent. If a parent is missing because the result is filtered or truncated, treat the hierarchy as partial rather than silently promoting the node to a real root.",
        queryInstruction: "Use q only for department lookup results, not for constructing a complete organization tree, because matching can omit ancestors.",
        completenessInstruction: `Always inspect directoryReadScope, policyFiltered, and hasMore. company + policyFiltered=false means the active company directory; app + policyFiltered=true means the App admission slice. Directory scope never grants App launch access. If hasMore=true, SDK ${WORKSPACE_AUTH_SDK_VERSION} has not returned a complete tree; do not present it as complete.`
      },
      roleBoundary: "Organization hierarchy supplies identity facts and ancestry only and does not imply App membership or manager, banker, reviewer, approver, or administrator access. The standard App roles are owner/admin/member; user is the authenticated identity. App owner/collaborator inheritance is explicit in authorization.systemRoleInheritance, while all business roles and data ACLs remain App-local."
    },
    secretProvisioning: {
      mode: "platform_managed",
      manualDeclarationRequired: false,
      lifecycle: "APPS creates independent App secrets after Auth source preflight and before runtime deployment, then injects them only into this App target.",
      secrets: developerContext.auth.managedSecrets
    },
    migration: {
      assessment: developerContext.auth.migrationAssessment,
      d1Impact: "WorkspaceBrowserAppSession uses a signed App cookie and does not require a D1 session table. Keep App user/profile and business-access tables; retire any legacy session table only after a verified cutover.",
      checklist: [
        "Replace custom browser code exchange and locally trusted identity with WorkspaceBrowserAppSession.",
        "Expose start, callback, session read, logout, and signed-out routes from the executable entrypoint.",
        "Use only session.user as workspaceUser and keep App business authorization separate.",
        "Replace direct Portal/Admin directory calls with the server-only WorkspaceAuthDirectory client; never expose App Basic credentials to browser code.",
        "Choose the smallest directory call for the feature: use listPeople({ q }) for people-only search; call listDepartments only for organization browsing, department selection, or department-scoped behavior.",
        "When departments are required, reconstruct the multi-level tree from immutable id/parentId/path, resolve path ids to display names, and check policyFiltered/hasMore before presenting the result as complete.",
        "Use immutable departmentId/departmentPath values for department permissions and re-check central App access before privileged writes.",
        "Declare App-local roles in the Manifest and resolve effective roles with resolveEffectiveAppRoles. By default app_owner inherits owner and app_collaborator inherits admin when those target roles exist.",
        "Treat App roles as a set with no implicit hierarchy. If an owner must satisfy admin-only tools, map app_owner to both owner and admin or allow owner on those tools.",
        "Keep App Center system roles live and read-only in App role UIs. Never seed or copy owner/collaborator membership into the App Member table; explicitly map a system role to [] for independent content authorization.",
        "Test default, empty, partial, and custom multi-role mappings plus a negative Member/business-role/data-ACL case before release.",
        "Bundle the official SDK without minification so deployment preflight can inspect the runtime.",
        "Run local tests and frontier-workspace apps deploy --dry-run, then request approval before the real deployment."
      ]
    },
    deployment: {
      pages: "Bundle the Pages Function without minification, then use frontier-workspace apps deploy --target pages with the generated _worker.bundle and static output.",
      worker: "Bundle dependencies without minification, then use frontier-workspace apps deploy --target worker with the generated Worker entry module."
    },
    example,
    requiredSecrets: ["WORKSPACE_AUTH_APP_SECRET", "WORKSPACE_APP_SESSION_SECRET"]
  };
}
