import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { WorkspaceMiniChat } from "./chat.ts";

const BASE_NOW = Date.parse("2026-09-17T10:00:00.000Z");
const EXPIRES_SOON = "2026-09-17T10:05:00.000Z";
const EXPIRES_AFTER_SOON = "2026-09-17T10:10:00.000Z";

function createClock(start) {
  const tasks = [];
  let current = start;
  return {
    now: () => current,
    setTimeout: (run, delayMs) => { const task = { at: current + delayMs, run }; tasks.push(task); return task; },
    clearTimeout: (handle) => { const index = tasks.indexOf(handle); if (index >= 0) tasks.splice(index, 1); },
    get pending() { return tasks.length; },
    pendingDelays: () => tasks.map((task) => task.at - current),
    /** Runs every timer due within `ms` and advances the clock, in chronological order. */
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = tasks.filter((task) => task.at <= target).sort((left, right) => left.at - right.at)[0];
        if (!due) break;
        tasks.splice(tasks.indexOf(due), 1);
        current = Math.max(current, due.at);
        due.run();
      }
      current = target;
    }
  };
}

async function flush(times = 6) {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function createSocket(url, { failOnSend = false } = {}) {
  let onOpen;
  let onMessage;
  let onClose;
  let onError;
  const socket = {
    closed: false,
    frames: [],
    url,
    close() { socket.closed = true; },
    lastFrame() { return socket.frames[socket.frames.length - 1]; },
    onClose(handler) { onClose = handler; },
    onError(handler) { onError = handler; },
    onMessage(handler) { onMessage = handler; },
    onOpen(handler) { onOpen = handler; },
    open() { onOpen?.(); },
    receive(frame) { onMessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) }); },
    drop() { onClose?.(); },
    fail() { onError?.(); },
    send(options) {
      // Mirrors WeChat: sending on a closed socket fails rather than throwing on the caller.
      if (failOnSend || socket.closed) throw new Error("socket is closed");
      socket.frames.push(JSON.parse(options.data));
    }
  };
  return socket;
}

function createHarness(overrides = {}, options = {}) {
  const clock = createClock(BASE_NOW);
  const sockets = [];
  const snapshots = [];
  let grants = 0;
  const session = {
    accessToken: "token-1",
    conversationId: "conversation-1",
    conversationState: "persisted",
    expiresAt: EXPIRES_AFTER_SOON,
    principalKey: "principal-1",
    mate: { id: "mate-1", displayName: "Cortana", jobRole: "助手", description: "" },
    ...overrides
  };

  const dependencies = {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    createSocket: ({ url }) => { const socket = createSocket(url, { failOnSend: options.failOnSend }); sockets.push(socket); return socket; },
    socketUrl: (active, action, grant) => `wss://example.test/v1/${active.mate.id}/${active.conversationId}/${action}?grant=${grant}`,
    obtainGrant: async (active) => {
      grants += 1;
      if (options.obtainGrant) return options.obtainGrant(active);
      return { grant: `grant-${grants}`, expiresAt: EXPIRES_AFTER_SOON };
    },
    loadHistory: async () => options.loadHistory ? options.loadHistory() : options.history ?? [],
    openConversation: async (active) => { active.conversationState = "persisted"; return active; }
  };

  const chat = new WorkspaceMiniChat(
    session,
    options.history ?? [],
    (snapshot) => snapshots.push(snapshot),
    () => ({ appIds: [], knowledgeServiceIds: [] }),
    undefined,
    options.renew,
    dependencies
  );

  const lastSnapshot = () => snapshots[snapshots.length - 1];

  return {
    chat,
    clock,
    sockets,
    session,
    snapshots,
    lastSnapshot,
    live: () => sockets[sockets.length - 1],
    grantCount: () => grants,
    /** Connects and opens the socket, leaving the instance in the `connected` state. */
    async connect() {
      const pending = chat.connect();
      await flush();
      // A grant/session recovery can push socket creation past the first tick.
      for (let attempt = 0; attempt < 12 && !sockets.length; attempt += 1) await flush(4);
      if (!sockets.length) throw new Error("no socket was created");
      sockets[sockets.length - 1].open();
      await pending;
      return sockets[sockets.length - 1];
    }
  };
}

const opened = [];
afterEach(() => { while (opened.length) opened.pop()?.chat.close(); });

describe("miniapp chat socket lifecycle", () => {
  it("submits only the new user message with server-owned history", async () => {
    const history = Array.from({ length: 120 }, (_, index) => ({ id: `old-${index}`, role: index % 2 ? "assistant" : "user", parts: [{ type: "text", text: "old" }] }));
    const h = createHarness({}, { history }); opened.push(h);
    const socket = await h.connect(); h.chat.send("new question"); await flush(12);
    const body = JSON.parse(socket.lastFrame().init.body);
    assert.equal(body.transcriptMode, "server");
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].parts[0].text, "new question");
  });
  it("continues a saved paused checkpoint using its assistant message ID", async () => {
    const source = { id: "assistant-checkpoint", role: "assistant", parts: [{ type: "data-mate-turn", data: { execution: { state: "paused" } } }] };
    const h = createHarness({}, { history: [source] }); opened.push(h);
    const socket = await h.connect(); assert.equal(h.lastSnapshot().canContinue, true);
    h.chat.continue("继续执行"); h.chat.continue("继续执行"); await flush(12);
    const requests = socket.frames.filter((frame) => frame.type === "cf_agent_use_chat_request");
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0].init.body).continuationMessageId, source.id);
  });
  it("detaches on page close without cancelling server execution", async () => {
    const h = createHarness(); opened.push(h); const socket = await h.connect();
    h.chat.send("long task"); await flush(12); h.chat.close();
    assert.equal(socket.frames.some((frame) => frame.type === "cf_agent_chat_request_cancel"), false);
  });
  it("does not repeat a delivered operation when the user retries an uncertain response", async () => {
    const h = createHarness(); opened.push(h); const socket = await h.connect();
    h.chat.send("write once"); await flush(12);
    socket.receive({ type: "cf_agent_use_chat_response", error: true, body: "connection lost" });
    h.chat.retry(); await flush(12);
    assert.equal(socket.frames.filter((frame) => frame.type === "cf_agent_use_chat_request").length, 1);
  });
  it("a stop while obtaining the submission grant cannot send a late request", async () => {
    let resolveGrant;
    let obtains = 0;
    const h = createHarness({}, { obtainGrant: async () => ++obtains === 1 ? {grant:"initial",expiresAt:EXPIRES_AFTER_SOON} : new Promise((resolve) => { resolveGrant = resolve; }) });
    opened.push(h); const socket = await h.connect();
    h.clock.advance(600_000);
    h.chat.send("do not execute"); await flush(12); h.chat.stop();
    resolveGrant({grant:"late",expiresAt:"2099-01-01T00:00:00Z"}); await flush(12);
    assert.equal(socket.frames.some((frame) => frame.type === "cf_agent_use_chat_request"), false);
  });
  it("connects with a chat grant and probes for a resumable stream", async () => {
    const harness = createHarness();
    opened.push(harness);
    const socket = await harness.connect();

    assert.match(socket.url, /\/mate-1\/conversation-1\/chat\?grant=grant-1$/);
    assert.equal(harness.lastSnapshot().connection, "connected");
    assert.deepEqual(socket.lastFrame().type, "cf_agent_stream_resume_request");
  });

  it("does not open a socket for a draft conversation", async () => {
    const harness = createHarness({ conversationState: "draft" });
    opened.push(harness);
    await harness.chat.connect();
    assert.equal(harness.sockets.length, 0);
    assert.equal(harness.lastSnapshot(), undefined);
  });

  it("sends a submit frame carrying the current message list and selection", async () => {
    const harness = createHarness();
    opened.push(harness);
    const socket = await harness.connect();
    harness.chat.send("帮我准备客户会议要点");
    await flush(12);

    const frame = socket.lastFrame();
    assert.equal(frame.type, "cf_agent_use_chat_request");
    assert.equal(frame.init.body.includes("帮我准备客户会议要点"), true);
    assert.equal(frame.init.body.includes("submit-message"), true);
    assert.equal(frame.init.body.includes("wechat-miniapp"), true);
    assert.equal(harness.lastSnapshot().streaming, true);
  });

  it("reconciles from the server when the runtime reports no active stream", async () => {
    const history = [{ id: "server-1", role: "assistant", parts: [{ type: "text", text: "服务端历史" }] }];
    const harness = createHarness({}, { history });
    opened.push(harness);
    await harness.connect();
    harness.chat.send("触发一次请求");
    await flush(12);
    // This idle result must answer a recovery probe issued after that request.
    await harness.chat.recover();
    harness.live().receive({ type: "cf_agent_stream_resume_none", reason: "idle" });
    await flush(12);

    assert.equal(harness.lastSnapshot().streaming, false);
    assert.deepEqual(harness.lastSnapshot().messages, history);
  });

  it("acknowledges a resumed stream instead of replaying it as a new turn", async () => {
    const harness = createHarness();
    opened.push(harness);
    const socket = await harness.connect();
    socket.receive({ type: "cf_agent_stream_resuming", id: "request-9" });

    assert.deepEqual(socket.lastFrame(), { type: "cf_agent_stream_resume_ack", id: "request-9" });
    assert.equal(harness.lastSnapshot().streaming, true);
    assert.equal(harness.lastSnapshot().recovering, false);
  });

  it("applies a streamed response chunk to the assistant message", async () => {
    const harness = createHarness();
    opened.push(harness);
    const socket = await harness.connect();
    socket.receive({ type: "cf_agent_use_chat_response", id: "request-1", body: JSON.stringify({ type: "text-delta", id: "t1", delta: "你好" }), done: true });

    const messages = harness.lastSnapshot().messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].parts[0].text, "你好");
    assert.equal(harness.lastSnapshot().streaming, false);
  });

  it("merges a server message update onto the existing turn by tool call id", async () => {
    const initial = [{ id: "assistant-1", role: "assistant", parts: [{ type: "tool-crm_write", toolCallId: "call-1", state: "input-streaming" }] }];
    const harness = createHarness({}, { history: initial });
    opened.push(harness);
    const socket = await harness.connect();
    socket.receive({ type: "cf_agent_message_updated", message: { id: "assistant-server", role: "assistant", parts: [{ type: "tool-crm_write", toolCallId: "call-1", state: "output-available" }] } });

    const messages = harness.lastSnapshot().messages;
    assert.equal(messages.length, 1);
    // The local message id is preserved so React keys and scroll anchors stay stable.
    assert.equal(messages[0].id, "assistant-1");
    assert.equal(messages[0].parts[0].state, "output-available");
  });

  it("ignores a malformed frame without dropping the connection", async () => {
    const harness = createHarness();
    opened.push(harness);
    const socket = await harness.connect();
    socket.receive("not json at all");
    assert.equal(harness.lastSnapshot().connection, "connected");
  });
});

describe("miniapp chat reconnection", () => {
  it("renews an expired runtime token before reconnecting", async () => {
    const renewed = [];
    const harness = createHarness(
      { expiresAt: EXPIRES_SOON },
      {
        renew: async (current) => {
          const next = { ...current, accessToken: "token-2", expiresAt: EXPIRES_AFTER_SOON };
          renewed.push(next);
          return next;
        }
      }
    );
    opened.push(harness);
    const first = await harness.connect();
    harness.clock.advance(5 * 60_000);
    first.drop();

    assert.equal(harness.lastSnapshot().connection, "reconnecting");
    harness.clock.advance(600);
    await flush(24);
    harness.live().open();
    await flush();

    assert.equal(renewed.length, 1);
    assert.equal(harness.sockets.length, 2, "the revoked transport must be replaced");
    assert.match(harness.live().url, /grant-2$/);
  });

  it("keeps the session when the token is still valid and the socket merely dropped", async () => {
    const harness = createHarness({}, { renew: async (current) => current });
    opened.push(harness);
    const first = await harness.connect();
    first.drop();
    harness.clock.advance(600);
    await flush(24);
    harness.live().open();
    await flush();

    assert.equal(harness.sockets.length, 2);
    assert.equal(harness.grantCount(), 1, "a valid grant must be reused rather than re-fetched");
  });

  it("backs off without spinning when the renewal itself fails", async () => {
    const harness = createHarness(
      { expiresAt: EXPIRES_SOON },
      { renew: async () => { throw new Error("runtime_unavailable"); } }
    );
    opened.push(harness);
    const first = await harness.connect();
    harness.clock.advance(5 * 60_000);
    first.drop();
    harness.clock.advance(600);
    await flush(24);

    // Only the next backoff timer may remain; no tight retry loop and no new socket.
    assert.equal(harness.sockets.length, 1, "no socket may be opened while the renewal keeps failing");
    assert.deepEqual(harness.clock.pendingDelays(), [1200]);
  });

  it("escalates the backoff delay across consecutive failures", async () => {
    const harness = createHarness();
    opened.push(harness);
    await harness.connect();

    for (const delay of [600, 1200]) {
      harness.live().drop();
      assert.deepEqual(harness.clock.pendingDelays(), [delay]);
      harness.clock.advance(delay);
      await flush(12);
      harness.live().fail();
      await flush();
    }
    assert.deepEqual(harness.clock.pendingDelays(), [2400]);
  });

  it("renews the session before creating a socket when the grant exchange is rejected", async () => {
    let grantCalls = 0;
    const harness = createHarness(
      {},
      {
        renew: async (current) => ({ ...current, accessToken: "token-2", expiresAt: EXPIRES_AFTER_SOON }),
        // The first grant exchange is rejected as an expired runtime token. Recovering from it
        // must happen before the socket is created, so no transport is ever bound to a
        // revoked token.
        obtainGrant: async () => {
          grantCalls += 1;
          if (grantCalls === 1) throw Object.assign(new Error("runtime_token_invalid"), { code: "runtime_token_invalid" });
          return { grant: "grant-fresh", expiresAt: EXPIRES_AFTER_SOON };
        }
      }
    );
    opened.push(harness);

    const socket = await harness.connect();

    assert.equal(grantCalls, 2, "the rejected grant must be retried against the renewed session");
    assert.equal(harness.sockets.length, 1, "only the post-renewal transport may be opened");
    assert.match(socket.url, /grant-fresh$/);
    assert.equal(harness.lastSnapshot().connection, "connected");
  });

  it("abandons the hierarchy when the runtime session cannot be renewed", async () => {
    const harness = createHarness(
      {},
      {
        renew: async () => { throw new Error("runtime_session_renewal_failed"); },
        obtainGrant: async () => { throw Object.assign(new Error("runtime_token_invalid"), { code: "runtime_token_invalid" }); }
      }
    );
    opened.push(harness);

    await harness.chat.connect().catch(() => undefined);

    assert.equal(harness.sockets.length, 0, "no transport may be opened without a valid session");
  });

  it("stops reconnecting after close()", async () => {
    const harness = createHarness();
    opened.push(harness);
    const socket = await harness.connect();
    harness.chat.close();
    socket.drop();

    assert.equal(harness.lastSnapshot().connection, "offline");
    assert.deepEqual(harness.clock.pendingDelays(), []);
    assert.equal(harness.sockets.length, 1);
  });
});

describe("miniapp chat tool approval and stop", () => {
  it("unsticks the UI when an approval is never acknowledged", async () => {
    const harness = createHarness();
    opened.push(harness);
    const socket = await harness.connect();
    harness.chat.respondToolApproval("call-1", true);
    await flush();

    assert.deepEqual(socket.frames.find((frame) => frame.type === "cf_agent_tool_approval"), { type: "cf_agent_tool_approval", toolCallId: "call-1", approved: true, autoContinue: true });
    assert.equal(harness.lastSnapshot().streaming, true);
    assert.equal(harness.lastSnapshot().recovering, true);

    harness.clock.advance(20_000);
    assert.equal(harness.lastSnapshot().streaming, false);
    assert.equal(harness.lastSnapshot().recovering, false);
    assert.equal(harness.lastSnapshot().error, "审批结果未确认，请重试");
  });

  it("clears the approval timeout once the runtime confirms", async () => {
    const harness = createHarness();
    opened.push(harness);
    const socket = await harness.connect();
    harness.chat.respondToolApproval("call-1", false);
    await flush();
    socket.receive({ type: "cf_agent_chat_recovering", recovering: true });

    harness.clock.advance(20_000);
    assert.equal(harness.lastSnapshot().error, undefined);
    assert.equal(harness.lastSnapshot().recovering, true);
  });

  it("refuses an approval when the socket is gone instead of pretending it was sent", async () => {
    // `failOnSend` models a transport that reports itself open but can no longer write, which
    // is what happens when the connection drops between the tap and the frame.
    const harness = createHarness({}, { failOnSend: true });
    opened.push(harness);
    await harness.connect();
    harness.chat.respondToolApproval("call-1", true);
    await flush(24);

    assert.equal(harness.lastSnapshot().streaming, false);
    assert.equal(harness.lastSnapshot().error, "连接已断开，无法提交审批，请重试");
  });

  it("cancels the active request when generation is stopped", async () => {
    const harness = createHarness();
    opened.push(harness);
    const socket = await harness.connect();
    harness.chat.send("一个很长的任务");
    await flush(12);
    const requestId = socket.lastFrame().id;
    harness.chat.stop();

    assert.deepEqual(socket.lastFrame(), { type: "cf_agent_chat_request_cancel", id: requestId });
    assert.equal(harness.lastSnapshot().streaming, false);
  });

  it("retries the last submission without duplicating the user message", async () => {
    const harness = createHarness({}, { history: [{ id: "assistant-old", role: "assistant", parts: [{ type: "text", text: "上一轮" }] }] });
    opened.push(harness);
    await harness.connect();
    harness.chat.send("重试这条");
    await flush(12);
    harness.chat.retry();
    await flush(12);

    const users = harness.lastSnapshot().messages.filter((message) => message.role === "user");
    assert.equal(users.length, 1);
    assert.equal(users[0].parts[0].text, "重试这条");
  });
});

describe('PDFs included in the conversation',()=>{
  it('sends the uploaded PDF reference and MIME in the same user message, never the local file path',async()=>{
    const harness=createHarness();opened.push(harness);const socket=await harness.connect();
    const file={objectId:'art_01234567-89ab-cdef-0123-456789abcdef',fileName:'季度报告.pdf',mediaType:'application/pdf',sizeBytes:2048,rawUrl:'/api/workspace-files/art_01234567-89ab-cdef-0123-456789abcdef/raw',localPath:'/private/phone/report.pdf'};
    harness.chat.send('请阅读这个 PDF',[file]);await flush(12);
    const request=socket.frames.find(f=>f.type==='cf_agent_use_chat_request');const body=JSON.parse(request.init.body);
    assert.equal(body.transcriptMode,'server');assert.equal(body.messages.length,1);
    assert.deepEqual(body.messages[0].parts,[{type:'text',text:'请阅读这个 PDF'},{type:'file',filename:file.fileName,mediaType:'application/pdf',url:file.rawUrl}]);
    assert.equal(JSON.stringify(body).includes('/private/phone'),false);
    assert.equal(harness.lastSnapshot().messages.at(-1).parts[1].url,file.rawUrl);
    assert.equal(harness.lastSnapshot().messages.at(-1).parts[1].sizeBytes,2048);
  });
});

describe('new attachments cannot be cleared by older resume results',()=>{
  it('ignores an idle probe issued before the new user message was delivered',async()=>{
    const harness=createHarness();opened.push(harness);const socket=await harness.connect();
    const probe=socket.frames.find(f=>f.type==='cf_agent_stream_resume_request');
    harness.chat.send('请摘要下');await flush(12);
    socket.receive({type:'cf_agent_stream_resume_none',reason:'idle',probeId:probe.probeId});
    assert.equal(harness.lastSnapshot().streaming,true);
    assert.equal(harness.lastSnapshot().messages.at(-1).parts[0].text,'请摘要下');
  });
});

describe('history and newly uploaded file race',()=>{
  it('keeps a new PDF message when an older history read resolves later',async()=>{
    let finishHistory;
    const harness=createHarness({}, {loadHistory:()=>new Promise(resolve=>{finishHistory=resolve;})});
    opened.push(harness);const socket=await harness.connect();
    socket.receive({type:'cf_agent_stream_resume_none',reason:'idle'});await flush();
    harness.chat.send('读取新文件',[{objectId:'pdf',fileName:'报告.pdf',mediaType:'application/pdf',sizeBytes:20,rawUrl:'/api/workspace-files/pdf/raw'}]);await flush(12);
    finishHistory([]);await flush(12);
    assert.equal(harness.lastSnapshot().messages.at(-1).parts[1].filename,'报告.pdf');
    assert.equal(harness.lastSnapshot().streaming,true);
  });
});
