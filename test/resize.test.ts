// Pure layout maths for mouse/keyboard resizing of the three columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnWidths, dragChatShare, dragFeedShare, FEED_MIN, FEED_MAX } from '../src/tui.ts';

const total = (W: number, c: { fw: number; gw: number; pw: number }) => c.fw + c.gw + c.pw + (c.fw ? 2 : 1);

test('no feedShare: default widths are unchanged', () => {
  assert.deepEqual(columnWidths(179, 0.42, false), { fw: 43, gw: 59, pw: 75 });
  assert.deepEqual(columnWidths(179, 0.42, false, undefined), columnWidths(179, 0.42, false));
});

test('dragChatShare: border column -> chat share, clamped to 0.3..0.6', () => {
  assert.equal(dragChatShare(200, 200 - 1 - 80), 0.4);
  assert.equal(dragChatShare(200, 0), 0.6);      // dragged all the way left
  assert.equal(dragChatShare(200, 199), 0.3);    // dragged all the way right
});

test('dragFeedShare: feed keeps 30..70 cols and leaves the graph 40', () => {
  const W = 200;
  assert.equal(dragFeedShare(W, 0, 0.42) * W, FEED_MIN);
  assert.equal(dragFeedShare(W, 199, 0.42) * W, FEED_MAX);
  const pw = Math.round(W * 0.6);
  assert.equal(dragFeedShare(W, 199, 0.6) * W, Math.min(FEED_MAX, W - pw - 2 - 40));
});

test('every drag position keeps all minimum widths and the total', () => {
  for (const W of [140, 160, 179, 220, 300]) for (let x = 0; x < W; x += 3) {
    const share = dragChatShare(W, x);
    const c1 = columnWidths(W, share, false);
    assert.ok(c1.pw >= 60 && c1.gw >= 40 && c1.fw >= 26, `chat drag W=${W} x=${x} ${JSON.stringify(c1)}`);
    assert.equal(total(W, c1), W);
    const fs = dragFeedShare(W, x, 0.42);
    const c2 = columnWidths(W, 0.42, false, fs);
    assert.ok(c2.fw >= FEED_MIN && c2.fw <= FEED_MAX && c2.gw >= 40 && c2.pw >= 64, `feed drag W=${W} x=${x} ${JSON.stringify(c2)}`);
    assert.equal(total(W, c2), W);
  }
});

test('narrow terminals and a hidden feed ignore feedShare', () => {
  assert.equal(columnWidths(120, 0.42, false, 0.3).fw, 0);
  assert.equal(columnWidths(200, 0.42, true, 0.3).fw, 0);
});
