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
const { createDisabledPorts } = require('../miniprogram/services/ports');

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

test('冷启动计时恢复遇到容量上限时仍建立只读 ready 状态并保留待展示出口', () => {
  const capacityError = new StorageError(
    'STORAGE_CAPACITY_EXCEEDED',
    '本地资料库已达到容量上限'
  );
  class CapacityLimitedApplicationService {
    initialize() { throw capacityError; }
  }

  const result = createBootstrapState({
    storage: {},
    repository: { initialize() { return createInitialDatabase(1); } },
    ApplicationServiceClass: CapacityLimitedApplicationService,
    exportTempFileStore: { removeAllStrict() {} }
  });

  assert.equal(result.mode, 'ready');
  assert.equal(result.recovery, null);
  assert.equal(result.recoveryError, capacityError);
  assert.equal(result.applicationService instanceof CapacityLimitedApplicationService, true);
});

test('bootstrap 在 ready 与恢复模式复用并暴露同一个偏好存储', () => {
  const preferences = { kind: 'preferences' };
  let readyPreferenceStore;
  class FakeApplicationService {
    constructor(repository, options) { readyPreferenceStore = options.preferenceStore; }
    initialize() { return null; }
  }
  const ready = createBootstrapState({
    repository: { initialize() { return createInitialDatabase(1); } },
    storage: {},
    preferenceStore: preferences,
    ApplicationServiceClass: FakeApplicationService,
    exportTempFileStore: { removeAllStrict() {} }
  });

  let recoveryPreferenceStore;
  class FakeDataRecoveryService {
    constructor(options) { recoveryPreferenceStore = options.preferenceStore; }
  }
  const recovery = createBootstrapState({
    repository: { initialize() { throw new StorageError('DATA_CORRUPTED', 'safe'); } },
    storage: {},
    preferenceStore: preferences,
    DataRecoveryServiceClass: FakeDataRecoveryService,
    exportTempFileStore: { removeAllStrict() {} }
  });

  assert.equal(ready.preferences, preferences);
  assert.equal(readyPreferenceStore, preferences);
  assert.equal(recovery.preferences, preferences);
  assert.equal(recoveryPreferenceStore, preferences);
});

test('首版云端存储端口保持禁用并返回固定产品文案', () => {
  const ports = createDisabledPorts({
    read() { return createInitialDatabase(1); }
  });

  assert.throws(
    () => ports.sync.execute(),
    (error) => error.code === 'FEATURE_UNAVAILABLE'
      && error.message === '当前版本暂不支持云端存储'
  );
});

test('损坏、版本与迁移故障进入独立恢复模式且不构造应用服务', () => {
  for (const code of [
    'DATA_CORRUPTED',
    'DATA_VERSION_UNSUPPORTED',
    'MIGRATION_PATH_MISSING',
    'MIGRATION_FAILED',
    'MIGRATION_ROLLBACK_UNCERTAIN'
  ]) {
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

test('app 把冷启动与回前台的容量恢复失败路由到容量出口而不抛生命周期异常', () => {
  const appPath = require.resolve('../miniprogram/app.js');
  const previousApp = global.App;
  const previousWx = global.wx;
  const previousGetApp = global.getApp;
  const capacityError = new StorageError(
    'STORAGE_CAPACITY_EXCEEDED',
    '本地资料库已达到容量上限'
  );
  const calls = { actionSheets: [], recoverTimer: 0, modals: [] };
  let appDefinition;
  global.App = (definition) => { appDefinition = definition; };
  global.wx = {
    showActionSheet(options) { calls.actionSheets.push(options); },
    showModal(options) { calls.modals.push(options); },
    showToast() {}
  };
  try {
    delete require.cache[appPath];
    require(appPath);
    global.getApp = () => appDefinition;
    appDefinition.globalData.bootstrap = {
      mode: 'ready',
      recoveryError: capacityError,
      applicationService: {
        recoverTimer() {
          calls.recoverTimer += 1;
          throw capacityError;
        },
        storageUsage() { return { warning: true, percent: 100 }; }
      }
    };

    assert.doesNotThrow(() => appDefinition.onShow());
    assert.equal(calls.recoverTimer, 0);
    assert.equal(calls.actionSheets.length, 1);
    assert.equal(appDefinition.globalData.bootstrap.recoveryError, null);

    assert.doesNotThrow(() => appDefinition.onShow());
    assert.equal(calls.recoverTimer, 1);
    assert.equal(calls.actionSheets.length, 2);
    assert.equal(calls.modals.length, 0);
  } finally {
    delete require.cache[appPath];
    if (previousApp === undefined) delete global.App; else global.App = previousApp;
    if (previousWx === undefined) delete global.wx; else global.wx = previousWx;
    if (previousGetApp === undefined) delete global.getApp; else global.getApp = previousGetApp;
  }
});

test('app 只在容量达到 90% 后每会话提示一次，并在降到阈值下后允许再次提示', () => {
  const appPath = require.resolve('../miniprogram/app.js');
  const previousApp = global.App;
  const previousWx = global.wx;
  let appDefinition;
  let usage = { percent: 89.9, warning: false };
  const calls = { modals: [], switchTabs: [] };
  global.App = (definition) => { appDefinition = definition; };
  global.wx = {
    showModal(options) { calls.modals.push(options); },
    switchTab(options) { calls.switchTabs.push(options); }
  };
  try {
    delete require.cache[appPath];
    require(appPath);
    appDefinition.globalData.bootstrap = {
      mode: 'ready',
      applicationService: {
        recoverTimer() { return { status: 'idle' }; },
        storageUsage() { return usage; }
      }
    };

    appDefinition.onShow();
    assert.equal(calls.modals.length, 0);

    usage = { percent: 90, warning: true };
    appDefinition.onShow();
    appDefinition.onShow();
    assert.equal(calls.modals.length, 1);
    assert.equal(calls.modals[0].confirmText, '去备份');
    calls.modals[0].success({ confirm: true, cancel: false });
    assert.deepEqual(calls.switchTabs, [{ url: '/pages/profile/index' }]);

    usage = { percent: 89.9, warning: false };
    appDefinition.onShow();
    usage = { percent: 90, warning: true };
    appDefinition.onShow();
    assert.equal(calls.modals.length, 2);
  } finally {
    delete require.cache[appPath];
    if (previousApp === undefined) delete global.App; else global.App = previousApp;
    if (previousWx === undefined) delete global.wx; else global.wx = previousWx;
  }
});

test('app 读取容量失败只记录脱敏告警且不阻断 onShow', () => {
  const appPath = require.resolve('../miniprogram/app.js');
  const previousApp = global.App;
  const previousConsoleWarn = console.warn;
  let appDefinition;
  const warnings = [];
  global.App = (definition) => { appDefinition = definition; };
  console.warn = (...args) => warnings.push(args);
  try {
    delete require.cache[appPath];
    require(appPath);
    appDefinition.globalData.bootstrap = {
      mode: 'ready',
      applicationService: {
        recoverTimer() { return { status: 'idle' }; },
        storageUsage() { throw new Error('sensitive storage detail'); }
      }
    };

    assert.doesNotThrow(() => appDefinition.onShow());
    assert.deepEqual(warnings, [['本地资料库用量读取失败']]);
  } finally {
    delete require.cache[appPath];
    if (previousApp === undefined) delete global.App; else global.App = previousApp;
    console.warn = previousConsoleWarn;
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
