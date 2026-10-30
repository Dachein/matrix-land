import type { BrowserContext, Page, WebSocketRoute } from "@playwright/test";
import { mockPortalApis } from "./portalApi";

const RUNTIME_ORIGIN = "https://runtime.preview.test";
const MATE_ID = "mate-preview-e2e";
const RELEASE_ID = "release-preview-e2e";
const CONVERSATION_ID = "conv-preview-e2e-stable";
const SECOND_CONVERSATION_ID = "conv-preview-e2e-second";
const GRANT = "mock.preview.grant";

type Message = {
  id: string;
  parts: Array<Record<string, unknown>>;
  role: "assistant" | "user";
};

type ActiveTurn = {
  assistant: Message;
  chunks: Array<Record<string, unknown>>;
  id: string;
};

/**
 * A protocol-faithful, in-memory Agent peer for the deterministic Chromium
 * contract. It never writes raw WebSocket frames, grants, or Environment data
 * to Playwright artifacts. Recording is disabled; any ignored local failure
 * context contains synthetic fixture copy only.
 */
export async function installMatePreviewServer(
  page: Page,
  context: BrowserContext,
  options: {
    mode?: "live" | "preview";
    appMcpEnabled?: boolean;
    conversationCommitDelayMs?: number;
    directAnswer?: boolean;
    sessionDelayMs?: number;
    sessionExpiresAt?: string;
    rotateSessionToken?: boolean;
    taskModeEnabled?: boolean;
    mateAvatarUrl?: string | null;
  } = {}
) {
  await mockPortalApis(page);
  const mode = options.mode ?? "preview";
  const namespace = mode === "preview" ? "owner-test/" : "";
  const mateAvatarUrl = options.mateAvatarUrl === undefined
    ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    : options.mateAvatarUrl;
  const transcript: Message[] = [];
  const sockets: WebSocketRoute[] = [];
  let active: ActiveTurn | undefined;
  let pauseNext = false;
  let yieldNext = false;
  const continuationIds: string[] = [];
  let nextFailureCode: string | undefined;
  let failNextProvider = false;
  let turnNumber = 0;
  let previewGrantRequests = 0;
  let liveRequests = 0;
  let hydrationRequests = 0;
  let chatRequests = 0;
  let cancellationRequests = 0;
  let clearRequests = 0;
  let deletedConversations = 0;
  let conversationCommits = 0;
  let draftNumber = 0;
  let latestDraftConversationId = "";
  let nextHydrationDelayMs = 0;
  let nextSessionDelayMs = 0;
  const conversationTitles = new Map([
    [CONVERSATION_ID, "Preview portfolio review"],
    [SECOND_CONVERSATION_ID, "Second Preview conversation"]
  ]);
  const conversationUpdatedAt = new Map<string, string>();
  const archivedConversations = new Set<string>();
  const pinnedConversations = new Set<string>();
  let invalidChatRequests = 0;
  let previewSessionRequests = 0;
  let sessionExpiresAt = options.sessionExpiresAt ?? "2099-08-27T10:05:00.000Z";
  let nextSessionConversationId: string | undefined;
  const profileAuthorizationHeaders: string[] = [];
  let resumeAcknowledgements = 0;
  let resumeRequests = 0;
  let taskListRequests = 0;
  const semanticCoordinates: string[] = [];

  await page.route(`**/api/mate-runtime/${mode === "preview" ? "preview" : "live"}-sessions`, async (route) => {
    previewSessionRequests += 1;
    if (route.request().method() !== "POST") {
      await route.fulfill({ contentType: "application/json", json: { error: "method_not_allowed" }, status: 405 });
      return;
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.mateId !== MATE_ID || (mode === "preview" && body.releaseId !== RELEASE_ID)) {
      await route.fulfill({ contentType: "application/json", json: { error: "coordinate_mismatch" }, status: 409 });
      return;
    }
    if (body.conversationId !== undefined && !conversationTitles.has(String(body.conversationId))) {
      await route.fulfill({ contentType: "application/json", json: { error: "conversation_mismatch" }, status: 409 });
      return;
    }
    const draftRequested = body.newConversation === true || (!body.conversationId && conversationTitles.size === 0);
    if (draftRequested) {
      draftNumber += 1;
      latestDraftConversationId = `conv-preview-e2e-draft-${draftNumber}`;
    }
    const requestedConversationId = draftRequested
      ? latestDraftConversationId
      : typeof body.conversationId === "string" ? body.conversationId : CONVERSATION_ID;
    const sessionDelayMs = nextSessionDelayMs || options.sessionDelayMs || 0;
    if (sessionDelayMs) {
      const delay = sessionDelayMs;
      nextSessionDelayMs = 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (requestedConversationId === SECOND_CONVERSATION_ID) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await route.fulfill({
      contentType: "application/json",
      headers: {
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer"
      },
      json: {
        session: {
          accessToken: `eyJtb2NrIjp0cnVlfQ.eyJtb2NrIjp0cnVlfQ.mock-signature${options.rotateSessionToken ? `-${previewSessionRequests}` : ""}`,
          conversationId: nextSessionConversationId ?? requestedConversationId,
          conversationState: draftRequested ? "draft" : "persisted",
          expiresAt: sessionExpiresAt,
          mode,
          principalKey: "preview-e2e-principal-key",
          release: {
            id: RELEASE_ID,
            manifestSha256: `sha256:${"a".repeat(64)}`,
            version: 3
          },
          runtimeOrigin: RUNTIME_ORIGIN,
          surface: {
            channels: options.taskModeEnabled === false ? ["sdk"] : ["sdk", "mate_call", "email", "schedule"],
            defaultExecutor: "knowledge_qa",
            entries: [
              { channel: "sdk", kind: "conversation" },
              ...(options.taskModeEnabled === false ? [] : [
                { channel: "mate_call", kind: "task_inbox" },
                { channel: "email", kind: "task_inbox" },
                { channel: "schedule", kind: "task_inbox" }
              ])
            ],
            kind: "conversation"
          },
          mate: {
            ...(mateAvatarUrl ? { avatarUrl: mateAvatarUrl } : {}),
            description: "Synthetic Preview browser fixture",
            displayName: "Preview E2E Mate",
            id: MATE_ID,
            jobRole: "Acceptance fixture"
          },
          user: { name: "Preview Owner" }
        }
      },
      status: 201
    });
    nextSessionConversationId = undefined;
  });

  await page.route(`${RUNTIME_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const conversationChatMatch = url.pathname.match(
      new RegExp(`^/v1/${namespace}mates/${MATE_ID}/conversations/([^/]+)/chat`)
    );
    const routedConversationId = conversationChatMatch?.[1];
    const previewPath = routedConversationId
      ? `/v1/${namespace}mates/${MATE_ID}/conversations/${routedConversationId}/chat`
      : "";
    const conversationPath = `/v1/${namespace}mates/${MATE_ID}/conversations`;
    const taskPath = `/v1/${namespace}mates/${MATE_ID}/tasks`;
    const runtimePath = `/v1/${namespace}mates/${MATE_ID}/runtime`;
    if (url.pathname.startsWith("/v1/mates/")) liveRequests += 1;
    if (url.pathname === runtimePath) profileAuthorizationHeaders.push(request.headers().authorization || "");
    if (request.method() === "OPTIONS") {
      await route.fulfill({ headers: corsHeaders(page), status: 204 });
      return;
    }
    if (request.method() === "GET" && url.pathname === taskPath) {
      taskListRequests += 1;
      await route.fulfill({
        contentType: "application/json",
        headers: corsHeaders(page),
        json: {
          tasks: [{
            channel: "mate_call",
            createdAt: "2026-08-27T10:00:00.000Z",
            id: "task-preview-directory",
            instruction: "Review the candidate release",
            releaseId: RELEASE_ID,
            status: "completed",
            title: "Candidate release review"
          }]
        }
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === conversationPath) {
      await route.fulfill({
        contentType: "application/json",
        headers: corsHeaders(page),
        json: {
          nextCursor: null,
          conversations: [...conversationTitles].map(([id, title]) => ({
            channel: "sdk",
            id,
            ...(pinnedConversations.has(id) ? { pinnedAt: "2026-08-30T00:00:00.000Z" } : {}),
            status: archivedConversations.has(id) ? "archived" : "active",
            title,
            updatedAt: conversationUpdatedAt.get(id) ?? new Date(Date.now() - (id === CONVERSATION_ID ? 5 : 18) * 60_000).toISOString()
          })).filter((item) => !url.searchParams.has("status") || item.status === url.searchParams.get("status"))
        }
      });
      return;
    }
    if (request.method() === "POST" && url.pathname === conversationPath) {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.channel !== "sdk" || typeof body.conversationId !== "string" || typeof body.title !== "string") {
        await route.fulfill({ contentType: "application/json", json: { error: "conversation_invalid" }, status: 422 });
        return;
      }
      conversationCommits += 1;
      conversationTitles.set(body.conversationId, body.title);
      if (options.conversationCommitDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.conversationCommitDelayMs));
      }
      await route.fulfill({
        contentType: "application/json",
        headers: corsHeaders(page),
        json: { conversation: {
          channel: "sdk",
          id: body.conversationId,
          status: "active",
          title: body.title
        } },
        status: 201
      });
      return;
    }
    if (request.method() === "DELETE" && url.pathname === conversationPath) {
      clearRequests += 1;
      conversationTitles.clear();
      transcript.splice(0, transcript.length);
      await route.fulfill({
        contentType: "application/json",
        headers: corsHeaders(page),
        json: {
          cleared: {
            deletedConversations: 2,
            deletedSessions: 1,
            scheduledAgentInstances: 2
          }
        }
      });
      return;
    }
    const lifecycleMatch = url.pathname.match(new RegExp(`^${conversationPath}/([^/]+)$`));
    if (lifecycleMatch && request.method() === "PATCH") {
      const id = decodeURIComponent(lifecycleMatch[1]);
      const title = conversationTitles.get(id);
      if (!title) {
        await route.fulfill({ contentType: "application/json", json: { error: "conversation_not_found" }, status: 404 });
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      if (typeof body.title === "string") conversationTitles.set(id, body.title);
      conversationUpdatedAt.set(id, new Date().toISOString());
      if (body.pinned === true) pinnedConversations.add(id);
      if (body.pinned === false) pinnedConversations.delete(id);
      if (body.status === "archived") {
        archivedConversations.add(id);
        pinnedConversations.delete(id);
      }
      if (body.status === "active") archivedConversations.delete(id);
      await route.fulfill({
        contentType: "application/json",
        headers: corsHeaders(page),
        json: { conversation: {
          channel: "sdk",
          id,
          ...(pinnedConversations.has(id) ? { pinnedAt: "2026-08-30T00:00:00.000Z" } : {}),
          status: archivedConversations.has(id) ? "archived" : "active",
          title: conversationTitles.get(id)
        } }
      });
      return;
    }
    if (lifecycleMatch && request.method() === "DELETE") {
      const id = decodeURIComponent(lifecycleMatch[1]);
      if (!conversationTitles.delete(id)) {
        await route.fulfill({ contentType: "application/json", json: { error: "conversation_not_found" }, status: 404 });
        return;
      }
      archivedConversations.delete(id);
      pinnedConversations.delete(id);
      deletedConversations += 1;
      await route.fulfill({
        contentType: "application/json",
        headers: corsHeaders(page),
        json: { conversation: { deleted: true, id, scheduledAgentInstances: 1 } }
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === runtimePath) {
      await route.fulfill({
        contentType: "application/json",
        headers: corsHeaders(page),
        json: {
          capabilities: {
            appMcp: options.appMcpEnabled === false ? [] : [
              { allowedToolNames: ["portfolio.read"], authorization: "invoking_user", id: "portfolio", kind: "app_mcp", name: "Portfolio MCP" },
              { allowedToolNames: ["crm.read"], authorization: "invoking_user", id: "crm", kind: "app_mcp", name: "CRM MCP" }
            ],
            knowledge: [
              { allowedOperations: ["search"], authorization: "invoking_user", id: "how_to", kind: "knowledge_service", name: "Frontier Workspace How To" },
              { allowedOperations: ["search"], authorization: "invoking_user", id: "policy", kind: "knowledge_service", name: "Workspace Policy" }
            ],
            models: {
              allowed: [
                { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
                { id: "gpt-5.4", name: "GPT-5.4" }
              ],
              allowUserSelection: true,
              defaultModel: "deepseek-v4-flash"
            }
          }
        }
      });
      return;
    }
    if (previewPath && (url.pathname === `${previewPath}-grants` || url.pathname.endsWith("/chat-grants"))) {
      previewGrantRequests += 1;
      if (!request.headers().authorization) {
        await route.fulfill({ contentType: "application/json", json: { error: "runtime_token_required" }, status: 401 });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        headers: corsHeaders(page),
        json: {
          expiresAt: "2099-08-27T10:02:00.000Z",
          grant: GRANT,
          mode,
          releaseId: RELEASE_ID
        },
        status: 201
      });
      return;
    }
    if (previewPath && url.pathname === `${previewPath}/get-messages`) {
      hydrationRequests += 1;
      if (nextHydrationDelayMs) {
        const delay = nextHydrationDelayMs;
        nextHydrationDelayMs = 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      await route.fulfill({
        contentType: "application/json",
        headers: corsHeaders(page),
        json: routedConversationId === CONVERSATION_ID ? transcript : []
      });
      return;
    }
    await route.fulfill({ contentType: "application/json", json: { error: "unexpected_runtime_route" }, status: 404 });
  });

  await context.routeWebSocket((url) => (
    url.protocol === "wss:"
    && url.host === new URL(RUNTIME_ORIGIN).host
    && new RegExp(`^/v1/${namespace}mates/${MATE_ID}/conversations/[^/]+/chat$`).test(url.pathname)
  ), (socket) => {
    sockets.push(socket);
    socket.onMessage((raw) => {
      if (typeof raw !== "string") return;
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw) as Record<string, unknown>; }
      catch { return; }
      if (frame.type === "cf_agent_chat_request_cancel") {
        cancellationRequests += 1;
        if (active?.id === frame.id) active = undefined;
        return;
      }
      if (frame.type === "cf_agent_stream_resume_request") {
        resumeRequests += 1;
        if (active) {
          socket.send(JSON.stringify({
            id: active.id,
            probeId: typeof frame.probeId === "string" ? frame.probeId : undefined,
            type: "cf_agent_stream_resuming"
          }));
        } else {
          socket.send(JSON.stringify({
            probeId: typeof frame.probeId === "string" ? frame.probeId : undefined,
            reason: "idle",
            type: "cf_agent_stream_resume_none"
          }));
        }
        return;
      }
      if (frame.type === "cf_agent_stream_resume_ack" && active && frame.id === active.id) {
        resumeAcknowledgements += 1;
        finishTurn(socket, active, true);
        active = undefined;
        return;
      }
      if (frame.type !== "cf_agent_use_chat_request" || typeof frame.id !== "string") return;
      chatRequests += 1;
      const body = parseRequestBody(frame.init);
      const semanticCoordinate = findSemanticCoordinate(body);
      if (semanticCoordinate) semanticCoordinates.push(semanticCoordinate);
      if (typeof body.continuationMessageId === "string") continuationIds.push(body.continuationMessageId);
      const incoming = Array.isArray(body.messages) ? body.messages : [];
      let user: Message;
      try {
        user = normalizeUserMessage(incoming.at(-1));
      } catch {
        invalidChatRequests += 1;
        socket.send(JSON.stringify({
          body: "preview_mock_user_invalid",
          error: true,
          id: frame.id,
          type: "cf_agent_use_chat_response"
        }));
        return;
      }
      transcript.push(user);
      if (failNextProvider) {
        failNextProvider = false;
        const assistantId = `provider-rejected-${user.id}`;
        const data = { schemaVersion: "workspace.mate-process/v1", startedAt: "2026-10-19T05:06:51.061Z", turnId: `turn-${user.id}` };
        sendChunk(socket, frame.id, { type: "start", messageId: assistantId });
        sendChunk(socket, frame.id, { type: "data-mate-process", id: `${user.id}:process`, data: { ...data, status: "running" } });
        const failed = { type: "data-mate-process", id: `${user.id}:process`, data: {
          ...data, status: "failed", completedAt: "2026-10-19T05:06:59.280Z", durationMs: 8219
        } };
        sendChunk(socket, frame.id, failed);
        transcript.push({ id: assistantId, role: "assistant", parts: [failed] });
        socket.send(JSON.stringify({ body: "mate_conversation_model_stream_failed", error: true, id: frame.id, type: "cf_agent_use_chat_response" }));
        socket.send(JSON.stringify({ body: "", done: true, id: frame.id, type: "cf_agent_use_chat_response" }));
        return;
      }
      if (nextFailureCode) {
        const code = nextFailureCode;
        nextFailureCode = undefined;
        socket.send(JSON.stringify({
          body: code,
          error: true,
          id: frame.id,
          type: "cf_agent_use_chat_response"
        }));
        return;
      }
      turnNumber += 1;
      const next = createTurn(frame.id, user, turnNumber);
      if (options.directAnswer) {
        next.assistant.parts = next.assistant.parts.filter((part) =>
          (part.type === "text" && String(part.text).startsWith("Synthetic answer")) || String(part.type).startsWith("data-")
        );
        next.chunks = next.chunks.filter((chunk) =>
          !String(chunk.type).startsWith("reasoning-") && !String(chunk.type).startsWith("tool-") && chunk.id !== `progress-${next.assistant.id}`
        );
      }
      if (yieldNext) {
        yieldNext = false;
        const marker = { type: "data-mate-turn", data: { execution: { state: "paused", reason: "step_limit", steps: 100 }, outcome: "completed", releaseId: RELEASE_ID } };
        next.chunks = next.chunks.filter((chunk) => chunk.id !== `text-${next.assistant.id}` && chunk.type !== "data-mate-task");
        next.assistant.parts = next.assistant.parts.filter((part) => part.text !== `Synthetic answer ${turnNumber} for ${user.id}.` && part.type !== "data-mate-task");
        for (const part of [...next.chunks, ...next.assistant.parts]) {
          if (part.type === "data-mate-process" && (part.data as Record<string, unknown>).status === "completed") part.data = { ...(part.data as Record<string, unknown>), status: "paused" };
        }
        next.chunks.splice(next.chunks.length - 1, 0, marker);
        next.assistant.parts.push(marker);
      }
      if (pauseNext) {
        pauseNext = false;
        active = next;
        sendChunk(socket, next.id, next.chunks[0]);
        sendChunk(socket, next.id, next.chunks[1]);
        sendChunk(socket, next.id, next.chunks[2]);
        sendChunk(socket, next.id, next.chunks[3]);
      } else {
        finishTurn(socket, next, false);
      }
    });
  });

  function finishTurn(socket: WebSocketRoute, turn: ActiveTurn, replay: boolean) {
    for (const chunk of turn.chunks) sendChunk(socket, turn.id, chunk, replay);
    socket.send(JSON.stringify({
      body: "",
      done: true,
      id: turn.id,
      ...(replay ? { replay: true, replayComplete: true } : {}),
      type: "cf_agent_use_chat_response"
    }));
    if (!transcript.some((message) => message.id === turn.assistant.id)) transcript.push(turn.assistant);
  }

  return {
    conversationId: CONVERSATION_ID,
    conversationCommitCount: () => conversationCommits,
    clearRequestCount: () => clearRequests,
    deletedConversationCount: () => deletedConversations,
    secondConversationId: SECOND_CONVERSATION_ID,
    latestDraftConversationId: () => latestDraftConversationId,
    chatRequestCount: () => chatRequests,
    cancellationRequestCount: () => cancellationRequests,
    completeActiveInBackground() {
      if (!active) throw new Error("preview_mock_active_turn_missing");
      if (!transcript.some((message) => message.id === active!.assistant.id)) transcript.push(active.assistant);
      active = undefined;
    },
    hydrationRequestCount: () => hydrationRequests,
    invalidChatRequestCount: () => invalidChatRequests,
    liveRequestCount: () => liveRequests,
    setSessionExpiresAt(value: string) { sessionExpiresAt = value; },
    changeNextSessionConversation(id: string) { nextSessionConversationId = id; },
    profileAuthorizationHeaders: () => [...profileAuthorizationHeaders],
    failNextTurn(code = "preview_mock_turn_failed") { nextFailureCode = code; },
    failNextProviderTurn() { failNextProvider = true; },
    pauseNextTurn() { pauseNext = true; },
    yieldNextTurn() { yieldNext = true; },
    continuationMessageIds: () => [...continuationIds],
    delayNextHydration(ms = 1_000) { nextHydrationDelayMs = ms; },
    delayNextSession(ms = 1_000) { nextSessionDelayMs = ms; },
    previewGrantRequestCount: () => previewGrantRequests,
    previewSessionRequestCount: () => previewSessionRequests,
    semanticCoordinates: () => [...semanticCoordinates],
    taskListRequestCount: () => taskListRequests,
    releaseId: RELEASE_ID,
    resumeAcknowledgementCount: () => resumeAcknowledgements,
    resumeRequestCount: () => resumeRequests,
    runtimeOrigin: RUNTIME_ORIGIN,
    mateId: MATE_ID,
    transcriptIds: () => transcript.map((message) => message.id),
    connectionCount: () => sockets.length,
    async cutLatest() {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("preview_mock_socket_missing");
      await socket.close({ code: 1012, reason: "deterministic-reconnect" });
    }
  };
}

function createTurn(requestId: string, user: Message, number: number): ActiveTurn {
  const assistantId = `assistant-preview-${number}`;
  const taskId = `task-preview-${number}`;
  const textId = `text-${assistantId}`;
  const progressTextId = `progress-${assistantId}`;
  const reasoningOneId = `reasoning-${number}-1`;
  const reasoningTwoId = `reasoning-${number}-2`;
  const reasoningThreeId = `reasoning-${number}-3`;
  const searchToolCallId = `tool-search-${number}`;
  const readToolCallId = `tool-read-${number}`;
  const startedAt = "2026-08-29T00:00:00.000Z";
  const completedAt = "2026-08-29T00:00:05.400Z";
  const answer = `Synthetic answer ${number} for ${user.id}.`;
  const searchOutput = { topics: [
    { id: `topic-${number}-1`, title: `Runtime design ${number}` },
    { id: `topic-${number}-2`, title: `Agent architecture ${number}` }
  ] };
  const readOutput = { topic: { id: `topic-${number}-1`, title: `Runtime design ${number}` } };
  const marker = {
    assistantMessageId: assistantId,
    artifacts: [],
    outcome: "completed",
    releaseId: RELEASE_ID,
    responseDigest: `sha256:${String(number).padStart(64, "0")}`,
    schemaVersion: "workspace.mate-chat-terminal/v1",
    taskId,
    turnId: `turn-preview-${number}`
  };
  const citation = { sources: [] };
  const runningProcess = {
    schemaVersion: "workspace.mate-process/v1",
    startedAt,
    status: "running",
    turnId: `turn-preview-${number}`
  };
  const completedProcess = {
    ...runningProcess,
    completedAt,
    durationMs: 5_400,
    status: "completed"
  };
  return {
    assistant: {
      id: assistantId,
      parts: [
        { text: "确认当前用户可见范围。", type: "reasoning" },
        { text: "选择最相关的论坛检索词。", type: "reasoning" },
        { text: "先定位相关主题。", type: "text" },
        {
          output: searchOutput,
          state: "output-available",
          toolCallId: searchToolCallId,
          toolName: "forum_read",
          type: "dynamic-tool"
        },
        { text: "读取最相关主题并核对细节。", type: "reasoning" },
        {
          output: readOutput,
          state: "output-available",
          toolCallId: readToolCallId,
          toolName: "forum_read",
          type: "dynamic-tool"
        },
        { text: answer, type: "text" },
        { data: citation, id: taskId, type: "data-mate-citations" },
        { data: marker, id: taskId, type: "data-mate-task" },
        { data: completedProcess, id: `${taskId}:process`, type: "data-mate-process" }
      ],
      role: "assistant"
    },
    chunks: [
      { messageId: assistantId, type: "start" },
      { data: runningProcess, id: `${taskId}:process`, type: "data-mate-process" },
      { type: "start-step" },
      { id: reasoningOneId, type: "reasoning-start" },
      { delta: "确认当前用户可见范围。", id: reasoningOneId, type: "reasoning-delta" },
      { id: reasoningOneId, type: "reasoning-end" },
      { id: reasoningTwoId, type: "reasoning-start" },
      { delta: "选择最相关的论坛检索词。", id: reasoningTwoId, type: "reasoning-delta" },
      { id: reasoningTwoId, type: "reasoning-end" },
      { id: progressTextId, type: "text-start" },
      { delta: "先定位相关主题。", id: progressTextId, type: "text-delta" },
      { id: progressTextId, type: "text-end" },
      {
        dynamic: true,
        input: { action: "search_topics", query: "agent runtime" },
        toolCallId: searchToolCallId,
        toolName: "forum_read",
        type: "tool-input-available"
      },
      {
        dynamic: true,
        output: searchOutput,
        toolCallId: searchToolCallId,
        type: "tool-output-available"
      },
      { id: reasoningThreeId, type: "reasoning-start" },
      { delta: "读取最相关主题并核对细节。", id: reasoningThreeId, type: "reasoning-delta" },
      { id: reasoningThreeId, type: "reasoning-end" },
      {
        dynamic: true,
        input: { action: "get_topic", topicId: `topic-${number}-1` },
        toolCallId: readToolCallId,
        toolName: "forum_read",
        type: "tool-input-available"
      },
      {
        dynamic: true,
        output: readOutput,
        toolCallId: readToolCallId,
        type: "tool-output-available"
      },
      { id: textId, type: "text-start" },
      { delta: answer.slice(0, 12), id: textId, type: "text-delta" },
      { delta: answer.slice(12), id: textId, type: "text-delta" },
      { id: textId, type: "text-end" },
      { data: citation, id: taskId, type: "data-mate-citations" },
      { data: marker, id: taskId, type: "data-mate-task" },
      { data: completedProcess, id: `${taskId}:process`, type: "data-mate-process" },
      { type: "finish-step" },
      { finishReason: "stop", type: "finish" }
    ],
    id: requestId
  };
}

function sendChunk(socket: WebSocketRoute, id: string, chunk: Record<string, unknown> | undefined, replay = false) {
  if (!chunk) return;
  socket.send(JSON.stringify({
    body: JSON.stringify(chunk),
    done: false,
    id,
    ...(replay ? { replay: true } : {}),
    type: "cf_agent_use_chat_response"
  }));
}

function normalizeUserMessage(value: unknown): Message {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("preview_mock_user_invalid");
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string" || source.role !== "user" || !Array.isArray(source.parts)) {
    throw new Error("preview_mock_user_invalid");
  }
  return { id: source.id, parts: source.parts as Array<Record<string, unknown>>, role: "user" };
}

function parseRequestBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const body = (value as Record<string, unknown>).body;
  if (typeof body !== "string") return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function findSemanticCoordinate(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || !value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const coordinate = findSemanticCoordinate(item, depth + 1);
      if (coordinate) return coordinate;
    }
    return undefined;
  }
  const source = value as Record<string, unknown>;
  if (source.kind === "host.semantic" && typeof source.ref === "string") return source.ref;
  for (const child of Object.values(source)) {
    const coordinate = findSemanticCoordinate(child, depth + 1);
    if (coordinate) return coordinate;
  }
  return undefined;
}

function corsHeaders(page: Page) {
  return {
    "access-control-allow-headers": "Authorization,Content-Type",
    "access-control-allow-methods": "DELETE,GET,PATCH,POST,OPTIONS",
    "access-control-allow-origin": new URL(page.url() || "http://127.0.0.1:5191").origin,
    "cache-control": "private, no-store"
  };
}
