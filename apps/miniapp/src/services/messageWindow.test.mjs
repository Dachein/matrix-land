import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MESSAGE_RENDER_LIMIT, MESSAGE_RENDER_MAX, windowMessages, shiftMessageWindow, anchoredScrollTop } from './messageWindow.ts';
const history = count => Array.from({length: count}, (_, index) => ({id: `m-${index}`, role: index % 2 ? 'assistant' : 'user', parts: [{type:'text',text:`message ${index}`}]}));
describe('bounded mobile history', () => {
  it('starts with the latest ten, preserving identity for a short conversation', () => {
    const short = history(5);
    assert.equal(windowMessages(short).messages, short);
    const result = windowMessages(history(1000));
    assert.equal(result.messages.length, MESSAGE_RENDER_LIMIT);
    assert.equal(result.hiddenCount, 990); assert.equal(result.newerCount, 0);
  });
  it('visits all 1000 messages in both directions without exceeding 30 mounted rows', () => {
    const all = history(1000), seen = new Set();
    let window = windowMessages(all);
    for (let i=0; i<100; i++) {
      window.messages.forEach(m => seen.add(m.id));
      assert.ok(window.messages.length <= MESSAGE_RENDER_MAX);
      if (!window.hiddenCount) break;
      const anchor = window.messages[0].id;
      window = windowMessages(all, shiftMessageWindow(all, window, 'earlier'));
      assert.ok(window.messages.some(m => m.id === anchor), 'older paging retains the top anchor');
    }
    assert.equal(seen.size, 1000);
    while (window.newerCount) {
      const anchor = window.messages.at(-1).id;
      const next = windowMessages(all, shiftMessageWindow(all, window, 'newer'));
      assert.ok(next.start > window.start);
      assert.ok(next.messages.some(m => m.id === anchor), 'newer paging retains bottom anchor');
      assert.ok(next.messages.length <= MESSAGE_RENDER_MAX); window = next;
    }
    assert.equal(window.messages.at(-1).id, 'm-999');
    assert.equal(windowMessages(all).messages.length, 10, 'jump to latest resets history size');
  });
  it('does not slide history when new messages arrive or earlier records are prepended', () => {
    const all = history(100), cursor = {firstId: 'm-20', count:30};
    const before = windowMessages(all, cursor);
    const after = windowMessages([{id:'older'}, ...all, ...history(3).map(m=>({...m,id:`new-${m.id}`}))], cursor);
    assert.deepEqual(after.messages, before.messages); assert.equal(after.newerCount, 53);
  });
  it('handles empty, stale conversation IDs and oversized windows safely', () => {
    assert.equal(windowMessages([]).messages.length, 0);
    assert.equal(shiftMessageWindow([],windowMessages([]),'earlier'),undefined);
    assert.deepEqual(windowMessages(history(100),{firstId:'stale',count:30}),windowMessages(history(100)));
    assert.equal(windowMessages(history(100),{firstId:'m-0',count:9999}).messages.length,30);
  });
  it('compensates for inserted and removed pixel heights without scrolling below zero', () => {
    assert.equal(anchoredScrollTop(500,120,420),800);
    assert.equal(anchoredScrollTop(500,120,-180),200);
    assert.equal(anchoredScrollTop(10,120,0),0);
  });
});
