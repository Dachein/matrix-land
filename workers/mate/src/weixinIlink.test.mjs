import assert from "node:assert/strict";
import test from "node:test";
import { getWeixinUpdates, safeIlinkOrigin, sendWeixinText, startWeixinQr } from "./weixinIlink.ts";

test("Mate QR authorization uses Tencent iLink without a prior account token", async () => {
  const requests = [];
  const result = await startWeixinQr(async (url, init) => {
    requests.push({ init, url: String(url) });
    return Response.json({
      qrcode: "opaque-qr-session",
      qrcode_img_content: "https://weixin.qq.com/x/authorize-content"
    });
  });

  assert.equal(result.qrcode, "opaque-qr-session");
  assert.equal(result.qrUrl, "https://weixin.qq.com/x/authorize-content");
  assert.match(requests[0].url, /get_bot_qrcode\?bot_type=3$/);
  assert.deepEqual(JSON.parse(requests[0].init.body), { local_token_list: [] });
  assert.equal(requests[0].init.headers.Authorization, undefined);
});

test("Mate private messages use the pinned iLink origin contract", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ body: JSON.parse(init.body), headers: init.headers, url: String(url) });
    return String(url).endsWith("/getupdates")
      ? Response.json({ get_updates_buf: "cursor-2", msgs: [], ret: 0 })
      : Response.json({ ret: 0 });
  };
  const credentials = {
    baseUrl: "https://ilinkai.weixin.qq.com",
    cursor: "cursor-1",
    token: "bot-token"
  };
  const updates = await getWeixinUpdates(credentials, fetchImpl);
  await sendWeixinText(credentials, {
    contextToken: "reply-context",
    text: "Workspace reply",
    to: "weixin-user"
  }, fetchImpl);

  assert.equal(updates.get_updates_buf, "cursor-2");
  assert.equal(requests[0].headers.Authorization, "Bearer bot-token");
  assert.equal(requests[0].body.get_updates_buf, "cursor-1");
  assert.equal(requests[1].body.msg.to_user_id, "weixin-user");
  assert.equal(requests[1].body.msg.context_token, "reply-context");
  assert.equal(requests[1].body.msg.item_list[0].text_item.text, "Workspace reply");
});

test("Mate iLink rejects non-Tencent and downgrade origins", () => {
  assert.equal(safeIlinkOrigin("https://ilinkai.weixin.qq.com/path"), "https://ilinkai.weixin.qq.com");
  assert.throws(() => safeIlinkOrigin("https://weixin.qq.com.attacker.example"));
  assert.throws(() => safeIlinkOrigin("http://ilinkai.weixin.qq.com"));
});
