const test = require('node:test');
const assert = require('node:assert/strict');

const { getRuntimeWindowWidth } = require('../miniprogram/utils/wechat-runtime');

test('运行时窗口宽度：优先使用 getWindowInfo 的有效结果', () => {
  let legacyCalls = 0;
  const width = getRuntimeWindowWidth({
    getWindowInfo() {
      return { windowWidth: 390 };
    },
    getSystemInfoSync() {
      legacyCalls += 1;
      return { windowWidth: 375 };
    }
  });

  assert.equal(width, 390);
  assert.equal(legacyCalls, 0);
});

for (const [caseName, getWindowInfo] of [
  ['缺失', undefined],
  ['抛错', () => { throw new Error('API unavailable'); }],
  ['返回无效宽度', () => ({ windowWidth: 0 })]
]) {
  test(`运行时窗口宽度：getWindowInfo ${caseName}时降级到 getSystemInfoSync`, () => {
    const width = getRuntimeWindowWidth({
      getWindowInfo,
      getSystemInfoSync() {
        return { windowWidth: 360 };
      }
    });

    assert.equal(width, 360);
  });
}

test('运行时窗口宽度：两个 API 均缺失、抛错或无效时安全返回 null', () => {
  assert.equal(getRuntimeWindowWidth({}), null);
  assert.equal(getRuntimeWindowWidth({
    getWindowInfo() {
      throw new Error('new API failed');
    },
    getSystemInfoSync() {
      throw new Error('legacy API failed');
    }
  }), null);
  assert.equal(getRuntimeWindowWidth({
    getWindowInfo() {
      return { windowWidth: Number.NaN };
    },
    getSystemInfoSync() {
      return { windowWidth: -1 };
    }
  }), null);
  assert.equal(getRuntimeWindowWidth(null), null);
});
