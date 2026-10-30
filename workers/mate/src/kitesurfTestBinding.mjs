export function kitesurfTestBinding(page = {}) {
  const calls = [];
  const commands = [];
  return {
    BROWSER: {
      async fetch(input, init = {}) {
        calls.push({ init, url: String(input) });
        const response = new Response(null, { status: 200 });
        Object.defineProperty(response, "webSocket", {
          value: new FakeKitesurfSocket(commands, page)
        });
        return response;
      }
    },
    calls,
    commands
  };
}

class FakeKitesurfSocket extends EventTarget {
  constructor(commands, page) {
    super();
    this.commands = commands;
    this.page = page;
    this.navigationUrl = "https://example.com/article";
  }

  accept() {}

  close() {
    this.dispatchEvent(new Event("close"));
  }

  send(value) {
    const command = JSON.parse(String(value));
    this.commands.push(command);
    let result = {};
    if (command.method === "Target.createTarget") result = { targetId: "target-1" };
    if (command.method === "Target.attachToTarget") result = { sessionId: "session-1" };
    if (command.method === "Page.navigate") {
      result = { frameId: "frame-1" };
      this.navigationUrl = command.params.url;
    }
    if (command.method === "Runtime.evaluate") result = {
      result: {
        type: "object",
        value: {
          links: [{ href: "https://example.com/more", text: "More" }],
          readyState: "complete",
          text: "Kitesurf rendered this evidence.",
          title: "Workspace public page",
          url: this.navigationUrl,
          ...this.page,
          requests: undefined
        }
      }
    };
    queueMicrotask(() => {
      if (command.method === "Page.navigate") {
        const requests = this.page.requests ?? [{
          resourceType: "Document",
          url: command.params.url
        }];
        requests.forEach((request, index) => this.dispatchMessage({
          method: "Fetch.requestPaused",
          params: {
            request: { url: request.url },
            requestId: `request-${index + 1}`,
            resourceType: request.resourceType ?? "Other"
          },
          sessionId: command.sessionId
        }));
      }
      this.dispatchMessage({ id: command.id, result });
    });
  }

  dispatchMessage(payload) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: JSON.stringify(payload) });
    this.dispatchEvent(event);
  }
}
