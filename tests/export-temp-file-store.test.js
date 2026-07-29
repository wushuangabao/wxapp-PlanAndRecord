const test = require('node:test');
const assert = require('node:assert/strict');

const { DomainError } = require('../miniprogram/domain/errors');
const {
  WxExportTempFileStore,
  isOwnedExportTempFileName
} = require('../miniprogram/services/export-temp-file-store');

function createHarness(options = {}) {
  const calls = {
    readdirSync: [],
    unlinkSync: []
  };
  const fileSystemManager = {
    readdirSync(path) {
      calls.readdirSync.push(path);
      if (options.readdirError) throw options.readdirError;
      return options.fileNames || [];
    },
    unlinkSync(path) {
      calls.unlinkSync.push(path);
      if (options.unlinkResult) options.unlinkResult(path, calls.unlinkSync.length);
    }
  };
  const store = new WxExportTempFileStore({
    getFileSystemManager: () => fileSystemManager,
    getUserDataPath: () => 'http://usr'
  });
  return { calls, store };
}

test('严格清理只删除精确归属于本应用的当前和历史导出临时文件', () => {
  const harness = createHarness({
    fileNames: [
      'plan-and-record-share.json',
      'plan-and-record-share.csv',
      'plan-and-record-1700000000000.json',
      'plan-and-record-logs-1700000000000.csv',
      'plan-and-record-20260728.json',
      'plan-and-record-logs-20260728.csv',
      'plan-and-record-12345678901234.json',
      'database.json'
    ]
  });

  const result = harness.store.removeAllStrict();

  assert.deepEqual(harness.calls.readdirSync, ['http://usr']);
  assert.deepEqual(harness.calls.unlinkSync, [
    'http://usr/plan-and-record-share.json',
    'http://usr/plan-and-record-share.csv',
    'http://usr/plan-and-record-1700000000000.json',
    'http://usr/plan-and-record-logs-1700000000000.csv'
  ]);
  assert.deepEqual(result, { removedCount: 4 });
});

test('严格清理在目录枚举失败时不尝试删除并返回脱敏错误', () => {
  const harness = createHarness({
    readdirError: new Error('readdirSync:fail permission denied http://usr')
  });

  assert.throws(
    () => harness.store.removeAllStrict(),
    (error) => (
      error instanceof DomainError
      && error.code === 'EXPORT_TEMP_FILE_CLEANUP_FAILED'
      && error.message === '无法确认临时导出文件已清理，数据未清空，请重试'
      && !error.message.includes('http://usr')
    )
  );
  assert.deepEqual(harness.calls.unlinkSync, []);
});

test('严格清理忽略删除期间已不存在的文件', () => {
  const harness = createHarness({
    fileNames: ['plan-and-record-share.json'],
    unlinkResult: () => {
      throw new Error('unlinkSync:fail no such file or directory, open http://usr/plan-and-record-share.json');
    }
  });

  assert.deepEqual(harness.store.removeAllStrict(), { removedCount: 1 });
  assert.equal(harness.calls.unlinkSync.length, 1);
});

test('严格清理遇到任一非缺失删除错误立即失败且不继续删除', () => {
  const harness = createHarness({
    fileNames: [
      'plan-and-record-share.json',
      'plan-and-record-share.csv',
      'plan-and-record-1700000000000.json'
    ],
    unlinkResult: (path, callCount) => {
      if (callCount === 2) {
        throw new Error(`unlinkSync:fail permission denied ${path}`);
      }
    }
  });

  assert.throws(
    () => harness.store.removeAllStrict(),
    (error) => (
      error instanceof DomainError
      && error.code === 'EXPORT_TEMP_FILE_CLEANUP_FAILED'
      && !error.message.includes('permission denied')
    )
  );
  assert.deepEqual(harness.calls.unlinkSync, [
    'http://usr/plan-and-record-share.json',
    'http://usr/plan-and-record-share.csv'
  ]);
});

test('导出临时文件归属判定拒绝相似名称和非字符串条目', () => {
  assert.equal(isOwnedExportTempFileName('plan-and-record-share.json'), true);
  assert.equal(isOwnedExportTempFileName('plan-and-record-1700000000000.json'), true);
  assert.equal(isOwnedExportTempFileName('plan-and-record-20260728.json'), false);
  assert.equal(isOwnedExportTempFileName('plan-and-record-1700000000000.json.bak'), false);
  assert.equal(isOwnedExportTempFileName('../plan-and-record-share.json'), false);
  assert.equal(isOwnedExportTempFileName(null), false);
});
