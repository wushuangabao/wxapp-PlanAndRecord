const test = require('node:test');
const assert = require('node:assert/strict');

const {
  captureTargetRectFromTouch,
  findRectContainingPoint,
  isPointInsideRect,
  shouldCommitLongPressRelease,
  touchPointFromEvent
} = require('../miniprogram/utils/long-press-release');

const RECT = { left: 10, top: 20, right: 40, bottom: 50, width: 30, height: 30 };

test('长按松手判定：缺少矩形或坐标时仍提交，移出目标后取消', () => {
  assert.equal(shouldCommitLongPressRelease(undefined, undefined), true);
  assert.equal(shouldCommitLongPressRelease({ changedTouches: [{ clientX: 100, clientY: 100 }] }, null), true);
  assert.equal(shouldCommitLongPressRelease({}, RECT), true);
  assert.equal(shouldCommitLongPressRelease({
    changedTouches: [{ clientX: 10, clientY: 20 }]
  }, RECT), true);
  assert.equal(shouldCommitLongPressRelease({
    changedTouches: [{ clientX: 40, clientY: 50 }]
  }, RECT), true);
  assert.equal(shouldCommitLongPressRelease({
    changedTouches: [{ clientX: 25, clientY: 35 }]
  }, RECT), true);
  assert.equal(shouldCommitLongPressRelease({
    changedTouches: [{ clientX: 9, clientY: 35 }]
  }, RECT), false);
  assert.equal(shouldCommitLongPressRelease({
    changedTouches: [{ clientX: 25, clientY: 51 }]
  }, RECT), false);
});

test('长按目标矩形：按落点命中最小包含矩形', () => {
  const point = touchPointFromEvent({
    touches: [{ clientX: 18, clientY: 28 }]
  }, 'touches');
  assert.deepEqual(point, { x: 18, y: 28 });
  assert.equal(isPointInsideRect(point, RECT), true);
  assert.equal(findRectContainingPoint([
    { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
    RECT
  ], point), RECT);
  assert.equal(findRectContainingPoint([RECT], { x: 0, y: 0 }), null);
});

test('长按目标矩形：按触摸点从节点列表捕获', () => {
  const rects = [
    { left: 0, top: 0, right: 8, bottom: 8, width: 8, height: 8 },
    RECT
  ];
  let captured;
  captureTargetRectFromTouch('.todo-title-button', {
    touches: [{ clientX: 25, clientY: 35 }]
  }, 'touches', (rect) => {
    captured = rect;
  }, {
    createSelectorQuery() {
      return {
        selectAll(selector) {
          assert.equal(selector, '.todo-title-button');
          return this;
        },
        boundingClientRect(callback) {
          callback(rects);
          return this;
        },
        exec() {}
      };
    }
  });
  assert.equal(captured, RECT);

  captureTargetRectFromTouch('.missing', {
    touches: [{ clientX: 25, clientY: 35 }]
  }, 'touches', (rect) => {
    captured = rect;
  }, {});
  assert.equal(captured, null);
});
