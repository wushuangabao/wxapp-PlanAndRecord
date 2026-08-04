const test = require('node:test');
const assert = require('node:assert/strict');

const { createInitialDatabase } = require('../miniprogram/domain/entities');
const { DomainError } = require('../miniprogram/domain/errors');
const { STORAGE_KEY } = require('../miniprogram/repository/local-repository');
const { DataRecoveryService } = require('../miniprogram/services/data-recovery-service');

function importedSnapshot(now = 1_700_000_000_000) {
  const database = createInitialDatabase(now);
  database.wishes.push({
    id: 'wish_imported',
    title: '恢复后的愿望',
    createdAt: now,
    updatedAt: now
  });
  database.timer = {
    status: 'running',
    startedAt: now,
    pausedAt: null,
    pauses: [],
    draft: { note: '不得跨库恢复', tags: [] }
  };
  return database;
}

function createHarness(options = {}) {
  const rawValue = Object.prototype.hasOwnProperty.call(options, 'rawValue')
    ? options.rawValue
    : '{"private":"raw"}';
  const calls = { get: [], replace: [], removeAllStrict: 0 };
  const storage = {
    get(key) {
      calls.get.push(key);
      return rawValue;
    }
  };
  const repository = {
    replace(database, replaceOptions) {
      calls.replace.push({ database: structuredClone(database), options: replaceOptions });
      if (options.replaceError) throw options.replaceError;
      return structuredClone(database);
    },
    initialize() {
      throw new Error('恢复服务不得初始化损坏资料库');
    },
    read() {
      throw new Error('恢复服务不得读取损坏资料库');
    },
    exportSnapshot() {
      throw new Error('恢复服务不得规范化原始资料库');
    }
  };
  const exportTempFileStore = {
    removeAllStrict() {
      calls.removeAllStrict += 1;
      if (options.cleanupError) throw options.cleanupError;
      return { removedCount: 1 };
    }
  };
  const service = new DataRecoveryService({
    repository,
    storage,
    exportTempFileStore,
    now: () => options.now || 1_800_000_000_000
  });
  return { service, calls };
}

test('原始导出直接保留字符串，非字符串只做 JSON 文本化', () => {
  const raw = '{ "schemaVersion": 99, "future": true }\n';
  const stringHarness = createHarness({ rawValue: raw });
  assert.equal(stringHarness.service.exportRawData(), raw);
  assert.deepEqual(stringHarness.calls.get, [STORAGE_KEY]);

  const object = { schemaVersion: 99, nested: { future: true } };
  assert.equal(
    createHarness({ rawValue: object }).service.exportRawData(),
    JSON.stringify(object, null, 2)
  );

  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(createHarness({ rawValue: cyclic }).service.exportRawData(), '[object Object]');
});

test('完整 JSON 只按覆盖模式分析，并重建 profile 与空闲运行态', () => {
  const now = 1_800_000_000_000;
  const harness = createHarness({ now });
  const prepared = harness.service.prepareReplacement(JSON.stringify(importedSnapshot()));

  assert.equal(prepared.schemaVersion, 1);
  assert.equal(prepared.addedCounts.wishes, 1);
  assert.equal(prepared.repairedReferenceCount, 0);
  assert.equal(prepared.discardedExceptionCount, 0);
  assert.equal(prepared.resetsRuntime, true);
  assert.equal(typeof prepared.token, 'string');
  assert.equal(harness.calls.get.length, 0);
  assert.equal(harness.calls.replace.length, 0);

  harness.service.commitReplacement(prepared.token);

  assert.equal(harness.calls.replace.length, 1);
  const replacement = harness.calls.replace[0];
  assert.deepEqual(replacement.options, { clearMigrationBackup: true });
  assert.equal(replacement.database.wishes[0].title, '恢复后的愿望');
  assert.notEqual(replacement.database.localProfile.id, importedSnapshot().localProfile.id);
  assert.equal(replacement.database.localProfile.createdAt, now);
  assert.deepEqual(replacement.database.timer, {
    status: 'idle', startedAt: null, pausedAt: null, pauses: [], draft: {}
  });
  assert.equal(replacement.database.recoveryDraft, null);
});

test('非法 JSON 不产生可提交 token 且不会写入，token 提交后立即失效', () => {
  const invalidHarness = createHarness();
  assert.throws(
    () => invalidHarness.service.prepareReplacement('{'),
    (error) => error instanceof DomainError && error.code === 'IMPORT_JSON_INVALID'
  );
  assert.deepEqual(invalidHarness.calls.replace, []);
  assert.throws(
    () => invalidHarness.service.commitReplacement('missing'),
    (error) => error instanceof DomainError && error.code === 'RECOVERY_REPLACEMENT_NOT_FOUND'
  );

  const harness = createHarness();
  const prepared = harness.service.prepareReplacement(JSON.stringify(importedSnapshot()));
  harness.service.commitReplacement(prepared.token);
  assert.throws(
    () => harness.service.commitReplacement(prepared.token),
    (error) => error instanceof DomainError && error.code === 'RECOVERY_REPLACEMENT_NOT_FOUND'
  );
});

test('取消覆盖令 token 失效，提交失败也不能重复使用 token', () => {
  const cancelled = createHarness();
  const cancelledToken = cancelled.service.prepareReplacement(JSON.stringify(importedSnapshot())).token;
  cancelled.service.cancelReplacement(cancelledToken);
  assert.throws(
    () => cancelled.service.commitReplacement(cancelledToken),
    (error) => error.code === 'RECOVERY_REPLACEMENT_NOT_FOUND'
  );

  const failed = createHarness({ replaceError: new Error('write failed') });
  const failedToken = failed.service.prepareReplacement(JSON.stringify(importedSnapshot())).token;
  assert.throws(() => failed.service.commitReplacement(failedToken), /write failed/);
  assert.throws(
    () => failed.service.commitReplacement(failedToken),
    (error) => error.code === 'RECOVERY_REPLACEMENT_NOT_FOUND'
  );
});

test('清空必须明确确认，先严格清理文件再替换为空资料库', () => {
  const harness = createHarness({ now: 1_900_000_000_000 });
  assert.throws(
    () => harness.service.clearAllData(false),
    (error) => error.code === 'CLEAR_CONFIRMATION_REQUIRED'
  );
  assert.equal(harness.calls.removeAllStrict, 0);
  assert.equal(harness.calls.replace.length, 0);

  const result = harness.service.clearAllData(true);
  assert.equal(result.cleared, true);
  assert.equal(harness.calls.removeAllStrict, 1);
  assert.equal(harness.calls.replace.length, 1);
  assert.deepEqual(harness.calls.replace[0].database.wishes, []);
  assert.equal(harness.calls.replace[0].database.localProfile.createdAt, 1_900_000_000_000);
});

test('临时文件清理或仓储替换失败时绝不误报清空成功', () => {
  const cleanupFailed = createHarness({ cleanupError: new Error('cleanup failed') });
  assert.throws(() => cleanupFailed.service.clearAllData(true), /cleanup failed/);
  assert.equal(cleanupFailed.calls.replace.length, 0);

  const writeFailed = createHarness({ replaceError: new Error('write failed') });
  assert.throws(() => writeFailed.service.clearAllData(true), /write failed/);
  assert.equal(writeFailed.calls.removeAllStrict, 1);
  assert.equal(writeFailed.calls.replace.length, 1);
});
