import { DurableObject } from "cloudflare:workers";
import { triggerMateConversation } from "./channelConversation.ts";
import { resolveUserRuntimePrincipal } from "./runtimeIdentity.ts";
import type { RuntimeEnv } from "./types.ts";
import {
  activeWeixinBinding,
  beginWeixinMessage,
  finishWeixinMessage,
  rotateWeixinConversation,
  updateWeixinCursor,
  type ActiveWeixinBinding
} from "./weixinChannel.ts";
import { weixinIdentityHash } from "./weixinCrypto.ts";
import {
  getWeixinUpdates,
  sendWeixinText,
  type WeixinMessage
} from "./weixinIlink.ts";
import { formatWeixinConversationResponse } from "./weixinConversation.ts";

const GATEWAY_BINDING_KEY = "binding-id";
const RETRY_COUNT_KEY = "retry-count";

export class MateWeixinGateway extends DurableObject<RuntimeEnv> {
  async start(bindingId: string) {
    await this.ctx.storage.put(GATEWAY_BINDING_KEY, bindingId);
    await this.ctx.storage.put(RETRY_COUNT_KEY, 0);
    await this.ctx.storage.setAlarm(Date.now() + 100);
  }

  async stop(bindingId: string) {
    const current = await this.ctx.storage.get<string>(GATEWAY_BINDING_KEY);
    if (current === bindingId) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    }
  }

  override async alarm() {
    const bindingId = await this.ctx.storage.get<string>(GATEWAY_BINDING_KEY);
    if (!bindingId) return;
    const binding = await activeWeixinBinding(this.env, bindingId);
    if (!binding) {
      await this.ctx.storage.deleteAll();
      return;
    }
    let delay = 750;
    try {
      const updates = await getWeixinUpdates(binding.credentials);
      if (Number(updates.ret ?? 0) !== 0) throw new Error("mate_weixin_updates_failed");
      if (typeof updates.get_updates_buf === "string" && updates.get_updates_buf !== binding.credentials.cursor) {
        await updateWeixinCursor(this.env, binding, updates.get_updates_buf);
      }
      for (const message of updates.msgs ?? []) await this.processMessage(binding, message);
      await this.ctx.storage.put(RETRY_COUNT_KEY, 0);
    } catch (error) {
      const retryCount = Math.min(8, (await this.ctx.storage.get<number>(RETRY_COUNT_KEY) ?? 0) + 1);
      await this.ctx.storage.put(RETRY_COUNT_KEY, retryCount);
      delay = Math.min(60_000, 1_000 * 2 ** retryCount);
      console.error("mate_weixin_gateway_poll_failed", {
        bindingId,
        errorName: error instanceof Error ? error.name : "unknown",
        retryCount
      });
    }
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private async processMessage(binding: ActiveWeixinBinding, message: WeixinMessage) {
    if (message.group_id?.trim()) return;
    if (message.message_type !== undefined && message.message_type !== 1) return;
    const sender = message.from_user_id?.trim();
    const externalMessageId = String(message.message_id ?? message.client_id ?? "").trim();
    if (!sender || !externalMessageId) return;
    const senderHash = await weixinIdentityHash(this.env, "subject", `${binding.credentials.botId}\u0000${sender}`);
    if (senderHash !== binding.external_subject_hash) return;

    const requestId = crypto.randomUUID();
    if (!await beginWeixinMessage(this.env, binding.id, externalMessageId, requestId)) return;
    try {
      const principal = await resolveUserRuntimePrincipal(this.env, binding.user_id, "user");
      if (principal.orgId !== binding.org_id) throw new Error("mate_weixin_org_changed");
      const text = inboundText(message);
      if (!text) {
        await sendWeixinText(binding.credentials, {
          contextToken: message.context_token,
          text: "当前微信通道仅支持文字消息。图片和办公文件请在 Mate 工作台中上传。",
          to: sender
        });
        await finishWeixinMessage(this.env, binding.id, externalMessageId, "ignored", "text_only");
        return;
      }
      if (["/new", "新对话", "重新开始"].includes(text.toLowerCase())) {
        await rotateWeixinConversation(this.env, binding, principal);
        await sendWeixinText(binding.credentials, {
          contextToken: message.context_token,
          text: "已创建新的 Mate 对话。工作台中也会显示这条 Conversation。",
          to: sender
        });
        await finishWeixinMessage(this.env, binding.id, externalMessageId, "completed");
        return;
      }
      const result = await triggerMateConversation({
        conversationId: binding.active_conversation_id,
        env: this.env,
        ingress: "weixin",
        messageId: `weixin-${requestId}`,
        principal,
        mateId: binding.mate_id,
        text
      });
      await sendWeixinText(binding.credentials, {
        contextToken: message.context_token,
        text: formatWeixinConversationResponse(result.response.text, {
          conversationId: result.conversationId,
          mateId: binding.mate_id,
          webHostUrl: this.env.MATE_WEB_HOST_URL
        }),
        to: sender
      });
      await finishWeixinMessage(this.env, binding.id, externalMessageId, "completed");
    } catch (error) {
      await finishWeixinMessage(
        this.env,
        binding.id,
        externalMessageId,
        "failed",
        error instanceof Error ? error.message.slice(0, 120) : "unknown"
      );
      console.error("mate_weixin_private_message_failed", {
        bindingId: binding.id,
        errorName: error instanceof Error ? error.name : "unknown",
        requestId
      });
    }
  }
}

function inboundText(message: WeixinMessage) {
  return (message.item_list ?? [])
    .map((item) => item.type === 1 ? item.text_item?.text : item.type === 3 ? item.voice_item?.text : "")
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .join("\n")
    .trim()
    .slice(0, 12_000);
}
