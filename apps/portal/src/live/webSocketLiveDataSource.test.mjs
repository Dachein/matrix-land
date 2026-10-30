import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadDataSource() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-live-websocket-"));
  const outfile = join(outdir, "dataSource.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./webSocketLiveDataSource.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

class FakeWebSocket {
  static instances = [];

  listeners = new Map();
  sent = [];

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  close(code, reason) {
    this.closed = { code, reason };
    this.emit("close", { code, reason });
  }

  emit(type, event = {}) {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  send(value) {
    this.sent.push(value);
  }
}

describe("Portal Live WebSocket datasource", () => {
  it("subscribes with a cursor and publishes validated server updates", async () => {
    const previousWebSocket = globalThis.WebSocket;
    const previousWindow = globalThis.window;
    globalThis.WebSocket = FakeWebSocket;
    const storage = new Map();
    globalThis.window = {
      clearTimeout,
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value))
      },
      setTimeout
    };
    FakeWebSocket.instances = [];

    try {
      const { createPortalWebSocketLiveDataSource } = await loadDataSource();
      const source = createPortalWebSocketLiveDataSource({
        initialSnapshot: {
          activities: [],
          connectionState: "offline",
          cursor: "cur-1",
          onlinePeople: []
        },
        url: "wss://live.example.test/socket",
        workspaceId: "workspace-1"
      });
      const snapshots = [];
      source.subscribe((snapshot) => snapshots.push(snapshot));
      source.start();

      const socket = FakeWebSocket.instances[0];
      assert.equal(socket.url, "wss://live.example.test/socket?workspaceId=workspace-1");
      socket.emit("open");

      const subscribeMessage = JSON.parse(socket.sent[0]);
      assert.equal(subscribeMessage.type, "subscribe");
      assert.equal(subscribeMessage.workspaceId, "workspace-1");
      assert.equal(subscribeMessage.cursor, "cur-1");

      socket.emit("message", {
        data: JSON.stringify({
          activity: {
            actorName: "Ada",
            createdAt: "2026-07-12T00:00:00.000Z",
            id: "evt-1",
            priority: true,
            summary: "Ada mentioned you"
          },
          cursor: "cur-2",
          sentAt: "2026-07-12T00:00:00.000Z",
          type: "activity.upsert",
          version: 1
        })
      });

      assert.equal(source.getSnapshot().activities[0].id, "evt-1");
      assert.equal(source.getSnapshot().cursor, "cur-2");
      assert.equal(source.getSnapshot().connectionState, "connected");
      assert.equal(storage.get("workspace.portalLive.cursor.v1:workspace-1"), "cur-2");
      assert.ok(snapshots.length >= 3);

      source.stop();
      assert.equal(source.getSnapshot().connectionState, "offline");
    } finally {
      globalThis.WebSocket = previousWebSocket;
      globalThis.window = previousWindow;
    }
  });

  it("adds the workspace id to the WebSocket endpoint", async () => {
    const { portalLiveWebSocketUrl } = await loadDataSource();

    assert.equal(
      portalLiveWebSocketUrl("wss://live.example.test/v1/live?client=v2", "workspace wealth"),
      "wss://live.example.test/v1/live?client=v2&workspaceId=workspace+wealth"
    );
  });

  it("uses the authenticated same-origin proxy in production", async () => {
    const { resolvePortalLiveWebSocketUrl } = await loadDataSource();

    assert.equal(
      resolvePortalLiveWebSocketUrl(undefined, { host: "ai.example.invalid", protocol: "https:" }),
      "wss://ai.example.invalid/live/v1/live"
    );
    assert.equal(
      resolvePortalLiveWebSocketUrl("wss://live.example.test/v1/live", { host: "localhost:5174", protocol: "http:" }),
      "wss://live.example.test/v1/live"
    );
    assert.equal(resolvePortalLiveWebSocketUrl(undefined, { host: "localhost:5174", protocol: "http:" }), undefined);
  });

  it("uses a stored cursor when the initial snapshot has no cursor", async () => {
    const previousWebSocket = globalThis.WebSocket;
    const previousWindow = globalThis.window;
    globalThis.WebSocket = FakeWebSocket;
    globalThis.window = {
      clearTimeout,
      localStorage: {
        getItem: (key) => key === "workspace.portalLive.cursor.v1:workspace-2" ? "stored-cur" : null,
        setItem: () => undefined
      },
      setTimeout
    };
    FakeWebSocket.instances = [];

    try {
      const { createPortalWebSocketLiveDataSource } = await loadDataSource();
      const source = createPortalWebSocketLiveDataSource({
        initialSnapshot: {
          activities: [],
          connectionState: "offline",
          onlinePeople: []
        },
        url: "wss://live.example.test/socket",
        workspaceId: "workspace-2"
      });
      source.start();
      FakeWebSocket.instances[0].emit("open");

      const subscribeMessage = JSON.parse(FakeWebSocket.instances[0].sent[0]);
      assert.equal(subscribeMessage.cursor, "stored-cur");
      source.stop();
    } finally {
      globalThis.WebSocket = previousWebSocket;
      globalThis.window = previousWindow;
    }
  });

  it("closes an errored socket and schedules a reconnect instead of remaining stuck", async () => {
    const previousWebSocket = globalThis.WebSocket;
    const previousWindow = globalThis.window;
    const timers = new Map();
    let timerId = 0;
    globalThis.WebSocket = FakeWebSocket;
    globalThis.window = {
      clearTimeout: (id) => timers.delete(id),
      localStorage: { getItem: () => null, setItem: () => undefined },
      setTimeout: (callback) => {
        timerId += 1;
        timers.set(timerId, callback);
        return timerId;
      }
    };
    FakeWebSocket.instances = [];

    try {
      const { createPortalWebSocketLiveDataSource } = await loadDataSource();
      const source = createPortalWebSocketLiveDataSource({
        initialSnapshot: { activities: [], connectionState: "offline", onlinePeople: [] },
        url: "wss://live.example.test/socket",
        workspaceId: "workspace-3"
      });
      source.start();
      const firstSocket = FakeWebSocket.instances[0];
      firstSocket.emit("open");
      firstSocket.emit("error");

      assert.equal(source.getSnapshot().connectionState, "reconnecting");
      assert.deepEqual(firstSocket.closed, { code: 4000, reason: "socket_error" });
      assert.equal(timers.size, 1);

      [...timers.values()][0]();
      assert.equal(FakeWebSocket.instances.length, 2);
      source.stop();
    } finally {
      globalThis.WebSocket = previousWebSocket;
      globalThis.window = previousWindow;
    }
  });
});
