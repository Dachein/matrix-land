export function mcpTools() {
  return [
    {
      name: "apps_list_inventory",
      description: "List every APPS App and Skill the current Workspace principal can manage as an owner or collaborator.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "apps_list_apps",
      description: "List APPS Apps the current Workspace principal can manage as an owner or collaborator.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "apps_get_app",
      description: "Read the canonical APPS App developer context: raw App state, resources, bindings, Auth configuration, managed-secret lifecycle, development guidance, readiness gates, deployment summary, blockers, and next actions. Call this before editing or deploying; call apps_get_auth_sdk only when its nextActions require Auth implementation material.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: {
          appId: { type: "string" }
        }
      }
    },
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
      name: "apps_create_app",
      description: "Create a APPS app, start resource provisioning, and email the authenticated creator a creation notice with office domain allowlist application instructions.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          emailEnabled: { type: "boolean", description: "Enable or disable one app mailbox with both sending and receiving." },
          emailPrefix: { type: "string", maxLength: 64, description: "Mailbox local part at mail.example.invalid; defaults to the app code." },
          emailTriggerEnabled: { type: "boolean", description: "Deliver signed new-inbound-mail events to the published app callback." },
          code: { type: "string" },
          description: { type: "string" },
          type: { type: "string", enum: ["static_page", "web", "agent_app", "automation", "container"] },
          accessMode: { type: "string", enum: ["public", "company", "targeted", "private"] },
          accessTargets: { type: "array", items: { type: "string" } },
          directoryReadScope: { type: "string", enum: ["app", "company"] },
          agentMcpEnabled: { type: "boolean" },
          resourceTypes: { type: "array", items: { type: "string" } },
          visibility: { type: "string", enum: ["private", "team", "org", "public"] },
          loginRequired: { type: "boolean" },
          llmEnabled: { type: "boolean" }
        }
      }
    },
    {
      name: "apps_list_mates",
      description: "List Mate identities owned by the current Workspace user. A Mate is a stable identity backed by immutable workspace.agentruntime/v1 releases, not a dedicated Worker deployment.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "apps_mate_create",
      description: "Create a Mate identity and its initial Draft. This does not deploy a Worker. Review and validate the definition, then deploy Preview before publishing an exact Release.",
      inputSchema: {
        type: "object",
        required: ["displayName", "jobRole", "workEmail"],
        properties: {
          displayName: { type: "string", maxLength: 120 },
          avatarUrl: { type: "string", maxLength: 1200000, pattern: "^(?:https?://|data:image/(?:png|jpe?g|webp|gif);base64,)", description: "Mate avatar as an HTTPS URL or uploaded image data URL." },
          jobRole: { type: "string", maxLength: 200 },
          description: { type: "string", maxLength: 1000 },
          workEmail: { type: "string", format: "email" },
          visibility: { type: "string", enum: ["private", "targets", "organization"] },
          targetIds: { type: "array", items: { type: "string", pattern: "^(user|department):" } },
          creationProfile: { type: "string", enum: ["personal_mate"], description: "Use the same personal Mate Runtime defaults as Web quick setup and miniapp first-Mate creation; explicit fields may override these defaults." },
          workspacePassMcpEnabled: { type: "boolean", description: "Legacy alias for all App MCPs and all readable Knowledge Services; cloud Runtime excludes APPS management." },
          mcpCapacity: { type: "object", description: "AI Capacity and Forum & Hub selection; each group uses mode all, none, or selected with explicit children." },
          allAppMcp: { type: "boolean", description: "Include all App MCPs accessible to the invoking user, including future Apps." },
          allFolderEdit: { type: "boolean", description: "Include all writable Knowledge folders accessible to the invoking user, including future folders; writes require approval." },
          appMcpBindings: { type: "array", items: { type: "object", required: ["appId"], properties: { appId: { type: "string" }, manifestVersion: { type: "string" }, allowedToolNames: { type: "array", items: { type: "string" } } } } },
          allKnowledgeServices: { type: "boolean", description: "Dynamically include every Knowledge Service visible to the invoking user." },
          knowledgeServiceIds: { type: "array", items: { type: "string" } },
          folderEditIds: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 180 }, description: "Editable folder IDs. Grants content editing only within these folders using the invoking user's current ACL." },
          builtInToolIds: { type: "array", items: { type: "string", enum: ["public_web_read", "public_web_search", "ocr", "document_read", "artifact_create", "workspace_knowledge_maintain", "workspace_forum_read", "workspace_forum_post", "todo_manage", "reminder_manage"] } },
          standaloneEnabled: { type: "boolean" },
          embeddedEnabled: { type: "boolean" },
          emailEnabled: { type: "boolean" },
          mateCallEnabled: { type: "boolean" },
          scheduleEnabled: { type: "boolean" },
          defaultTimezone: { type: "string", maxLength: 80 },
          scheduledJobs: {
            type: "array",
            maxItems: 32,
            items: {
              type: "object",
              required: ["id", "title", "instruction", "cadence"],
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                instruction: { type: "string" },
                cadence: { type: "object", required: ["kind", "at", "timezone"], properties: { kind: { const: "daily" }, at: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }, timezone: { type: "string" } } },
                delivery: { type: "object", required: ["channel", "recipient"], properties: { channel: { const: "email" }, recipient: { const: "owner" } } }
              }
            }
          }
        }
      }
    },
    {
      name: "apps_mate_get",
      description: "Read one Mate identity, current Draft Manifest, versioned Soul/Handbook/mail.md content, and active Release pointer.",
      inputSchema: { type: "object", required: ["mateId"], properties: { mateId: { type: "string" } } }
    },
    {
      name: "apps_mate_update",
      description: "Update mutable Mate identity metadata. mateId and Mate Code remain stable, and published releases remain immutable.",
      inputSchema: { type: "object", required: ["mateId"], properties: { mateId: { type: "string" }, avatarUrl: { type: "string", maxLength: 1200000, pattern: "^(?:$|https?://|data:image/(?:png|jpe?g|webp|gif);base64,)", description: "Replace the Mate avatar with an HTTPS URL or uploaded image data URL; pass an empty string to remove it." }, displayName: { type: "string" }, jobRole: { type: "string" }, description: { type: "string" }, visibility: { type: "string", enum: ["private", "targets", "organization"] }, targetIds: { type: "array", items: { type: "string", pattern: "^(user|department):" } } } }
    },
    {
      name: "apps_mate_core_review",
      description: "Review the current Draft Soul, Handbook and mail.md with their immutable reference digests, active Release pointer, revision lock, and required human-review rules.",
      inputSchema: { type: "object", required: ["mateId"], properties: { mateId: { type: "string" } } }
    },
    {
      name: "apps_mate_core_update",
      description: "Update Draft soul.md, handbook.md and/or mail.md content and recompute their SHA-256 references. Requires the current expectedRevision; changes do not affect Runtime until separately published.",
      inputSchema: { type: "object", required: ["mateId", "expectedRevision"], properties: { mateId: { type: "string" }, expectedRevision: { type: "integer", minimum: 1 }, inboxPrompt:{type:"string",maxLength:24000}, mail: { type: "string", maxLength: 24000 }, soul: { type: "string" }, handbook: { type: "string" } } }
    },
    {
      name: "apps_mate_definition_update",
      description: "Replace a Mate Draft Manifest and versioned documents using optimistic revision control. workspace.agentruntime/v1 safety constraints are validated server-side.",
      inputSchema: { type: "object", required: ["mateId", "expectedRevision", "manifest", "documents"], properties: { mateId: { type: "string" }, expectedRevision: { type: "integer", minimum: 1 }, manifest: { type: "object" }, documents: { type: "array", items: { type: "object" } } } }
    },
    {
      name: "apps_mate_validate",
      description: "Validate the current Mate Draft, including workspace.agentruntime/v1 trust invariants and current publisher access to every selected App MCP registration.",
      inputSchema: { type: "object", required: ["mateId"], properties: { mateId: { type: "string" } } }
    },
    {
      name: "apps_mate_deploy_preview",
      description: "Deploy the current validated Draft as a new immutable candidate Release and return owner-only Preview test/embed links. This does not activate it for live users or deploy one Worker per Mate.",
      inputSchema: { type: "object", required: ["mateId", "confirm"], properties: { mateId: { type: "string" }, confirm: { const: true } } }
    },
    {
      name: "apps_mate_publish",
      description: "Publish one exact deployed candidate Release to Production after explicit user confirmation. Draft changes made after deployment are not included.",
      inputSchema: { type: "object", required: ["mateId", "releaseId", "confirm"], properties: { mateId: { type: "string" }, releaseId: { type: "string" }, confirm: { const: true } } }
    },
    {
      name: "apps_mate_releases_list",
      description: "List immutable candidate, published, retired, and revoked releases for a Mate.",
      inputSchema: { type: "object", required: ["mateId"], properties: { mateId: { type: "string" } } }
    },
    {
      name: "apps_mate_release_activate",
      description: "Roll back by activating a previous non-revoked Mate Release after explicit user confirmation.",
      inputSchema: { type: "object", required: ["mateId", "releaseId", "confirm"], properties: { mateId: { type: "string" }, releaseId: { type: "string" }, confirm: { const: true } } }
    },
    {
      name: "apps_list_llm_models",
      description: "List LLM models and gateway endpoints available for APPS apps.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "apps_list_skills",
      description: "List APPS Skills the current Workspace principal may read or install; use apps_list_inventory for the owner/collaborator-managed set.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "apps_get_skill",
      description: "Read one private APPS skill with its immutable versions.",
      inputSchema: {
        type: "object",
        required: ["skillId"],
        properties: {
          skillId: { type: "string" }
        }
      }
    },
    {
      name: "apps_skill_validate",
      description: "Validate a Skill package before private publishing. Checks SKILL.md frontmatter, file paths, and manifest shape.",
      inputSchema: {
        type: "object",
        required: ["skillMarkdown"],
        properties: {
          skillMarkdown: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" }
              }
            }
          },
          manifest: { type: "object" }
        }
      }
    },
    {
      name: "apps_skill_submit",
      description: "Publish a private Skill artifact to APPS. The Skill remains within its configured APPS access scope until its authors submit it to the community in the web portal.",
      inputSchema: {
        type: "object",
        required: ["skillMarkdown"],
        properties: {
          name: { type: "string" },
          slug: { type: "string" },
          description: { type: "string" },
          version: { type: "string" },
          kind: { type: "string", enum: ["vanilla", "app"] },
          capabilities: { type: "array", items: { type: "string" } },
          changelog: { type: "string" },
          skillMarkdown: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" }
              }
            }
          },
          manifest: { type: "object" }
        }
      }
    },
    {
      name: "apps_skill_update",
      description: "Create a new immutable private version for an existing APPS Skill.",
      inputSchema: {
        type: "object",
        required: ["skillId", "skillMarkdown"],
        properties: {
          skillId: { type: "string" },
          version: { type: "string" },
          changelog: { type: "string" },
          skillMarkdown: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" }
              }
            }
          },
          manifest: { type: "object" }
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
      description: "Get the official, versioned Workspace App Session and organization-directory SDK package, App-specific login/people/department-permission examples, multi-level organization call and rendering guidance, runtime configuration, platform-managed secret lifecycle, migration checklist, and bundling guidance. Use this only after apps_get_app identifies Auth implementation as a next action.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: {
          appId: { type: "string" }
        }
      }
    },
    {
      name: "apps_pages_deploy",
      description: "Create a ready deployment in the app's dedicated Cloudflare Pages project. Prefer deployArtifactId from Workspace CLI for local build output; legacy inline files remain compatible. Before any Cloudflare write, login-required apps must pass the Auth source preflight; blockers are returned at structuredContent.error.details.security.auth. APPS syncs app-scoped bindings, env vars, and configured secrets before recording the deployment. Publication remains separate.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        anyOf: [{ required: ["deployArtifactId"] }, { required: ["files"] }],
        properties: {
          accessTargets: { type: "array", items: { type: "string", pattern: "^(user|department):" }, description: "Selected members when visibility is team." },
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
          loginRequired: { type: "boolean", description: "Target sign-in policy for this deployment. When true and the current App is public, the access scope defaults to collaborators and Owner only." },
          visibility: { type: "string", enum: ["private", "team", "org", "public"] },
          entrypoint: { type: "string", default: "index.html" },
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
      description: "Create a ready deployment in the app's dedicated Cloudflare Worker. Prefer deployArtifactId from Workspace CLI for local build output; legacy inline files remain compatible. Before any Cloudflare write, login-required apps must pass the Auth source preflight; blockers are returned at structuredContent.error.details.security.auth. APPS syncs app-scoped bindings, env vars, and configured secrets. Publication remains separate.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        anyOf: [{ required: ["deployArtifactId"] }, { required: ["files"] }],
        properties: {
          accessTargets: { type: "array", items: { type: "string", pattern: "^(user|department):" }, description: "Selected members when visibility is team." },
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
          loginRequired: { type: "boolean", description: "Target sign-in policy for this deployment. When true and the current App is public, the access scope defaults to collaborators and Owner only." },
          visibility: { type: "string", enum: ["private", "team", "org", "public"] },
          cronSchedules: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            description: "Cron expressions to synchronize after the Worker upload. Requires the App cron_trigger resource. Like Wrangler, the supplied list replaces this Worker's schedules.",
            items: { type: "string", maxLength: 100 }
          },
          queueConsumer: {
            type: "object",
            additionalProperties: false,
            description: "Optional push-consumer configuration for an App-owned Queue binding. Repeated deployments update the existing Worker consumer instead of creating duplicates.",
            properties: {
              bindingName: { type: "string", default: "QUEUE", maxLength: 64 },
              maxBatchSize: { type: "integer", default: 10, minimum: 1, maximum: 100 },
              maxBatchTimeout: { type: "integer", default: 5, minimum: 0, maximum: 60 },
              maxRetries: { type: "integer", default: 3, minimum: 0, maximum: 100 },
              maxConcurrency: { type: "integer", minimum: 1, maximum: 250 },
              retryDelay: { type: "integer", minimum: 0, maximum: 43200 }
            }
          },
          entrypoint: { type: "string", default: "index.js" },
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
      description: "Promote a ready deployment to production after explicit user approval. The fixed Workspace Release Readiness Report URL and self-check are optional while the platform gate is disabled, and become mandatory when WORKSPACE_RELEASE_READINESS_REPORT_REQUIRED is enabled.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: {
          accessTargets: { type: "array", items: { type: "string" } },
          appId: { type: "string" },
          deploymentId: { type: "string", description: "Ready deployment id. If omitted, the latest ready deployment is published." },
          harnessReportUrl: { type: "string", description: "Fixed HTTPS report URL on the App production domain ending in /harness/report.html." },
          harnessSelfCheckConfirmed: { type: "boolean", description: "Set true after reviewing every finding. Optional unless the platform release-readiness gate is enabled." },
          visibility: { type: "string", enum: ["private", "team", "org", "public"] },
          loginRequired: { type: "boolean" }
        }
      }
    },
    {
      name: "apps_deployments_rollback",
      description: "Promote a previous deployment back to production. Requires explicit user approval before use.",
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
      description: "Apply one token-validated app-owned D1 migration as an atomic batch. Tables, indexes, references, and controlled data targets must use the authoritative App prefix. INSERT ... VALUES [ON CONFLICT], UPDATE ... WHERE, and DELETE ... WHERE require explicit user approval and allowDataMigrations=true; cross-table queries remain forbidden.",
      inputSchema: {
        type: "object",
        required: ["appId", "version", "sql"],
        properties: {
          allowDataMigrations: { type: "boolean", description: "Must be true only after separate explicit user approval for controlled data mutations." },
          appId: { type: "string" },
          contentSha256: { type: "string", description: "Optional SHA-256 of the local migration file." },
          fileName: { type: "string", description: "Optional local migration filename for provenance." },
          version: { type: "string" },
          tablePrefix: { type: "string", description: "Optional client assertion of the App-owned table prefix. If provided, it must exactly match the prefix derived by the service." },
          sql: { type: "string" }
        }
      }
    },
    {
      name: "apps_d1_migrations_list",
      description: "List applied app-owned D1 migrations for one APPS app.",
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
      description: "List non-secret environment variables configured for a APPS app. Secret values are never returned here.",
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
      description: "Set non-secret environment variables for a APPS app. Do not use this for tokens, API keys, passwords, or secrets.",
      inputSchema: {
        type: "object",
        required: ["appId", "vars"],
        properties: {
          appId: { type: "string" },
          target: { type: "string", enum: ["runtime", "pages", "worker"] },
          vars: {
            type: "object",
            additionalProperties: { type: "string" }
          }
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
      description: "Read one app-owned KV value. Use only for app data/config, never for platform secrets.",
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
      description: "Create or update one app-owned KV value. Use only for app data/config, never for platform secrets.",
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
      description: "Read one app-owned R2 object. Text objects return text content; binary objects return base64 content.",
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
      description: "Create or update one app-owned R2 object. Supports text or base64 content.",
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
    },
    {
      name: "apps_get_provisioning_status",
      description: "Read provisioning progress by jobId, or the latest job for appId.",
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
      description: "Retry a queued or failed provisioning job.",
      inputSchema: {
        type: "object",
        required: ["jobId"],
        properties: {
          jobId: { type: "string" }
        }
      }
    }
  ];
}
