const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { StorageError } = require('../miniprogram/domain/errors');
const { getService, getRecoveryService } = require('../miniprogram/utils/page');

const pagePath = require.resolve('../miniprogram/pages/data-recovery/index.js');
const wxmlPath = path.join(__dirname, '../miniprogram/pages/data-recovery/index.wxml');
const wxssPath = path.join(__dirname, '../miniprogram/pages/data-recovery/index.wxss');

function loadPage() {
  let page;
  const originalPage = global.Page;
  global.Page = (definition) => { page = definition; };
  delete require.cache[pagePath];
  require(pagePath);
  global.Page = originalPage;
  return page;
}

function createHarness(options = {}) {
  const originalWx = global.wx;
  const originalGetApp = global.getApp;
  const calls = {
    exportRawData: 0,
    prepareReplacement: [],
    cancelReplacement: [],
    commitReplacement: [],
    clearAllData: [],
    writeFile: [],
    shareFileMessage: [],
    chooseMessageFile: [],
    readFile: [],
    actionSheets: [],
    switchTabs: [],
    modals: [],
    reLaunch: [],
    toasts: [],
    rebuildBootstrap: 0
  };
  calls.unlink = [];
  let prepareIndex = 0;
  const service = {
    exportRawData() {
      calls.exportRawData += 1;
      return '{ "private": true }';
    },
    prepareReplacement(jsonText) {
      calls.prepareReplacement.push(jsonText);
      const prepareError = options.prepareErrors
        ? options.prepareErrors[Math.min(prepareIndex, options.prepareErrors.length - 1)]
        : options.prepareError;
      prepareIndex += 1;
      if (prepareError) throw prepareError;
      return {
        token: 'replacement_1', schemaVersion: 1,
        addedCounts: { wishes: 1 }, repairedReferenceCount: 2,
        discardedExceptionCount: 0, resetsRuntime: true
      };
    },
    cancelReplacement(token) {
      calls.cancelReplacement.push(token);
    },
    commitReplacement(token) {
      calls.commitReplacement.push(token);
      if (options.commitError) throw options.commitError;
      return { replaced: true };
    },
    clearAllData(confirmed) {
      calls.clearAllData.push(confirmed);
      if (options.clearError) throw options.clearError;
      return { cleared: true };
    }
  };
  const app = {
    globalData: {
      bootstrap: {
        mode: options.bootstrapMode || 'data-recovery',
        recoveryReason: options.reason || 'DATA_CORRUPTED',
        recoveryService: service
      }
    },
    rebuildBootstrap() {
      calls.rebuildBootstrap += 1;
      this.globalData.bootstrap = { mode: 'ready', applicationService: {} };
      return this.globalData.bootstrap;
    }
  };
  global.getApp = () => app;
  let readIndex = 0;
  let chooseIndex = 0;
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getFileSystemManager() {
      return {
        writeFile(callbacks) {
          calls.writeFile.push(callbacks);
          (options.writeResult || ((value) => value.success()))(callbacks);
        },
        unlink(callbacks) {
          calls.unlink.push(callbacks);
          (options.unlinkResult || ((value) => value.success()))(callbacks);
        },
        readFile(callbacks) {
          calls.readFile.push(callbacks);
          const result = options.readResults
            ? options.readResults[Math.min(readIndex, options.readResults.length - 1)]
            : options.readResult;
          readIndex += 1;
          (result || ((value) => value.success({ data: '{"schemaVersion":1}' })))(callbacks);
        }
      };
    },
    chooseMessageFile(callbacks) {
      calls.chooseMessageFile.push(callbacks);
      const result = options.chooseResults
        ? options.chooseResults[Math.min(chooseIndex, options.chooseResults.length - 1)]
        : null;
      chooseIndex += 1;
      (result || ((value) => value.success({ tempFiles: [{ path: 'wxfile://backup.json' }] })))(callbacks);
    },
    shareFileMessage(callbacks) {
      calls.shareFileMessage.push(callbacks);
      if (options.shareThrows) throw options.shareThrows;
    },
    showModal(callbacks) {
      calls.modals.push(callbacks);
      const index = calls.modals.length - 1;
      const result = (options.modalResults || [true, true])[index];
      callbacks.success({ confirm: result === true, cancel: result !== true });
    },
    showActionSheet(callbacks) {
      calls.actionSheets.push(callbacks);
      (options.actionSheetResult || ((value) => value.success({ tapIndex: 0 })))(callbacks);
    },
    showToast(callbacks) { calls.toasts.push(callbacks); },
    reLaunch(callbacks) { calls.reLaunch.push(callbacks); },
    switchTab(callbacks) { calls.switchTabs.push(callbacks); }
  };

  const page = loadPage();
  page.setData = (updates) => Object.assign(page.data, updates);
  page.onLoad();
  return {
    page,
    calls,
    restore() {
      if (originalWx === undefined) delete global.wx; else global.wx = originalWx;
      if (originalGetApp === undefined) delete global.getApp; else global.getApp = originalGetApp;
      delete require.cache[pagePath];
    }
  };
}

test('恢复页按故障原因展示不同标题且不依赖应用服务', () => {
  const cases = [
    ['DATA_CORRUPTED', '本地数据损坏', '当前本地数据无法安全读取'],
    ['DATA_VERSION_UNSUPPORTED', '数据来自较新版本', '当前小程序无法安全读取这份本地数据。'],
    ['MIGRATION_PATH_MISSING', '缺少数据升级步骤', '原始数据未被覆盖，请先导出原始数据并等待支持该版本的升级。'],
    ['MIGRATION_FAILED', '数据升级未完成', '升级失败后已恢复原始数据，请先导出核对再选择恢复方式。'],
    ['MIGRATION_ROLLBACK_UNCERTAIN', '无法确认数据是否完整', '请立即导出原始数据核对，不要继续业务写入。']
  ];

  for (const [reason, title, explanation] of cases) {
    const harness = createHarness({ reason });
    try {
      assert.equal(harness.page.data.title, title, reason);
      assert.match(harness.page.data.explanation, new RegExp(explanation), reason);
    } finally { harness.restore(); }
  }
});

test('恢复页在非恢复模式下返回计时页，不加载恢复内容', () => {
  const harness = createHarness({ bootstrapMode: 'ready' });
  try {
    assert.deepEqual(harness.calls.reLaunch, [{ url: '/pages/timer/index' }]);
    assert.equal(harness.page.data.title, '本地数据损坏');
    assert.equal(harness.page.data.explanation, '');
    assert.equal(harness.calls.exportRawData, 0);
  } finally { harness.restore(); }
});

test('页面服务访问器严格隔离 ready 与 data-recovery 模式', () => {
  const originalGetApp = global.getApp;
  const recoveryService = { kind: 'recovery' };
  try {
    global.getApp = () => ({
      globalData: { bootstrap: { mode: 'data-recovery', recoveryService } }
    });
    assert.equal(getRecoveryService(), recoveryService);
    assert.throws(() => getService(), /等待恢复/);

    const applicationService = { kind: 'application' };
    global.getApp = () => ({
      globalData: { bootstrap: { mode: 'ready', applicationService } }
    });
    assert.equal(getService(), applicationService);
    assert.throws(() => getRecoveryService(), /不处于数据恢复模式/);
  } finally {
    if (originalGetApp === undefined) delete global.getApp; else global.getApp = originalGetApp;
  }
});

test('原始数据先写入救援文件，只有第二次按钮点击才同步调用文件发送', () => {
  const harness = createHarness();
  try {
    harness.page.exportRawData();
    assert.equal(harness.calls.exportRawData, 1);
    assert.equal(harness.calls.writeFile.length, 1);
    assert.equal(harness.calls.shareFileMessage.length, 0);
    assert.equal(harness.page.data.rescueFileReady, true);

    harness.page.shareRawData();
    assert.equal(harness.calls.shareFileMessage.length, 1);
    assert.equal(harness.calls.shareFileMessage[0].filePath, harness.page.data.rescueFilePath);
  } finally { harness.restore(); }
});

test('救援文件在发送成功、取消或失败后都删除，且取消不提示失败', () => {
  const cases = [
    { label: '发送成功', settle: (callbacks) => callbacks.success?.({ errMsg: 'shareFileMessage:ok' }), expectFailureToast: false },
    { label: '用户取消', settle: (callbacks) => callbacks.fail?.({ errMsg: 'shareFileMessage:fail cancel' }), expectFailureToast: false },
    { label: '发送失败', settle: (callbacks) => callbacks.fail?.({ errMsg: 'shareFileMessage:fail network' }), expectFailureToast: true }
  ];

  for (const item of cases) {
    const harness = createHarness();
    try {
      harness.page.exportRawData();
      const filePath = harness.page.data.rescueFilePath;
      harness.page.shareRawData();
      const callbacks = harness.calls.shareFileMessage[0];
      item.settle(callbacks);
      if (callbacks.complete) callbacks.complete();
      if (callbacks.complete) callbacks.complete();

      assert.equal(harness.calls.unlink.length, 1, item.label);
      assert.equal(harness.calls.unlink[0].filePath, filePath, item.label);
      assert.equal(harness.page.data.rescueFileReady, false, item.label);
      assert.equal(harness.page.data.rescueFilePath, '', item.label);
      assert.equal(harness.page.data.rescueFileName, '', item.label);
      assert.equal(
        harness.calls.toasts.some((toast) => toast.title === '发送失败，请重试'),
        item.expectFailureToast,
        item.label
      );
    } finally { harness.restore(); }
  }
});

test('文件发送同步抛错时删除救援文件并显示固定错误文案', () => {
  const harness = createHarness({ shareThrows: new Error('private wxfile://usr/secret.json') });
  try {
    harness.page.exportRawData();
    const filePath = harness.page.data.rescueFilePath;

    assert.doesNotThrow(() => harness.page.shareRawData());

    assert.equal(harness.calls.unlink.length, 1);
    assert.equal(harness.calls.unlink[0].filePath, filePath);
    assert.equal(harness.page.data.rescueFileReady, false);
    assert.equal(harness.page.data.rescueFilePath, '');
    assert.equal(harness.page.data.rescueFileName, '');
    assert.equal(
      harness.calls.toasts.some((toast) => toast.title === '发送失败，请重试'),
      true
    );
    assert.equal(
      harness.calls.toasts.some((toast) => /private|secret|wxfile/i.test(toast.title)),
      false
    );
  } finally { harness.restore(); }
});

test('救援文件删除失败只记录固定告警，不把发送成功误报为失败', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const harness = createHarness({
    unlinkResult: (callbacks) => callbacks.fail({
      errMsg: 'unlink:fail wxfile://usr/secret.json raw filesystem error'
    })
  });
  try {
    harness.page.exportRawData();
    harness.page.shareRawData();
    const callbacks = harness.calls.shareFileMessage[0];
    callbacks.success?.({ errMsg: 'shareFileMessage:ok' });
    if (callbacks.complete) callbacks.complete();

    assert.equal(harness.calls.unlink.length, 1);
    assert.deepEqual(warnings, [['救援临时文件清理失败']]);
    assert.equal(
      harness.calls.toasts.some((toast) => toast.title === '发送失败，请重试'),
      false
    );
    assert.equal(
      JSON.stringify(warnings).includes('wxfile://usr/secret.json'),
      false
    );
    assert.equal(
      JSON.stringify(warnings).includes('raw filesystem error'),
      false
    );
  } finally {
    harness.restore();
    console.warn = originalWarn;
  }
});

test('选择 JSON 后只准备预览，明确确认后才覆盖并回到计时页', () => {
  const harness = createHarness();
  try {
    harness.page.chooseReplacementFile();
    assert.deepEqual(harness.calls.prepareReplacement, ['{"schemaVersion":1}']);
    assert.equal(harness.calls.commitReplacement.length, 0);
    assert.equal(harness.page.data.replacementPreview.resetsRuntime, true);

    harness.page.confirmReplacement();
    assert.deepEqual(harness.calls.commitReplacement, ['replacement_1']);
    assert.equal(harness.calls.rebuildBootstrap, 1);
    assert.deepEqual(harness.calls.reLaunch, [{ url: '/pages/timer/index' }]);
  } finally { harness.restore(); }
});

test('覆盖提交失败后完整清除失效预览并要求重新选择文件', () => {
  const harness = createHarness({ commitError: new Error('write failed') });
  try {
    harness.page.chooseReplacementFile();
    assert.equal(harness.page.data.replacementToken, 'replacement_1');
    assert.notEqual(harness.page.data.replacementPreview, null);
    assert.equal(harness.page.data.replacementAddedCount, 1);

    harness.page.confirmReplacement();

    assert.deepEqual(harness.calls.commitReplacement, ['replacement_1']);
    assert.equal(harness.page.data.replacementToken, null);
    assert.equal(harness.page.data.replacementPreview, null);
    assert.equal(harness.page.data.replacementAddedCount, 0);
    assert.equal(harness.page.data.busy, false);
    assert.equal(harness.calls.rebuildBootstrap, 0);
    assert.equal(harness.calls.reLaunch.length, 0);
    assert.equal(
      harness.calls.toasts.some((toast) => (
        toast.title === 'write failed' && toast.icon === 'none'
      )),
      true
    );
  } finally { harness.restore(); }
});

test('恢复覆盖超过容量时保留安全结论并把导出出口留在恢复页', () => {
  const harness = createHarness({
    commitError: new StorageError(
      'STORAGE_CAPACITY_EXCEEDED',
      '本地资料库已达到容量上限，请先导出备份'
    )
  });
  try {
    harness.page.chooseReplacementFile();
    harness.page.confirmReplacement();

    assert.deepEqual(harness.calls.actionSheets[0].itemList, [
      '前往恢复页导出原始数据',
      '转为云端存储'
    ]);
    assert.deepEqual(harness.calls.reLaunch, [{ url: '/pages/data-recovery/index' }]);
    assert.deepEqual(harness.calls.switchTabs, []);
    assert.equal(
      harness.calls.toasts.some((toast) => toast.title === '恢复预览已失效，请重新选择 JSON 文件'),
      false
    );
  } finally { harness.restore(); }
});

test('恢复模式容量出口的云端选项始终显示固定禁用文案', () => {
  const harness = createHarness({
    commitError: new StorageError('STORAGE_CAPACITY_EXCEEDED', '容量不足'),
    actionSheetResult: (callbacks) => callbacks.success({ tapIndex: 1 })
  });
  try {
    harness.page.chooseReplacementFile();
    harness.page.confirmReplacement();

    assert.equal(harness.calls.toasts.at(-1).title, '当前版本暂不支持云端存储');
    assert.deepEqual(harness.calls.switchTabs, []);
  } finally { harness.restore(); }
});

test('重新选择文件时立即作废旧预览，失败或无有效文件均不能提交旧文件', () => {
  const scenarios = [
    {
      label: '读取失败',
      options: {
        readResults: [
          (callbacks) => callbacks.success({ data: '{"schemaVersion":1}' }),
          (callbacks) => callbacks.fail({ errMsg: 'readFile:fail io error' }),
          (callbacks) => callbacks.success({ data: '{"schemaVersion":1}' })
        ]
      }
    },
    {
      label: '无有效文件',
      options: {
        chooseResults: [
          (callbacks) => callbacks.success({ tempFiles: [{ path: 'wxfile://a.json' }] }),
          (callbacks) => callbacks.success({ tempFiles: [{}] }),
          (callbacks) => callbacks.success({ tempFiles: [{ path: 'wxfile://c.json' }] })
        ]
      }
    }
  ];

  for (const scenario of scenarios) {
    const harness = createHarness(scenario.options);
    try {
      harness.page.chooseReplacementFile();
      assert.equal(harness.page.data.replacementToken, 'replacement_1', scenario.label);

      harness.page.chooseReplacementFile();

      assert.deepEqual(harness.calls.cancelReplacement, ['replacement_1'], scenario.label);
      assert.equal(harness.page.data.replacementToken, null, scenario.label);
      assert.equal(harness.page.data.replacementPreview, null, scenario.label);
      assert.equal(harness.page.data.replacementAddedCount, 0, scenario.label);
      assert.equal(harness.page.data.busy, false, scenario.label);
      harness.page.confirmReplacement();
      assert.deepEqual(harness.calls.commitReplacement, [], scenario.label);

      harness.page.chooseReplacementFile();
      assert.equal(harness.page.data.replacementToken, 'replacement_1', scenario.label);
      assert.notEqual(harness.page.data.replacementPreview, null, scenario.label);
    } finally { harness.restore(); }
  }
});

test('重新选择后取消、解析失败或读取同步抛错都不能恢复旧预览，且可再次选择', () => {
  const cases = [
    {
      label: '取消选择',
      options: {
        chooseResults: [
          (callbacks) => callbacks.success({ tempFiles: [{ path: 'wxfile://a.json' }] }),
          (callbacks) => callbacks.fail({ errMsg: 'chooseMessageFile:fail cancel' }),
          (callbacks) => callbacks.success({ tempFiles: [{ path: 'wxfile://c.json' }] })
        ]
      },
      expectToast: '未选择 JSON 文件，请重新选择'
    },
    {
      label: '解析失败',
      options: {
        prepareErrors: [null, new Error('invalid json'), null]
      },
      expectToast: 'JSON 文件无效，请重新选择'
    }
  ];

  for (const item of cases) {
    const harness = createHarness(item.options);
    try {
      harness.page.chooseReplacementFile();
      harness.page.chooseReplacementFile();
      assert.equal(harness.page.data.replacementToken, null, item.label);
      assert.equal(harness.page.data.replacementPreview, null, item.label);
      assert.equal(harness.page.data.replacementAddedCount, 0, item.label);
      assert.equal(harness.page.data.busy, false, item.label);
      harness.page.confirmReplacement();
      assert.deepEqual(harness.calls.commitReplacement, [], item.label);
      assert.equal(harness.calls.toasts.some((toast) => toast.title === item.expectToast), true, item.label);

      harness.page.chooseReplacementFile();
      assert.equal(harness.page.data.replacementToken, 'replacement_1', item.label);
    } finally { harness.restore(); }
  }

  let delayedSelection;
  const syncReadFailure = createHarness({
    chooseResults: [
      (callbacks) => callbacks.success({ tempFiles: [{ path: 'wxfile://a.json' }] }),
      (callbacks) => { delayedSelection = callbacks; },
      (callbacks) => callbacks.success({ tempFiles: [{ path: 'wxfile://c.json' }] })
    ],
    readResults: [
      (callbacks) => callbacks.success({ data: '{"schemaVersion":1}' }),
      () => { throw new Error('readFile sync failure'); },
      (callbacks) => callbacks.success({ data: '{"schemaVersion":1}' })
    ]
  });
  try {
    syncReadFailure.page.chooseReplacementFile();
    syncReadFailure.page.chooseReplacementFile();
    assert.doesNotThrow(() => delayedSelection.success({ tempFiles: [{ path: 'wxfile://b.json' }] }));
    assert.equal(syncReadFailure.page.data.replacementToken, null);
    assert.equal(syncReadFailure.page.data.replacementPreview, null);
    assert.equal(syncReadFailure.page.data.replacementAddedCount, 0);
    assert.equal(syncReadFailure.page.data.busy, false);
    syncReadFailure.page.confirmReplacement();
    assert.deepEqual(syncReadFailure.calls.commitReplacement, []);
    assert.equal(
      syncReadFailure.calls.toasts.some((toast) => toast.title === '读取 JSON 失败，请重新选择文件'),
      true
    );

    syncReadFailure.page.chooseReplacementFile();
    assert.equal(syncReadFailure.page.data.replacementToken, 'replacement_1');
  } finally { syncReadFailure.restore(); }
});

test('清空需要连续两次确认，任一次取消都不执行', () => {
  for (const modalResults of [[false], [true, false]]) {
    const harness = createHarness({ modalResults });
    try {
      harness.page.clearAndRestart();
      assert.deepEqual(harness.calls.clearAllData, []);
    } finally { harness.restore(); }
  }

  const confirmed = createHarness({ modalResults: [true, true] });
  try {
    confirmed.page.clearAndRestart();
    assert.deepEqual(confirmed.calls.clearAllData, [true]);
    assert.equal(confirmed.calls.rebuildBootstrap, 1);
  } finally { confirmed.restore(); }
});

test('恢复页结构只提供三项恢复动作且没有被排除的入口', () => {
  const wxml = fs.readFileSync(wxmlPath, 'utf8');
  const wxss = fs.readFileSync(wxssPath, 'utf8');
  const source = `${fs.readFileSync(pagePath, 'utf8')}\n${wxml}\n${wxss}`;

  assert.match(wxml, /导出原始数据/);
  assert.match(wxml, /从 Plan & Record JSON 恢复/);
  assert.match(wxml, /清空并重新开始/);
  assert.match(wxss, /padding-bottom:\s*calc\([^)]*env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(source, /重新检测|incremental|merge|冲突策略/);
});
