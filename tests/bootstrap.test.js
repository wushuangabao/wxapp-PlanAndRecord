const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_TIMER_SPAN_MS } = require('../miniprogram/domain/constants');
const { createInitialDatabase } = require('../miniprogram/domain/entities');
const { StorageError } = require('../miniprogram/domain/errors');
const {
  DEVELOPMENT_RECOVERY_TIMER_SPAN_MS,
  createBootstrapState,
  createRecoveryTimerOptions
} = require('../miniprogram/services/bootstrap');

test('开发环境只覆盖八秒恢复窗口，不配置伪造的最小时长', () => {
  assert.deepEqual(createRecoveryTimerOptions({
    miniProgram: { envVersion: 'develop' }
  }), {
    recoveryTimerSpanMs: DEVELOPMENT_RECOVERY_TIMER_SPAN_MS
  });
});

test('合法资料库初始化完成后才构造应用服务并进入 ready 模式', () => {
  const calls = [];
  const repository = {
    initialize() { calls.push('repository.initialize'); return createInitialDatabase(1); }
  };
  class FakeApplicationService {
    constructor() { calls.push('application.constructor'); }
    initialize() { calls.push('application.initialize'); return { restored: true }; }
  }

  const result = createBootstrapState({
    storage: {}, repository, ApplicationServiceClass: FakeApplicationService,
    exportTempFileStore: { removeAllStrict() {} }, now: () => 2
  });

  assert.equal(result.mode, 'ready');
  assert.deepEqual(result.recovery, { restored: true });
  assert.deepEqual(calls, [
    'repository.initialize', 'application.constructor', 'application.initialize'
  ]);
});

test('损坏与版本不支持进入独立恢复模式且不构造应用服务', () => {
  for (const code of ['DATA_CORRUPTED', 'DATA_VERSION_UNSUPPORTED']) {
    let constructed = 0;
    class ForbiddenApplicationService {
      constructor() { constructed += 1; }
    }
    const repository = {
      initialize() { throw new StorageError(code, 'safe'); }
    };
    const result = createBootstrapState({
      storage: { get: () => 'raw' }, repository,
      ApplicationServiceClass: ForbiddenApplicationService,
      exportTempFileStore: { removeAllStrict() {} }, now: () => 2
    });

    assert.equal(result.mode, 'data-recovery');
    assert.equal(result.recoveryReason, code);
    assert.equal(typeof result.recoveryService.exportRawData, 'function');
    assert.equal(constructed, 0);
  }
});

test('非资料库损坏错误保持抛出', () => {
  assert.throws(
    () => createBootstrapState({
      storage: {},
      repository: { initialize() { throw new StorageError('WRITE_FAILED', 'write failed'); } },
      exportTempFileStore: { removeAllStrict() {} }
    }),
    (error) => error.code === 'WRITE_FAILED'
  );
});

test('app 在恢复模式启动时跳转恢复页，onShow 不访问应用服务', () => {
  const appPath = require.resolve('../miniprogram/app.js');
  const previousApp = global.App;
  const previousWx = global.wx;
  const calls = { reLaunch: [], writes: 0 };
  let appDefinition;
  global.App = (definition) => { appDefinition = definition; };
  global.wx = {
    getStorageInfoSync: () => ({ keys: ['plan-and-record.database'] }),
    getStorageSync: () => '{',
    setStorageSync: () => { calls.writes += 1; },
    removeStorageSync: () => { calls.writes += 1; },
    reLaunch: (options) => calls.reLaunch.push(options),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } })
  };

  try {
    delete require.cache[appPath];
    require(appPath);
    appDefinition.onLaunch();
    assert.equal(appDefinition.globalData.bootstrap.mode, 'data-recovery');
    assert.deepEqual(calls.reLaunch, [{ url: '/pages/data-recovery/index' }]);
    assert.doesNotThrow(() => appDefinition.onShow());
    assert.equal(calls.writes, 0);
  } finally {
    delete require.cache[appPath];
    if (previousApp === undefined) delete global.App; else global.App = previousApp;
    if (previousWx === undefined) delete global.wx; else global.wx = previousWx;
  }
});

test('app onShow 仅在 ready 模式恢复计时', () => {
  const appPath = require.resolve('../miniprogram/app.js');
  const previousApp = global.App;
  let appDefinition;
  global.App = (definition) => { appDefinition = definition; };
  try {
    delete require.cache[appPath];
    require(appPath);
    let recoverCalls = 0;
    appDefinition.globalData.bootstrap = {
      mode: 'ready',
      applicationService: {
        recoverTimer() { recoverCalls += 1; return { status: 'idle' }; }
      }
    };
    appDefinition.onShow();
    assert.equal(recoverCalls, 1);
    assert.deepEqual(appDefinition.globalData.bootstrap.recovery, { status: 'idle' });
  } finally {
    delete require.cache[appPath];
    if (previousApp === undefined) delete global.App; else global.App = previousApp;
  }
});

test('体验版、正式版及未知环境继续使用二十四小时恢复窗口', () => {
  for (const accountInfo of [
    { miniProgram: { envVersion: 'trial' } },
    { miniProgram: { envVersion: 'release' } },
    null
  ]) {
    assert.deepEqual(createRecoveryTimerOptions(accountInfo), {
      recoveryTimerSpanMs: MAX_TIMER_SPAN_MS
    });
  }
});
