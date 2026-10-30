import { type McpToolDefinition } from "./shared.ts";

export const deploymentsToolDefinitions: McpToolDefinition[] = [
{
      name: "apps_update_app_config",
      description: "Update APPS app capabilities, its independent organization-directory read scope, and permanently append runtime resources. directoryReadScope controls directory data visibility only and never changes who can launch the App. Web, Automation, and Container apps may opt into App MCP; Agent apps always require it. addResourceTypes is append-only: existing resources cannot be removed or replaced, and new bindings are applied by the next deployment.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: {
          appId: { type: "string" },
          addResourceTypes: {
            type: "array",
            items: {
              type: "string",
              enum: ["d1_database", "kv_namespace", "r2_bucket", "media", "hyperdrive_config", "cron_trigger", "queue"]
            }
          },
          agentMcpEnabled: { type: "boolean" },
          directoryReadScope: { type: "string", enum: ["app", "company"] },
          llmEnabled: { type: "boolean" },
          emailEnabled: { type: "boolean", description: "Enable or disable one app mailbox with both sending and receiving." },
          emailPrefix: { type: "string", maxLength: 64, description: "Mailbox local part at mail.example.invalid; defaults to the app code." },
          emailTriggerEnabled: { type: "boolean", description: "Deliver signed new-inbound-mail events to the published app callback." },
          emailSendingEnabled: { type: "boolean" },
          emailSenderMailbox: { type: "string" },
          emailRoutingEnabled: { type: "boolean" },
          emailRoutingPrefix: { type: "string" }
        }
      }
    },
    {
      name: "apps_get_mail_sdk",
      description: "Get the current official Workspace Mail SDK package, app mailbox configuration, server-only environment references, send/receive/attachment examples, signed new-mail Trigger contract and upgrade Prompt. Read the app context first; configure the unified mailbox through apps_app_write(update_config).",
      inputSchema: {type:"object",required:["appId"],properties:{appId:{type:"string"}}}
    },
{
      name: "apps_get_auth_sdk",
      description: "Get the official, versioned Workspace App Session and organization-directory SDK package, App-specific login/people/department-permission examples, runtime configuration, platform-managed secret lifecycle, migration checklist, and bundling guidance. Use this only after apps_get_app identifies Auth implementation as a next action.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: {
          appId: { type: "string" }
        }
      }
    },
{
      name: "apps_get_provisioning_status",
      description: "Read APPS app resource provisioning progress by jobId, or the latest job for appId.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string" },
          appId: { type: "string" }
        }
      }
    },
{
      name: "apps_retry_provisioning_job",
      description: "Retry a queued or failed APPS app resource provisioning job.",
      inputSchema: {
        type: "object",
        required: ["jobId"],
        properties: {
          jobId: { type: "string" }
        }
      }
    },
{
      name: "apps_pages_deploy",
      description: "Create a ready Pages deployment from either legacy inline files or a deployment artifact uploaded by Workspace CLI. The app is not published until apps_deployments_publish is called after approval.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        anyOf: [{ required: ["deployArtifactId"] }, { required: ["files"] }],
        properties: {
          appId: { type: "string" },
          deployArtifactId: { type: "string", description: "Preferred deployment artifact uploaded by Workspace CLI. Do not also pass files." },
          sourceSnapshotId: { type: "string", description: "Optional immutable source snapshot created by Workspace CLI." },
          version: { type: "string", description: "Machine-readable version number. Workspace CLI requires this field." },
          versionName: { type: "string", description: "Human-readable version name. Workspace CLI requires this field." },
          releaseNotes: { type: "string", description: "Upgrade summary shown as expandable deployment history." },
          hyperdrive: {
            type: "object",
            additionalProperties: false,
            required: ["scheme", "host", "database", "user"],
            description: "Required on the first deployment when Custom database (Hyperdrive) is enabled. The password is read from the platform-only HYPERDRIVE_PASSWORD App Secret and must not be passed here.",
            properties: {
              scheme: { type: "string", enum: ["postgres", "postgresql", "mysql"] },
              host: { type: "string", maxLength: 253 },
              port: { type: "integer", minimum: 1, maximum: 65535 },
              database: { type: "string", maxLength: 128 },
              user: { type: "string", maxLength: 128 },
              originConnectionLimit: { type: "integer", minimum: 5, maximum: 100 }
            }
          },
          entrypoint: { type: "string" },
          files: {
            type: "array",
            maxItems: 80,
            items: {
              type: "object",
              required: ["path", "content"],
              properties: {
                path: { type: "string" },
                content: { type: "string" },
                contentType: { type: "string" }
              }
            }
          }
        }
      }
    },
{
      name: "apps_worker_deploy",
      description: "Create a ready Worker deployment from either legacy inline files or a deployment artifact uploaded by Workspace CLI.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        anyOf: [{ required: ["deployArtifactId"] }, { required: ["files"] }],
        properties: {
          appId: { type: "string" },
          deployArtifactId: { type: "string", description: "Preferred deployment artifact uploaded by Workspace CLI. Do not also pass files." },
          sourceSnapshotId: { type: "string", description: "Optional immutable source snapshot created by Workspace CLI." },
          version: { type: "string", description: "Machine-readable version number. Workspace CLI requires this field." },
          versionName: { type: "string", description: "Human-readable version name. Workspace CLI requires this field." },
          releaseNotes: { type: "string", description: "Upgrade summary shown as expandable deployment history." },
          hyperdrive: {
            type: "object",
            additionalProperties: false,
            required: ["scheme", "host", "database", "user"],
            description: "Required on the first deployment when Custom database (Hyperdrive) is enabled. The password is read from the platform-only HYPERDRIVE_PASSWORD App Secret and must not be passed here.",
            properties: {
              scheme: { type: "string", enum: ["postgres", "postgresql", "mysql"] },
              host: { type: "string", maxLength: 253 },
              port: { type: "integer", minimum: 1, maximum: 65535 },
              database: { type: "string", maxLength: 128 },
              user: { type: "string", maxLength: 128 },
              originConnectionLimit: { type: "integer", minimum: 5, maximum: 100 }
            }
          },
          cronSchedules: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            description: "Cron expressions to synchronize after the Worker upload. Requires the App cron_trigger resource.",
            items: { type: "string", maxLength: 100 }
          },
          queueConsumer: {
            type: "object",
            additionalProperties: false,
            description: "Optional push-consumer configuration for an App-owned Queue binding.",
            properties: {
              bindingName: { type: "string", default: "QUEUE", maxLength: 64 },
              maxBatchSize: { type: "integer", default: 10, minimum: 1, maximum: 100 },
              maxBatchTimeout: { type: "integer", default: 5, minimum: 0, maximum: 60 },
              maxRetries: { type: "integer", default: 3, minimum: 0, maximum: 100 },
              maxConcurrency: { type: "integer", minimum: 1, maximum: 250 },
              retryDelay: { type: "integer", minimum: 0, maximum: 43200 }
            }
          },
          entrypoint: { type: "string", default: "src/index.ts" },
          files: {
            type: "array",
            maxItems: 80,
            items: {
              type: "object",
              required: ["path", "content"],
              properties: {
                path: { type: "string" },
                content: { type: "string" },
                contentType: { type: "string" }
              }
            }
          }
        }
      }
    },
{
      name: "apps_deployments_list",
      description: "List production deployments for one APPS app.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: {
          appId: { type: "string" }
        }
      }
    },
{
      name: "apps_deployments_get",
      description: "Read one production deployment and its current status.",
      inputSchema: {
        type: "object",
        required: ["appId", "deploymentId"],
        properties: {
          appId: { type: "string" },
          deploymentId: { type: "string" }
        }
      }
    },
{
      name: "apps_deployments_publish",
      description: "Promote a ready deployment to production after explicit user approval. The fixed Workspace Release Readiness Report URL and self-check are optional unless the platform gate is enabled.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: {
          accessTargets: { type: "array", items: { type: "string" } },
          appId: { type: "string" },
          deploymentId: { type: "string" },
          harnessReportUrl: { type: "string", description: "Fixed HTTPS report URL on the App production domain ending in /harness/report.html." },
          harnessSelfCheckConfirmed: { type: "boolean", description: "Set true after reviewing every finding. Optional unless the platform release-readiness gate is enabled." },
          visibility: { type: "string", enum: ["private", "team", "org", "public"] },
          loginRequired: { type: "boolean" }
        }
      }
    },
{
      name: "apps_deployments_rollback",
      description: "Promote a previous deployment back to production after explicit user approval.",
      inputSchema: {
        type: "object",
        required: ["appId", "deploymentId"],
        properties: {
          accessTargets: { type: "array", items: { type: "string" } },
          appId: { type: "string" },
          deploymentId: { type: "string" },
          visibility: { type: "string", enum: ["private", "team", "org", "public"] },
          loginRequired: { type: "boolean" }
        }
      }
    },
{
      name: "apps_d1_migrations_apply",
      description: "Apply one token-validated app-owned APPS D1 migration as an atomic batch. Schema objects and controlled data targets must use the authoritative App prefix; data mutations require separate explicit approval.",
      inputSchema: {
        type: "object",
        required: ["appId", "version", "sql"],
        properties: {
          allowDataMigrations: { type: "boolean", description: "Must be true only after separate explicit user approval for controlled data mutations." },
          appId: { type: "string" },
          contentSha256: { type: "string", description: "Optional SHA-256 of the local migration file. Workspace CLI always supplies it." },
          fileName: { type: "string", description: "Optional local migration filename for provenance." },
          version: { type: "string" },
          tablePrefix: { type: "string", description: "Optional client assertion of the App-owned table prefix. If provided, it must match the service-derived prefix." },
          sql: { type: "string" }
        }
      }
    },
{
      name: "apps_d1_migrations_list",
      description: "List applied app-owned APPS D1 migrations.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: {
          appId: { type: "string" }
        }
      }
    },
{
      name: "apps_d1_schema_get",
      description: "Read app-owned D1 schema objects for the app table prefix.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: {
          appId: { type: "string" },
          tablePrefix: { type: "string" }
        }
      }
    },
{
      name: "apps_env_vars_list",
      description: "List non-secret environment variables configured for a APPS app.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: {
          appId: { type: "string" },
          target: { type: "string", enum: ["runtime", "pages", "worker"] }
        }
      }
    },
{
      name: "apps_env_vars_set",
      description: "Set non-secret environment variables for a APPS app. Do not use for tokens, API keys, passwords, or secrets.",
      inputSchema: {
        type: "object",
        required: ["appId", "vars"],
        properties: {
          appId: { type: "string" },
          target: { type: "string", enum: ["runtime", "pages", "worker"] },
          vars: { type: "object", additionalProperties: { type: "string" } }
        }
      }
    },
{
      name: "apps_env_vars_delete",
      description: "Delete non-secret environment variables from a APPS app.",
      inputSchema: {
        type: "object",
        required: ["appId", "names"],
        properties: {
          appId: { type: "string" },
          target: { type: "string", enum: ["runtime", "pages", "worker"] },
          names: { type: "array", items: { type: "string" } }
        }
      }
    },
{
      name: "apps_kv_keys_list",
      description: "List app-owned KV keys for a APPS app that has a KV resource.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: {
          appId: { type: "string" },
          prefix: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 100 }
        }
      }
    },
{
      name: "apps_kv_value_get",
      description: "Read one app-owned KV value through Workspace MCP.",
      inputSchema: {
        type: "object",
        required: ["appId", "key"],
        properties: {
          appId: { type: "string" },
          key: { type: "string" }
        }
      }
    },
{
      name: "apps_kv_value_put",
      description: "Create or update one app-owned KV value. Do not use for platform secrets.",
      inputSchema: {
        type: "object",
        required: ["appId", "key", "value"],
        properties: {
          appId: { type: "string" },
          key: { type: "string" },
          value: { type: "string" },
          metadata: { type: "object" }
        }
      }
    },
{
      name: "apps_kv_value_delete",
      description: "Delete one app-owned KV value.",
      inputSchema: {
        type: "object",
        required: ["appId", "key"],
        properties: {
          appId: { type: "string" },
          key: { type: "string" }
        }
      }
    },
{
      name: "apps_r2_objects_list",
      description: "List app-owned R2 objects for a APPS app that has an R2 bucket resource.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: {
          appId: { type: "string" },
          prefix: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 100 }
        }
      }
    },
{
      name: "apps_r2_object_get",
      description: "Read one app-owned R2 object. Binary objects are returned as base64 content.",
      inputSchema: {
        type: "object",
        required: ["appId", "key"],
        properties: {
          appId: { type: "string" },
          key: { type: "string" }
        }
      }
    },
{
      name: "apps_r2_object_put",
      description: "Create or update one app-owned R2 object with text or base64 content.",
      inputSchema: {
        type: "object",
        required: ["appId", "key", "content"],
        properties: {
          appId: { type: "string" },
          key: { type: "string" },
          content: { type: "string" },
          contentType: { type: "string" },
          encoding: { type: "string", enum: ["text", "base64"] }
        }
      }
    },
{
      name: "apps_r2_object_delete",
      description: "Delete one app-owned R2 object.",
      inputSchema: {
        type: "object",
        required: ["appId", "key"],
        properties: {
          appId: { type: "string" },
          key: { type: "string" }
        }
      }
    },
{
      name: "apps_secrets_declare",
      description: "Declare custom secret names required by a APPS app. This does not set secret values. Do not declare WORKSPACE_AUTH_APP_SECRET or WORKSPACE_APP_SESSION_SECRET; APPS manages them automatically.",
      inputSchema: {
        type: "object",
        required: ["appId", "secrets"],
        properties: {
          appId: { type: "string" },
          secrets: {
            type: "array",
            items: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                environment: { type: "string", enum: ["production"] },
                description: { type: "string" },
                required: { type: "boolean" }
              }
            }
          }
        }
      }
    },
{
      name: "apps_secrets_status",
      description: "Read custom secret status plus platform-managed Auth secret lifecycle for a APPS app. Secret values are never returned.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: {
          appId: { type: "string" }
        }
      }
    }
];
