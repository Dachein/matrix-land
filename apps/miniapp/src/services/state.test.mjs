import assert from "node:assert/strict";
import { it } from "node:test";
import { state } from "../state.ts";
import Taro from "@tarojs/taro";

it("treats missing WeChat storage as no live session after a cache clear", () => {
  state.clearLiveSession();
  assert.equal(state.getLiveSession(), undefined);
  assert.doesNotThrow(() => state.getLiveSession()?.mate.id);
  const session = { mate: { id: "mate" } };
  state.setLiveSession(session);
  assert.deepEqual(state.getLiveSession(), session);
  state.clearLiveSession();
  assert.equal(state.getLiveSession(), undefined);
});

it("ignores legacy and malformed cached sessions without dereferencing mate", () => {
  for (const value of ["", "old-session", {}, { mate: null }, { mate: {} }]) {
    Taro.setStorageSync("workspace.mini.live-session/v1", value);
    assert.equal(state.getLiveSession(), undefined);
  }
  state.clearLiveSession();
});
