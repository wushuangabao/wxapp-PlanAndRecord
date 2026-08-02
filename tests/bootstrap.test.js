const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_TIMER_SPAN_MS } = require('../miniprogram/domain/constants');
const {
  DEVELOPMENT_RECOVERY_TIMER_SPAN_MS,
  createRecoveryTimerOptions
} = require('../miniprogram/services/bootstrap');

test('开发环境使用恢复窗口，并确保候选预览至少显示一分钟', () => {
  assert.deepEqual(createRecoveryTimerOptions({
    miniProgram: { envVersion: 'develop' }
  }), {
    recoveryTimerSpanMs: DEVELOPMENT_RECOVERY_TIMER_SPAN_MS,
    minimumRecoveryDurationMinutes: 1
  });
});

test('体验版、正式版及未知环境继续使用二十四小时恢复窗口', () => {
  for (const accountInfo of [
    { miniProgram: { envVersion: 'trial' } },
    { miniProgram: { envVersion: 'release' } },
    null
  ]) {
    assert.deepEqual(createRecoveryTimerOptions(accountInfo), {
      recoveryTimerSpanMs: MAX_TIMER_SPAN_MS,
      minimumRecoveryDurationMinutes: 1
    });
  }
});
