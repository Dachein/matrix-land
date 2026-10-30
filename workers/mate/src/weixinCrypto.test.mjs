import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptWeixinValue,
  encryptWeixinValue,
  weixinIdentityHash
} from "./weixinCrypto.ts";

const env = { MATE_WEIXIN_CHANNEL_SECRET: "test-mate-weixin-channel-secret-long-enough" };

test("Mate Weixin credentials are encrypted and identity indexes remain non-reversible", async () => {
  const credentials = {
    baseUrl: "https://ilinkai.weixin.qq.com",
    botId: "bot-secret-id",
    token: "weixin-secret-token",
    userId: "weixin-user-id"
  };
  const encrypted = await encryptWeixinValue(env, credentials);
  assert.equal(encrypted.ciphertext.includes(credentials.token), false);
  assert.deepEqual(await decryptWeixinValue(env, encrypted), credentials);
  const subject = await weixinIdentityHash(env, "subject", `${credentials.botId}\0${credentials.userId}`);
  assert.equal(subject.includes(credentials.userId), false);
  await assert.rejects(
    decryptWeixinValue({ MATE_WEIXIN_CHANNEL_SECRET: "another-test-secret-that-is-long-enough" }, encrypted),
    (error) => error.code === "mate_weixin_credentials_unavailable"
  );
});
