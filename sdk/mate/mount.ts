import { WorkspaceMateClient } from "./client.ts";
import type { WorkspaceMateMountOptions } from "./types.ts";

export function mountWorkspaceMate(options: WorkspaceMateMountOptions) {
  const client = new WorkspaceMateClient(options);
  const root = document.createElement("section");
  root.className = "workspace-mate-panel";
  const form = document.createElement("form");
  const textarea = document.createElement("textarea");
  textarea.maxLength = 12_000;
  textarea.placeholder = options.placeholder ?? "Ask your Mate…";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Send";
  const output = document.createElement("div");
  output.setAttribute("aria-live", "polite");
  form.appendChild(textarea);
  form.appendChild(submit);
  root.appendChild(form);
  root.appendChild(output);
  options.container.replaceChildren(root);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const instruction = textarea.value.trim();
    if (!instruction) return;
    submit.disabled = true;
    output.textContent = "Running…";
    void client.ask(instruction).then((task) => {
      output.textContent = task.conclusion?.summary || task.status;
      textarea.value = "";
    }).catch((error) => {
      output.textContent = error instanceof Error ? error.message : "mate_request_failed";
    }).finally(() => { submit.disabled = false; });
  });
  return {
    client,
    destroy() { root.remove(); },
    environment: client.environment,
    updateContext: (context: Parameters<WorkspaceMateClient["updateContext"]>[0]) => client.updateContext(context)
  };
}
