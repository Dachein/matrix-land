# `workspace.agentruntime/v1`

`workspace.agentruntime/v1` is the immutable release manifest for a cloud-hosted Workspace Mate. Mate is
the stable product and control-plane identity; there is no separate Agent Identity record. A release pins
Soul, Handbook, mail.md, Skill, App MCP, Knowledge Service, built-in Tool, channel, invocation, preference,
task, approval, and experience policies.

Tasks use the same tool-calling Agent as conversations. Knowledge, App MCP, Forum, private Todos
and reminders are composable tools. There is no executor selection or fixed business workflow.
Working goals and continuity belong in task instructions and private Todo notes.

`taskPolicy.defaultTimezone` and legacy `scheduledJobs` describe when to invoke the Agent and
where to deliver its result. Existing `defaultExecutor`, job `executor`, and `forumReview` fields
are accepted only when reading old Releases and do not control execution. New Drafts omit them.
Immutable historic Releases and existing user records are not rewritten.

`experiencePolicy` also declares which product forms are enabled: Conversation (`web`/`sdk`),
Task Inbox (`mate_call`/`email`/`schedule`), and the release-bound Owner Test Console. Owner tests must use
an isolated Preview runtime namespace and never write Live user history.

The manifest deliberately contains no Workspace object, user preference values, business data,
user access token, enterprise website credential, or snapshot/union of user permissions.
`requiresCurrentUserDelegation: true` is mandatory for every App MCP binding and
`requiresCurrentUserAuthorization: true` for every Knowledge Service binding. Runtime-owned
records are isolated by `mateId × userId`.

`workspacePassMcpScope.mode = "all_authorized_for_invoking_user"` is the dynamic alternative to
fixed App MCP bindings. Its domain tuple is exactly `["apps", "knowledge"]`: Runtime discovers the
current Workspace MCP catalog for each caller and every call reuses that caller's live identity and
resource ACL. The scope is mutually exclusive with fixed App, Knowledge, and folder bindings, carries no
publisher authority, and never stores the Apps, Knowledge Services, or folders visible at build
time. Reads may run directly; writes require exact-action, single-use approval and are revalidated
after approval.

Skill discovery is recommendation-only in v1. Auto-install and installation requests are fixed to
false. Enterprise website connections and authenticated browser sessions are Product P2 and are
not part of this first schema surface.

`memoryPolicy` is an additive V1 contract. New Drafts pin a non-destructive conversation
compaction policy and keep durable user memory behind structured Runtime APIs. Legacy Releases
without the field remain readable and default to no automatic conversation compaction. Memory
summaries never delete their source events, grant resource access, or mutate Soul/Handbook.

Semantic validation performed by the control plane in addition to JSON Schema:

- `mateId`, active/reserved Email addresses, and Release versions are unique in their scopes;
- App, Knowledge Service, Skill, and built-in Tool ids cannot repeat within one Release;
- every referenced resource/version exists, is publishable, and is bindable by the creator;
- publication requires at least one useful App, Knowledge, Skill, or built-in Tool capability;
- `defaultModel` is present in `allowedModels`, and every model/multimodal choice is permitted by
  platform policy;
- every eligibility requirement references a resource bound by the same Release;
- enabled Email and Mate Call channels have corresponding active/reserved addresses;
- enabled Schedule channels have at least one valid daily Job; Forum review requires the
  `forum_hub.forum_read` MCP capacity and email delivery requires the Email channel;
- `workspace_knowledge_maintain` remains separate from read-only Knowledge Service bindings; Runtime
  reads only Owner/Collaborator maintenance objects and requires single-use Approval for writes;
- Webhook stays disabled in v1;
- App, Knowledge, and dynamic Workspace MCP scopes cannot disable or replace current-user authorization;
- Handbook/Soul/mail.md/Skill digests and referenced immutable objects match before publication.

The three definition candidates are:

- `examples/knowledge-assistant.candidate.json` — Knowledge-only Mate;
- `examples/portfolio-banker-mate.candidate.json` — App + Knowledge + Skill Mate with
  write Approval policy;
- `examples/cortana-admin.candidate.json` — Inbox-first AI Adoption operations Mate with
  read-only Forum review, per-user Todo/Reminder storage, Email, Mate Call, and Schedule.

Validate with:

```bash
npm run test:mate-runtime
```

## Mail document

New drafts contain exactly one `kind: "mail"` document referenced by `release.mail`.
It uses the same immutable R2 revisions, SHA-256 checks and release bindings as Soul and Handbook.
An empty mail.md stores incoming mail without creating a Task or reply. The Portal and MCP
`mate_builder_write(action=core_update, mail=...)` edit that same document with `expectedRevision`.
A reviewed candidate must be published before the live Runtime uses it; rollback restores the
exact previous document. The mail policy controls classification and result delivery and is not
added to every conversation as a general system instruction.

Historical immutable releases may retain `channels.inbox.email.inboxPrompt`. Draft normalization
converts that text without rewriting historical releases. `taskAuthority=verified_sender` preserves
the older shared-Mate sender authorization model; ordinary owner inboxes use `owner`. Email text
cannot change policy or grant authorization.
