/** Deterministic OpenAI-compatible stream; exercises the real AI SDK tool loop. */
export function taskModelStream(step, id = "test-response") {
  const delta = step.tool ? {
    role: "assistant",
    tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: {
      name: step.tool, arguments: JSON.stringify(step.args ?? {})
    } }]
  } : { role: "assistant", content: step.text };
  const chunk = (delta, finish_reason = null) => ({
    id, object: "chat.completion.chunk", created: 1, model: "test",
    choices: [{ index: 0, delta, finish_reason }]
  });
  return new Response([
    `data: ${JSON.stringify(chunk(delta))}`,
    `data: ${JSON.stringify(chunk({}, step.tool ? "tool_calls" : "stop"))}`,
    "data: [DONE]", ""
  ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
}
