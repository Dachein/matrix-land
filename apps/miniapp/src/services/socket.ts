import Taro from "@tarojs/taro";
import type { ChatSocket } from "./chat";

/**
 * The only place the chat transport touches Taro. Keeping it isolated means the
 * reconnect / session-renewal / approval state machine in `chat.ts` can be unit tested
 * against an injected socket, while production still uses the real WeChat socket task.
 */
export function connectChatSocket(options: { url: string }): ChatSocket {
  return Taro.connectSocket(options) as unknown as ChatSocket;
}
