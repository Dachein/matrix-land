import type { LanguageModelMiddleware } from "ai";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { RuntimeHttpError } from "./types.ts";

export type EmptyFinalRecovery = {
  attempts: 1;
  initialFinishReason: string;
  recovered: boolean;
};

/** Recover one empty normal completion, using only the existing model context. */
export function emptyFinalResponseMiddleware(input: {
  allowed: () => boolean;
  luna: boolean;
  onRecovery: (recovery: EmptyFinalRecovery) => void;
}): LanguageModelMiddleware {
  let attempted = false;
  return {
    specificationVersion: "v4",
    wrapStream: async ({ doStream, model, params }) => {
      const initial = await doStream();
      let activeReader: ReadableStreamDefaultReader<LanguageModelV4StreamPart> | undefined = initial.stream.getReader();
      let cancelled = false;
      return {
        ...initial,
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            let finish: Extract<LanguageModelV4StreamPart, { type: "finish" }> | undefined;
            let hasText = false;
            let hasTools = false;
            let failed = false;
            try {
              while (!cancelled) {
                const next = await activeReader!.read();
                if (next.done) break;
                const part = next.value;
                if (part.type === "finish") finish = part;
                else {
                  if (part.type === "text-delta" && part.delta.trim()) hasText = true;
                  if (part.type.startsWith("tool-")) hasTools = true;
                  if (part.type === "error") failed = true;
                  controller.enqueue(part);
                }
              }
              activeReader!.releaseLock();
              activeReader = undefined;
              if (cancelled) return;
              if (!attempted && !hasText && !hasTools && !failed && finish
                && ["stop", "other"].includes(finish.finishReason.unified)
                && !params.abortSignal?.aborted && input.allowed()) {
                attempted = true;
                const recovery: EmptyFinalRecovery = {
                  attempts: 1, initialFinishReason: finish.finishReason.unified, recovered: false
                };
                input.onRecovery(recovery);
                const retry = await model.doStream({
                  ...params,
                  tools: [],
                  toolChoice: { type: "none" },
                  prompt: [...params.prompt, {
                    role: "user",
                    content: [{ type: "text", text:
                      "The previous model response ended without a user-facing answer. Provide the final answer now, in the user's language, using only the facts and tool results already in this conversation. No tools are available for this response. State any failed or unconfirmed operation honestly; do not claim it succeeded. If the requested work remains incomplete, explain what was completed and what is still needed."
                    }]
                  }],
                  ...(input.luna ? { providerOptions: {
                    ...params.providerOptions,
                    openai: { ...params.providerOptions?.openai, reasoningEffort: "low" }
                  } } : {})
                });
                if (cancelled) {
                  await retry.stream.cancel();
                  return;
                }
                activeReader = retry.stream.getReader();
                let retryHasText = false;
                let retryFinishedNormally = false;
                while (!cancelled) {
                  const next = await activeReader.read();
                  if (next.done) break;
                  const part = next.value;
                  // Even an out-of-contract provider tool call must never reach
                  // AI SDK's executor during this text-only recovery.
                  if (part.type.startsWith("tool-")) {
                    await activeReader.cancel();
                    throw new RuntimeHttpError(502, "mate_final_response_tool_call_blocked");
                  }
                  if (part.type === "finish") {
                    retryFinishedNormally = part.finishReason.unified === "stop";
                    controller.enqueue({ ...part, usage: combinedUsage(finish.usage, part.usage) });
                  } else if (part.type !== "stream-start") {
                    if (part.type === "text-delta" && part.delta.trim()) retryHasText = true;
                    controller.enqueue("id" in part && (part.type.startsWith("text-") || part.type.startsWith("reasoning-"))
                      ? { ...part, id: `empty-final:${part.id}` } : part);
                  }
                }
                activeReader.releaseLock();
                activeReader = undefined;
                recovery.recovered = retryHasText && retryFinishedNormally;
                input.onRecovery({ ...recovery });
              } else if (finish) controller.enqueue(finish);
              if (!cancelled) controller.close();
            } catch (error) {
              if (!cancelled) controller.error(error);
            }
          },
          async cancel(reason) {
            cancelled = true;
            await activeReader?.cancel(reason);
          }
        })
      };
    }
  };
}

function combinedUsage(first: LanguageModelV4Usage, second: LanguageModelV4Usage): LanguageModelV4Usage {
  const sum = (a: number | undefined, b: number | undefined) =>
    a === undefined || b === undefined ? undefined : a + b;
  return {
    inputTokens: {
      total: sum(first.inputTokens.total, second.inputTokens.total),
      noCache: sum(first.inputTokens.noCache, second.inputTokens.noCache),
      cacheRead: sum(first.inputTokens.cacheRead, second.inputTokens.cacheRead),
      cacheWrite: sum(first.inputTokens.cacheWrite, second.inputTokens.cacheWrite)
    },
    outputTokens: {
      total: sum(first.outputTokens.total, second.outputTokens.total),
      text: sum(first.outputTokens.text, second.outputTokens.text),
      reasoning: sum(first.outputTokens.reasoning, second.outputTokens.reasoning)
    }
  };
}
