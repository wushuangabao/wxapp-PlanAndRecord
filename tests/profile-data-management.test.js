const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialDatabase } = require('../miniprogram/domain/entities');

const profilePagePath = require.resolve('../miniprogram/pages/profile/index.js');
const profileWxmlPath = path.join(__dirname, '../miniprogram/pages/profile/index.wxml');
const profileWxssPath = path.join(__dirname, '../miniprogram/pages/profile/index.wxss');
const FIXED_NOW = new Date(2026, 6, 28, 12, 34, 56).getTime();

function loadProfilePage() {
  let page;
  const originalPage = global.Page;
  global.Page = (definition) => { page = definition; };
  delete require.cache[profilePagePath];
  require(profilePagePath);
  global.Page = originalPage;
  return page;
}

function defaultStatistics() {
  return {
    tags: [],
    projects: [],
    planVariance: { events: [] },
    overlaps: [],
    weeklyReview: null
  };
}

function createHarness(options = {}) {
  const originalWx = global.wx;
  const originalGetApp = global.getApp;
  const originalDateNow = Date.now;
  const originalConsoleInfo = console.info;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  let userTapDepth = 0;
  let actionSheetIndex = 0;
  let modalIndex = 0;
  let previewIndex = 0;

  const calls = {
    canIUse: [],
    writeFile: [],
    readFile: [],
    shareFileMessage: [],
    shareUserTapContexts: [],
    chooseMessageFile: [],
    actionSheets: [],
    readdirSync: [],
    unlink: [],
    unlinkSync: [],
    openDocument: [],
    toasts: [],
    modals: [],
    infos: [],
    warnings: [],
    errors: [],
    refreshes: 0,
    service: {
      exportJson: 0,
      prepareJsonImport: [],
      previewJsonImport: [],
      commitJsonImport: [],
      cancelJsonImport: [],
      clearAllData: []
    }
  };

  const service = {
    snapshot: () => createInitialDatabase(FIXED_NOW),
    statistics: () => options.statistics || defaultStatistics(),
    exportJson() {
      calls.service.exportJson += 1;
      return '{"schemaVersion":1}';
    },
    prepareJsonImport(jsonText) {
      calls.service.prepareJsonImport.push(jsonText);
      if (options.prepareError) throw options.prepareError;
      return options.preparedImport || {
        token: 'import_1',
        schemaVersion: 1,
        sourceCounts: {}
      };
    },
    previewJsonImport(token, previewOptions) {
      calls.service.previewJsonImport.push({ token, options: previewOptions });
      const previews = options.previewResults || [{
        mode: previewOptions.mode,
        conflictPolicy: previewOptions.conflictPolicy || null,
        conflictCount: 0,
        repairedReferenceCount: 0,
        addedCounts: { wishes: 1 },
        requiresConflictPolicy: false
      }];
      const preview = previews[Math.min(previewIndex, previews.length - 1)];
      previewIndex += 1;
      if (preview instanceof Error) throw preview;
      return preview;
    },
    commitJsonImport(token) {
      calls.service.commitJsonImport.push(token);
      if (options.commitError) throw options.commitError;
      return { importedCount: 1 };
    },
    cancelJsonImport(token) {
      calls.service.cancelJsonImport.push(token);
      if (options.cancelError) throw options.cancelError;
    },
    clearAllData(confirmed) {
      calls.service.clearAllData.push(confirmed);
      if (options.clearError) throw options.clearError;
      return { cleared: true };
    }
  };

  const fileSystemManager = {
    writeFile(writeOptions) {
      calls.writeFile.push(writeOptions);
      (options.writeResult || ((callbacks) => callbacks.success()))(writeOptions);
    },
    readFile(readOptions) {
      calls.readFile.push(readOptions);
      (options.readResult || ((callbacks) => callbacks.success({ data: '{"schemaVersion":1}' })))(readOptions);
    },
    getFileInfo(fileInfoOptions) {
      fileInfoOptions.success({ size: 128 });
    },
    readdirSync(dirPath) {
      calls.readdirSync.push(dirPath);
      return options.directoryFiles || [];
    },
    unlink(unlinkOptions) {
      calls.unlink.push(unlinkOptions.filePath);
      (options.unlinkResult || ((callbacks) => {
        if (callbacks.success) callbacks.success();
      }))(unlinkOptions);
    },
    unlinkSync(filePath) {
      calls.unlinkSync.push(filePath);
      if (options.unlinkSyncResult) options.unlinkSyncResult(filePath, calls.unlinkSync.length);
    }
  };

  Date.now = () => FIXED_NOW;
  global.getApp = () => ({
    globalData: {
      bootstrap: { applicationService: service }
    }
  });
  console.info = (...args) => calls.infos.push(args);
  console.warn = (...args) => calls.warnings.push(args);
  console.error = (...args) => calls.errors.push(args);
  global.wx = {
    env: { USER_DATA_PATH: 'http://usr' },
    canIUse(api) {
      calls.canIUse.push(api);
      return options.canShareFile !== false;
    },
    getFileSystemManager() {
      if (options.fileSystemManagerResult) {
        return options.fileSystemManagerResult(fileSystemManager);
      }
      return fileSystemManager;
    },
    chooseMessageFile(chooseOptions) {
      calls.chooseMessageFile.push(chooseOptions);
      (options.chooseResult || ((callbacks) => callbacks.success({
        tempFiles: [{
          name: 'backup.json',
          path: 'wxfile://backup.json',
          size: 2048,
          time: 1,
          type: 'file'
        }],
        errMsg: 'chooseMessageFile:ok'
      })))(chooseOptions);
    },
    shareFileMessage(shareOptions) {
      calls.shareFileMessage.push(shareOptions);
      calls.shareUserTapContexts.push(userTapDepth > 0);
      (options.shareResult || ((callbacks) => {
        callbacks.success();
        callbacks.complete();
      }))(shareOptions);
    },
    openDocument(openOptions) {
      calls.openDocument.push(openOptions);
      if (openOptions.success) openOptions.success();
    },
    showToast(toastOptions) {
      calls.toasts.push(toastOptions);
    },
    showActionSheet(actionOptions) {
      calls.actionSheets.push(actionOptions);
      const results = options.actionSheetResults || [];
      const result = results[actionSheetIndex];
      actionSheetIndex += 1;
      (result || ((callbacks) => callbacks.success({ tapIndex: 0, errMsg: 'showActionSheet:ok' })))(actionOptions);
    },
    showModal(modalOptions) {
      calls.modals.push(modalOptions);
      if (modalOptions.title === '请选择并勾选 JSON 文件') {
        (options.importGuidanceResult || ((callbacks) => callbacks.success({
          confirm: true,
          cancel: false,
          errMsg: 'showModal:ok'
        })))(modalOptions);
        return;
      }
      const results = options.modalResults || (options.modalResult ? [options.modalResult] : []);
      const result = results[modalIndex];
      modalIndex += 1;
      (result || ((callbacks) => callbacks.success({
        confirm: true,
        cancel: false,
        errMsg: 'showModal:ok'
      })))(modalOptions);
    }
  };

  const page = loadProfilePage();
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };
  if (!options.keepPageRefresh) {
    page.refresh = () => { calls.refreshes += 1; };
  }

  function invokeUserTap(callback) {
    userTapDepth += 1;
    try {
      callback();
    } finally {
      userTapDepth -= 1;
    }
  }

  function restore() {
    global.wx = originalWx;
    global.getApp = originalGetApp;
    Date.now = originalDateNow;
    console.info = originalConsoleInfo;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
  }

  return { calls, fileSystemManager, invokeUserTap, page, restore, service };
}

test('用户页用标签投入替代分类管理，并区分派生无标签桶与同名字面标签', () => {
  const statistics = {
    ...defaultStatistics(),
    tags: [{
      id: 'untagged',
      tag: null,
      name: '无标签',
      isUntagged: true,
      durationMinutes: 25,
      count: 1
    }, {
      id: 'tag:无标签',
      tag: '无标签',
      name: '无标签',
      isUntagged: false,
      durationMinutes: 15,
      count: 1
    }]
  };
  const harness = createHarness({ keepPageRefresh: true, statistics });
  try {
    harness.page.refresh();

    assert.deepEqual(
      harness.page.data.tagStats.map((item) => item.displayName),
      ['无标签', '#无标签']
    );

    const wxml = fs.readFileSync(profileWxmlPath, 'utf8');
    const wxss = fs.readFileSync(profileWxssPath, 'utf8');
    assert.match(wxml, /标签投入/);
    assert.match(wxml, /一条记录有多个标签时，完整耗时会分别计入每个标签/);
    assert.match(wxml, /\{\{item\.displayName\}\}/);
    assert.doesNotMatch(wxml, /分类投入|分类管理|新增分类|归档分类/);
    assert.doesNotMatch(wxss, /\.category-row/);
  } finally {
    harness.restore();
  }
});

test('M5：数据管理区只暴露 JSON 导出、JSON 导入和危险清空按钮', () => {
  const wxml = fs.readFileSync(profileWxmlPath, 'utf8');
  const wxss = fs.readFileSync(profileWxssPath, 'utf8');

  assert.equal((wxml.match(/>导出 JSON</g) || []).length, 1);
  assert.equal((wxml.match(/>导入 JSON</g) || []).length, 1);
  assert.equal((wxml.match(/>清空数据</g) || []).length, 1);
  assert.match(wxml, /bindtap="importJson"/);
  assert.match(wxml, /bindtap="clearData"/);
  assert.match(wxml, /class="danger"/);
  assert.equal((wxml.match(/disabled="\{\{dataOperationInProgress\}\}"/g) || []).length, 3);
  assert.doesNotMatch(wxml, /CSV|exportCsv|exportInProgress|日志同步/);
  assert.match(wxss, /\.danger\s*\{[^}]*background:\s*#fee2e2;[^}]*color:\s*#b91c1c;/);
});

test('M5：JSON 导出在二次确认的用户点击回调中直接发送并清理临时文件', () => {
  let confirmation;
  const harness = createHarness({
    modalResults: [(callbacks) => { confirmation = callbacks; }]
  });
  try {
    harness.page.exportJson();

    assert.equal(harness.calls.writeFile.length, 1);
    assert.equal(harness.calls.writeFile[0].filePath, 'http://usr/plan-and-record-share.json');
    assert.equal(harness.calls.shareFileMessage.length, 0);
    assert.match(harness.calls.modals[0].content, /文件传输助手/);
    assert.match(harness.calls.modals[0].content, /手动导入/);
    assert.doesNotMatch(harness.calls.modals[0].content, /不能导入/);
    assert.equal(harness.page.data.dataOperationInProgress, true);

    harness.invokeUserTap(() => confirmation.success({ confirm: true, cancel: false }));

    assert.equal(harness.calls.shareFileMessage.length, 1);
    assert.equal(harness.calls.shareUserTapContexts[0], true);
    assert.equal(harness.calls.shareFileMessage[0].fileName, 'plan-and-record-20260728-123456.json');
    assert.deepEqual(harness.calls.unlink, ['http://usr/plan-and-record-share.json']);
    assert.equal(harness.page.data.dataOperationInProgress, false);
    assert.equal(harness.calls.openDocument.length, 0);
  } finally {
    harness.restore();
  }
});

test('M5：导出确认取消静默清理，发送失败提示后清理', () => {
  const cases = [
    {
      options: {
        modalResults: [(callbacks) => callbacks.success({ confirm: false, cancel: true })]
      },
      expectedToast: null
    },
    {
      options: {
        shareResult: (callbacks) => {
          callbacks.fail({ errMsg: 'shareFileMessage:fail system error' });
          callbacks.complete();
        }
      },
      expectedToast: '发送失败，请重试'
    }
  ];

  for (const item of cases) {
    const harness = createHarness(item.options);
    try {
      harness.page.exportJson();

      assert.deepEqual(harness.calls.unlink, ['http://usr/plan-and-record-share.json']);
      assert.equal(harness.page.data.dataOperationInProgress, false);
      if (item.expectedToast) {
        assert.equal(harness.calls.toasts.some((toast) => toast.title === item.expectedToast), true);
      } else {
        assert.deepEqual(harness.calls.toasts, []);
      }
    } finally {
      harness.restore();
    }
  }
});

test('M5：导入前提示勾选文件，确认后才打开选择器，取消则释放操作锁', () => {
  let guidance;
  const confirmed = createHarness({
    importGuidanceResult: (callbacks) => { guidance = callbacks; }
  });
  try {
    confirmed.page.importJson();

    assert.equal(confirmed.calls.chooseMessageFile.length, 0);
    assert.equal(confirmed.calls.modals[0].title, '请选择并勾选 JSON 文件');
    assert.match(confirmed.calls.modals[0].content, /圆形勾选框/);
    assert.match(confirmed.calls.modals[0].content, /直接点击文件名只会尝试预览/);
    assert.equal(confirmed.calls.modals[0].confirmText, '去选择');
    assert.equal(confirmed.page.data.dataOperationInProgress, true);

    guidance.success({ confirm: true, cancel: false });
    assert.equal(confirmed.calls.chooseMessageFile.length, 1);
  } finally {
    confirmed.restore();
  }

  const cancelled = createHarness({
    importGuidanceResult: (callbacks) => callbacks.success({
      confirm: false,
      cancel: true
    })
  });
  try {
    cancelled.page.importJson();

    assert.equal(cancelled.calls.chooseMessageFile.length, 0);
    assert.equal(cancelled.page.data.dataOperationInProgress, false);
  } finally {
    cancelled.restore();
  }
});

test('M5：导入只选择一个 JSON 文件并以 UTF-8 读取后增量提交', () => {
  const harness = createHarness();
  try {
    harness.page.importJson();

    assert.equal(harness.calls.chooseMessageFile.length, 1);
    assert.equal(harness.calls.chooseMessageFile[0].count, 1);
    assert.equal(harness.calls.chooseMessageFile[0].type, 'file');
    assert.deepEqual(harness.calls.chooseMessageFile[0].extension, ['json']);
    assert.equal(harness.calls.readFile.length, 1);
    assert.equal(harness.calls.readFile[0].filePath, 'wxfile://backup.json');
    assert.equal(harness.calls.readFile[0].encoding, 'utf8');
    assert.deepEqual(harness.calls.service.previewJsonImport, [{
      token: 'import_1',
      options: { mode: 'incremental' }
    }]);
    assert.deepEqual(harness.calls.service.commitJsonImport, ['import_1']);
    assert.deepEqual(harness.calls.service.cancelJsonImport, ['import_1']);
    assert.equal(harness.calls.refreshes, 1);
    assert.equal(harness.calls.toasts.some((toast) => toast.title === '导入完成' && toast.icon === 'success'), true);
    assert.equal(harness.page.data.dataOperationInProgress, false);
  } finally {
    harness.restore();
  }
});

test('M5：冲突导入只接受一项全局策略，最终确认前不提交并显示完整摘要', () => {
  let confirmation;
  const harness = createHarness({
    actionSheetResults: [
      (callbacks) => callbacks.success({ tapIndex: 0 }),
      (callbacks) => callbacks.success({ tapIndex: 1 })
    ],
    previewResults: [
      {
        mode: 'incremental',
        conflictPolicy: null,
        conflictCount: 2,
        repairedReferenceCount: 0,
        addedCounts: { wishes: 1, tasks: 2 },
        requiresConflictPolicy: true
      },
      {
        mode: 'incremental',
        conflictPolicy: 'use-imported',
        conflictCount: 2,
        repairedReferenceCount: 3,
        addedCounts: { wishes: 1, tasks: 2 },
        requiresConflictPolicy: false
      }
    ],
    modalResults: [(callbacks) => { confirmation = callbacks; }]
  });
  try {
    harness.page.importJson();

    assert.equal(harness.calls.actionSheets.length, 2);
    assert.deepEqual(harness.calls.actionSheets[1].itemList, ['全部保留本地', '全部使用导入数据']);
    assert.deepEqual(harness.calls.service.previewJsonImport[1], {
      token: 'import_1',
      options: { mode: 'incremental', conflictPolicy: 'use-imported' }
    });
    assert.equal(harness.calls.service.commitJsonImport.length, 0);
    const finalConfirmation = harness.calls.modals.find((modal) => modal.title === '确认导入 JSON？');
    assert.match(finalConfirmation.content, /增量导入/);
    assert.match(finalConfirmation.content, /新增 3 项/);
    assert.match(finalConfirmation.content, /冲突 2 项/);
    assert.match(finalConfirmation.content, /全部使用导入数据/);
    assert.match(finalConfirmation.content, /修复了 3 个失效关联/);

    harness.invokeUserTap(() => confirmation.success({ confirm: true, cancel: false }));
    assert.deepEqual(harness.calls.service.commitJsonImport, ['import_1']);
  } finally {
    harness.restore();
  }
});

test('M5：覆盖导入映射 replace 并使用红色破坏性确认', () => {
  let confirmation;
  const harness = createHarness({
    actionSheetResults: [(callbacks) => callbacks.success({ tapIndex: 1 })],
    previewResults: [{
      mode: 'replace',
      conflictPolicy: null,
      conflictCount: 0,
      repairedReferenceCount: 1,
      addedCounts: { timeLogs: 4 },
      requiresConflictPolicy: false
    }],
    modalResults: [(callbacks) => { confirmation = callbacks; }]
  });
  try {
    harness.page.importJson();

    assert.deepEqual(harness.calls.service.previewJsonImport, [{
      token: 'import_1',
      options: { mode: 'replace' }
    }]);
    const finalConfirmation = harness.calls.modals.find((modal) => modal.title === '覆盖本地数据？');
    assert.match(finalConfirmation.content, /覆盖当前设备全部本地数据/);
    assert.match(finalConfirmation.content, /修复了 1 个失效关联/);
    assert.equal(finalConfirmation.confirmColor, '#b91c1c');
    assert.equal(harness.calls.service.commitJsonImport.length, 0);

    confirmation.success({ confirm: false, cancel: true });
    assert.deepEqual(harness.calls.service.cancelJsonImport, ['import_1']);
    assert.equal(harness.page.data.dataOperationInProgress, false);
  } finally {
    harness.restore();
  }
});

test('M5：导入各阶段取消或失败都不提交并释放操作锁', () => {
  const cases = [
    {
      name: '选择文件取消',
      options: {
        chooseResult: (callbacks) => callbacks.fail({ errMsg: 'chooseMessageFile:fail cancel' })
      },
      expectedCancelCount: 0
    },
    {
      name: '读取失败',
      options: {
        readResult: (callbacks) => callbacks.fail({ errMsg: 'readFile:fail system error' })
      },
      expectedCancelCount: 0
    },
    {
      name: 'JSON 无效',
      options: { prepareError: new Error('JSON 文件格式无效') },
      expectedCancelCount: 0
    },
    {
      name: '模式取消',
      options: {
        actionSheetResults: [
          (callbacks) => callbacks.fail({ errMsg: 'showActionSheet:fail cancel' })
        ]
      },
      expectedCancelCount: 1
    },
    {
      name: '冲突策略取消',
      options: {
        actionSheetResults: [
          (callbacks) => callbacks.success({ tapIndex: 0 }),
          (callbacks) => callbacks.fail({ errMsg: 'showActionSheet:fail cancel' })
        ],
        previewResults: [{
          mode: 'incremental',
          conflictPolicy: null,
          conflictCount: 1,
          repairedReferenceCount: 0,
          addedCounts: {},
          requiresConflictPolicy: true
        }]
      },
      expectedCancelCount: 1
    },
    {
      name: '最终确认取消',
      options: {
        modalResults: [
          (callbacks) => callbacks.success({ confirm: false, cancel: true })
        ]
      },
      expectedCancelCount: 1
    }
  ];

  for (const item of cases) {
    const harness = createHarness(item.options);
    try {
      harness.page.importJson();

      assert.equal(harness.calls.service.commitJsonImport.length, 0, item.name);
      assert.equal(harness.calls.service.cancelJsonImport.length, item.expectedCancelCount, item.name);
      assert.equal(harness.page.data.dataOperationInProgress, false, item.name);
    } finally {
      harness.restore();
    }
  }
});

test('M5：清空数据取消不写入，确认后只清空一次并在完成后刷新提示', () => {
  let cancelledConfirmation;
  const cancelled = createHarness({
    modalResults: [(callbacks) => { cancelledConfirmation = callbacks; }]
  });
  try {
    cancelled.page.clearData();
    assert.equal(cancelled.calls.modals[0].confirmColor, '#b91c1c');
    assert.match(cancelled.calls.modals[0].content, /全部用户数据/);
    assert.match(cancelled.calls.modals[0].content, /导出临时文件/);
    assert.match(cancelled.calls.modals[0].content, /无法撤销/);
    cancelledConfirmation.success({ confirm: false, cancel: true });
    assert.deepEqual(cancelled.calls.service.clearAllData, []);
    assert.equal(cancelled.page.data.dataOperationInProgress, false);
  } finally {
    cancelled.restore();
  }

  let confirmedConfirmation;
  const confirmed = createHarness({
    modalResults: [(callbacks) => { confirmedConfirmation = callbacks; }]
  });
  try {
    confirmed.page.clearData();
    confirmedConfirmation.success({ confirm: true, cancel: false });

    assert.deepEqual(confirmed.calls.service.clearAllData, [true]);
    assert.equal(confirmed.calls.refreshes, 1);
    assert.equal(confirmed.calls.toasts.some((toast) => toast.title === '数据已清空' && toast.icon === 'success'), true);
    assert.equal(confirmed.page.data.dataOperationInProgress, false);
  } finally {
    confirmed.restore();
  }
});

test('M5：清空由应用服务执行严格文件清理，页面不再追加尽力而为清理', () => {
  const harness = createHarness();
  try {
    harness.page.clearData();

    assert.deepEqual(harness.calls.service.clearAllData, [true]);
    assert.equal(harness.calls.toasts.some((toast) => toast.title === '数据已清空'), true);
    assert.equal(harness.calls.unlinkSync.length, 0);

    harness.page.onLoad();
    assert.equal(harness.calls.unlinkSync.length, 2);
  } finally {
    harness.restore();
  }
});

test('M5：严格清空失败时不刷新、不提示成功并释放操作锁', () => {
  const harness = createHarness({
    clearError: new Error('无法确认临时导出文件已清理，数据未清空，请重试')
  });
  try {
    harness.page.clearData();

    assert.deepEqual(harness.calls.service.clearAllData, [true]);
    assert.equal(harness.calls.refreshes, 0);
    assert.equal(harness.calls.toasts.some((toast) => toast.title === '数据已清空'), false);
    assert.equal(
      harness.calls.toasts.some((toast) => (
        toast.title === '无法确认临时导出文件已清理，数据未清空，请重试'
      )),
      true
    );
    assert.equal(harness.page.data.dataOperationInProgress, false);
  } finally {
    harness.restore();
  }
});

test('M5：导入、导出和清空共用一把锁', () => {
  let pendingChoose;
  const harness = createHarness({
    chooseResult: (callbacks) => { pendingChoose = callbacks; }
  });
  try {
    harness.page.importJson();
    harness.page.exportJson();
    harness.page.clearData();

    assert.equal(harness.calls.chooseMessageFile.length, 1);
    assert.equal(harness.calls.writeFile.length, 0);
    assert.equal(harness.calls.modals.length, 1);
    assert.equal(harness.calls.modals[0].title, '请选择并勾选 JSON 文件');
    assert.equal(harness.calls.toasts.filter((toast) => toast.title === '数据管理操作进行中，请稍候').length, 2);
    assert.equal(harness.page.data.dataOperationInProgress, true);

    pendingChoose.fail({ errMsg: 'chooseMessageFile:fail cancel' });
    assert.equal(harness.page.data.dataOperationInProgress, false);
  } finally {
    harness.restore();
  }
});

test('M5：旧操作的迟到回调不能推进或解锁新操作', () => {
  const pendingChoosers = [];
  const harness = createHarness({
    chooseResult: (callbacks) => pendingChoosers.push(callbacks)
  });
  try {
    harness.page.importJson();
    const firstChoose = pendingChoosers[0];
    firstChoose.fail({ errMsg: 'chooseMessageFile:fail cancel' });

    harness.page.importJson();
    assert.equal(harness.page.data.dataOperationInProgress, true);
    firstChoose.success({
      tempFiles: [{
        name: 'late.json',
        path: 'wxfile://late.json',
        size: 1,
        time: 1,
        type: 'file'
      }]
    });
    firstChoose.fail({ errMsg: 'chooseMessageFile:fail delayed error' });

    assert.equal(harness.calls.readFile.length, 0);
    assert.equal(harness.page.data.dataOperationInProgress, true);
    assert.deepEqual(harness.calls.toasts, []);
    assert.deepEqual(harness.calls.errors, []);
  } finally {
    harness.restore();
  }
});

test('M5：进入用户页只精确清理当前 JSON 和历史 JSON/CSV 临时垃圾', () => {
  const harness = createHarness({
    directoryFiles: [
      'plan-and-record-1700000000000.json',
      'plan-and-record-logs-1700000000000.csv',
      'plan-and-record-20260728.json',
      'plan-and-record-logs-20260728.csv',
      'plan-and-record-12345678901234.json',
      'database.json'
    ]
  });
  try {
    harness.page.onLoad();

    assert.deepEqual(harness.calls.readdirSync, ['http://usr']);
    assert.deepEqual(harness.calls.unlinkSync, [
      'http://usr/plan-and-record-share.json',
      'http://usr/plan-and-record-share.csv',
      'http://usr/plan-and-record-1700000000000.json',
      'http://usr/plan-and-record-logs-1700000000000.csv'
    ]);
    assert.equal(harness.calls.unlinkSync.includes('http://usr/plan-and-record-20260728.json'), false);
    assert.equal(harness.calls.unlinkSync.includes('http://usr/plan-and-record-logs-20260728.csv'), false);
    assert.equal(harness.calls.unlinkSync.includes('http://usr/plan-and-record-12345678901234.json'), false);
    assert.equal(harness.calls.unlinkSync.includes('http://usr/database.json'), false);
  } finally {
    harness.restore();
  }
});
