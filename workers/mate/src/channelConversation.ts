import { acceptWorkspaceMateEnvironment } from "../../../sdk/mate/environment.ts";
import type { UIMessage } from "ai";
import { mateChatInstanceName } from "./chatAddress.ts";
import {
  mateChatRecoveryContext,
  mateChatTurnBinding,
  type MateChatCapabilitySelection
} from "./chatAgentProtocol.ts";
import { createMateChatGrant, verifyMateChatGrant } from "./chatGrant.ts";
import { loadRuntimeDefinition } from "./controlPlane.ts";
import { createConversation, readConversation } from "./storage.ts";
import { RuntimeHttpError, type RuntimeEnv, type RuntimePrincipal } from "./types.ts";

export async function triggerMateConversation(input: {
  conversationId?: string;
  env: RuntimeEnv;
  ingress: "api" | "weixin";
  messageId: string;
  principal: RuntimePrincipal;
  selection?: MateChatCapabilitySelection;
  mateId: string;
  text: string;
}) {
  if (!input.env.MATE_CHAT_AGENT) throw new RuntimeHttpError(503, "mate_chat_agent_not_configured");
  const text = boundedText(input.text, 12_000, "mate_channel_message_text_required");
  const messageId = boundedId(input.messageId, "mate_channel_message_id_invalid");
  const definition = await loadRuntimeDefinition(input.env, input.principal, input.mateId, "live");
  assertConversationEnabled(definition.release.manifest as Record<string, any>);
  const conversation = input.conversationId
    ? await readConversation(input.env.RUNTIME_DB, input.mateId, input.principal.userId, "live", input.conversationId)
    : await createConversation(input.env.RUNTIME_DB, input.mateId, input.principal, "live", {
      channel: "sdk",
      title: text.replace(/\s+/g, " ").slice(0, 80)
    });
  if (conversation.channel !== "sdk") throw new RuntimeHttpError(409, "mate_chat_conversation_channel_invalid");
  const conversationId = String(conversation.id);
  const secret = input.env.MATE_CHAT_GRANT_SECRET?.trim() || "";
  const grant = await createMateChatGrant({
    callerKind: "user",
    conversationId,
    ...(input.principal.departmentId ? { departmentId: input.principal.departmentId } : {}),
    ...(input.principal.departmentPath?.length ? { departmentPath: input.principal.departmentPath } : {}),
    mode: "live",
    orgId: input.principal.orgId,
    releaseId: definition.release.id,
    scopes: input.principal.scopes,
    mateId: input.mateId,
    userId: input.principal.userId
  }, secret, { ttlSeconds: 120 });
  const claims = await verifyMateChatGrant(grant, secret);
  const environment = await acceptWorkspaceMateEnvironment({
    host: {
      appId: `workspace-mate-${input.ingress}`,
      instanceId: `${input.ingress}:${conversationId}`,
      surface: input.ingress
    },
    location: {
      kind: "mate.conversation",
      ref: `mate:${input.mateId}/conversation:${conversationId}`
    },
    revision: Date.now(),
    schemaVersion: "workspace.mate-environment/v1",
    summary: { facets: { ingress: input.ingress }, label: input.ingress, state: "live" }
  });
  const userMessage: UIMessage = {
    id: messageId,
    parts: [{ text, type: "text" }],
    role: "user"
  };
  const turn = await mateChatTurnBinding({
    chatGrant: grant,
    environment: environment.context,
    id: `request-${messageId}`,
    ...(input.selection ? { selection: input.selection } : {}),
    userMessage
  }, environment, claims);
  const instanceName = await mateChatInstanceName(claims);
  const stub = input.env.MATE_CHAT_AGENT.get(
    input.env.MATE_CHAT_AGENT.idFromName(instanceName),
    { locationHint: "apac" }
  );
  const result = await stub.channelMessage({
    message: userMessage,
    recovery: mateChatRecoveryContext(claims, turn)
  });
  return { conversationId, messageId, releaseId: definition.release.id, response: result };
}

function assertConversationEnabled(manifest: Record<string, any>) {
  const channels = manifest.channels ?? {};
  if (channels.embedded?.enabled !== true && channels.standalone?.enabled !== true) {
    throw new RuntimeHttpError(403, "mate_chat_channel_disabled");
  }
}

function boundedText(value: unknown, maximum: number, code: string) {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output || output.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(output)) {
    throw new RuntimeHttpError(422, code);
  }
  return output;
}

function boundedId(value: unknown, code: string) {
  const output = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/.test(output)) throw new RuntimeHttpError(422, code);
  return output;
}
