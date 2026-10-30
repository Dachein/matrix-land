import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composerLineCount, resizeChatViewport, updateChatKeyboard, visibleChatHeight } from "./chatViewport.ts";

const phone = { width: 390, height: 844, keyboardHeight: 0 };

describe("chat keyboard viewport", () => {
  it("keeps the entire composer above an iOS keyboard and restores the full page", () => {
    const open = updateChatKeyboard(phone, 336);
    assert.equal(visibleChatHeight(open), 508);
    assert.equal(visibleChatHeight(updateChatKeyboard(open, 0)), 844);
  });
  it("does not subtract twice when Android resizes before the keyboard event", () => {
    const resized = resizeChatViewport(phone, 390, 508);
    assert.equal(visibleChatHeight(updateChatKeyboard(resized, 336)), 508);
  });
  it("does not subtract twice when Android resizes after the keyboard event", () => {
    const open = updateChatKeyboard(phone, 336);
    assert.equal(visibleChatHeight(resizeChatViewport(open, 390, 508)), 508);
  });
  it("retains the full height if a late resize arrives after keyboard close", () => {
    const closed = updateChatKeyboard(updateChatKeyboard(phone, 336), 0);
    assert.equal(visibleChatHeight(resizeChatViewport(closed, 390, 508)), 844);
  });
  it("follows keyboard candidate panel height changes without cumulative offsets", () => {
    let current = phone;
    for (const height of [336, 396, 336, 0, 336, 0]) {
      current = updateChatKeyboard(current, height);
      assert.equal(visibleChatHeight(current), 844 - height);
    }
  });
  it("accepts orientation/window-width changes as a new baseline", () => {
    const landscape = resizeChatViewport(updateChatKeyboard(phone, 336), 844, 390);
    assert.equal(visibleChatHeight(landscape), 390);
    assert.equal(visibleChatHeight(resizeChatViewport(landscape, 390, 844)), 844);
  });
  it("rejects malformed keyboard and window sizes", () => {
    for (const height of [-1, NaN, Infinity, 844, 900]) assert.deepEqual(updateChatKeyboard(phone, height), phone);
    for (const height of [-1, 0, NaN, Infinity]) assert.deepEqual(resizeChatViewport(phone, 390, height), phone);
  });
  it("bounds pasted multiline text at four visible lines and shrinks after deletion", () => {
    assert.equal(composerLineCount(1), 1);
    assert.equal(composerLineCount(3), 3);
    assert.equal(composerLineCount(100), 4);
    assert.equal(composerLineCount(0), 1);
    assert.equal(composerLineCount(NaN), 1);
    assert.equal(composerLineCount(2), 2);
  });
});

it("ignores repeated native events without triggering another layout render", () => {
  assert.equal(updateChatKeyboard(phone, 0), phone);
  assert.equal(resizeChatViewport(phone, 390, 844), phone);
  const open = updateChatKeyboard(phone, 336);
  for (let i = 0; i < 100; i++) {
    assert.equal(updateChatKeyboard(open, 336), open);
    assert.equal(resizeChatViewport(open, 390, 508), open);
  }
});
