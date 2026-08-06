const test = require('node:test');
const assert = require('node:assert/strict');

const { APP_SCHEMA_VERSION } = require('../miniprogram/domain/constants');
const { createInitialDatabase, createTimeLog, clone } = require('../miniprogram/domain/entities');
const { DomainError, StorageError } = require('../miniprogram/domain/errors');
const {
  LocalRepository,
  STORAGE_KEY,
  BACKUP_KEY
} = require('../miniprogram/repository/local-repository');
const { validateJsonSnapshot } = require('../miniprogram/repository/json-snapshot');
const {
  MemoryStorageAdapter,
  WxStorageAdapter
} = require('../miniprogram/repository/storage-adapter');

class FaultStorage {
  constructor() {
    this.values = new Map();
    this.failGetKey = null;
    this.failSet = false;
    this.failSetAfterWriteOnce = false;
    this.failSetAfterWriteOnCall = null;
    this.failSetOnCall = null;
    this.failRemove = false;
    this.failRemoveAfterDelete = false;
    this.failSetMessage = 'set failed';
    this.setCalls = [];
    this.setEntries = [];
    this.removeCalls = [];
  }

  get(key) {
    if (this.failGetKey === key) throw new Error(`get failed: ${key}`);
    const value = this.values.get(key);
    return value === undefined ? '' : structuredClone(value);
  }

  has(key) {
    return this.values.has(key);
  }

  set(key, value) {
    this.setCalls.push(key);
    this.setEntries.push([key, structuredClone(value)]);
    if (this.failSet || this.setCalls.length === this.failSetOnCall) {
      throw new Error(this.failSetMessage);
    }
    this.values.set(key, structuredClone(value));
    if (this.failSetAfterWriteOnce || this.setCalls.length === this.failSetAfterWriteOnCall) {
      this.failSetAfterWriteOnce = false;
      throw new Error(this.failSetMessage);
    }
  }

  remove(key) {
    this.removeCalls.push(key);
    if (this.failRemoveAfterDelete) {
      this.failRemoveAfterDelete = false;
      this.values.delete(key);
      throw new Error('remove failed after delete');
    }
    if (this.failRemove) throw new Error('remove failed');
    this.values.delete(key);
  }
}

function createRepository(storage, start = 1_700_000_000_000) {
  let now = start;
  const repository = new LocalRepository(storage, { now: () => now });
  repository.initialize();
  return {
    repository,
    setNow(value) { now = value; }
  };
}

function changedSnapshot(database, updatedAt = 1_700_000_000_100) {
  const next = clone(database);
  next.localProfile.updatedAt = updatedAt;
  next.updatedAt = updatedAt;
  return next;
}

function captureThrown(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  assert.fail('预期操作抛出异常');
}

test('MemoryStorageAdapter.remove 只删除指定键', () => {
  const storage = new MemoryStorageAdapter();
  storage.set('keep', { value: 1 });
  storage.set('remove', { value: 2 });

  storage.remove('remove');

  assert.deepEqual(storage.get('keep'), { value: 1 });
  assert.equal(storage.has('remove'), false);
  assert.equal(storage.get('remove'), '');
});

test('MemoryStorageAdapter.has 区分键缺失与 falsy 原值', () => {
  const missing = new MemoryStorageAdapter();
  assert.equal(missing.has(STORAGE_KEY), false);

  for (const value of ['', 0, false, null]) {
    const storage = new MemoryStorageAdapter(value);
    assert.equal(storage.has(STORAGE_KEY), true);
  }
});

test('initialize 对已有 falsy 原值报损坏且全程零写入', () => {
  for (const value of ['', 0, false, null]) {
    const storage = new MemoryStorageAdapter(value);
    const calls = { set: 0, remove: 0 };
    const originalSet = storage.set.bind(storage);
    const originalRemove = storage.remove.bind(storage);
    storage.set = (...args) => { calls.set += 1; return originalSet(...args); };
    storage.remove = (...args) => { calls.remove += 1; return originalRemove(...args); };
    const repository = new LocalRepository(storage);

    assert.throws(
      () => repository.initialize(),
      (error) => error instanceof StorageError && error.code === 'DATA_CORRUPTED'
    );
    assert.equal(storage.has(STORAGE_KEY), true);
    assert.equal(storage.get(STORAGE_KEY), value);
    assert.deepEqual(calls, { set: 0, remove: 0 });
  }
});

test('LocalRepository 要求存储适配器提供 has 而不通过 get 返回值猜测键是否存在', () => {
  assert.throws(
    () => new LocalRepository({
      get() { return ''; },
      set() {},
      remove() {}
    }),
    (error) => error instanceof TypeError && /storage\.has/.test(error.message)
  );
});

test('initialize 对缺少迁移路径的低版本资料库零写入', () => {
  const stored = createInitialDatabase(1_700_000_000_000);
  stored.schemaVersion = APP_SCHEMA_VERSION - 1;
  const storage = new MemoryStorageAdapter(stored);
  const calls = { set: 0, remove: 0 };
  const originalSet = storage.set.bind(storage);
  const originalRemove = storage.remove.bind(storage);
  storage.set = (...args) => { calls.set += 1; return originalSet(...args); };
  storage.remove = (...args) => { calls.remove += 1; return originalRemove(...args); };

  assert.throws(
    () => new LocalRepository(storage).initialize(),
    (error) => error instanceof StorageError
      && error.code === 'MIGRATION_PATH_MISSING'
      && error.details.fromVersion === APP_SCHEMA_VERSION - 1
  );
  assert.equal(storage.has(BACKUP_KEY), false);
  assert.deepEqual(calls, { set: 0, remove: 0 });
});

test('initialize 将不安全或负数结构版本视为损坏且零写入', () => {
  for (const schemaVersion of [-1, Number.MIN_SAFE_INTEGER - 1]) {
    const stored = createInitialDatabase(1_700_000_000_000);
    stored.schemaVersion = schemaVersion;
    const storage = new FaultStorage();
    storage.set(STORAGE_KEY, stored);
    storage.setCalls.length = 0;
    storage.removeCalls.length = 0;

    assert.throws(
      () => new LocalRepository(storage).initialize(),
      (error) => error instanceof StorageError && error.code === 'DATA_CORRUPTED'
    );
    assert.deepEqual(storage.setCalls, []);
    assert.deepEqual(storage.removeCalls, []);
    assert.deepEqual(storage.get(STORAGE_KEY), stored);
  }
});

test('initialize 逐级迁移时先备份原值，成功后写主键并删除备份', () => {
  const stored = createInitialDatabase(1_700_000_000_000);
  stored.schemaVersion = 0;
  const storage = new FaultStorage();
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  storage.setEntries.length = 0;
  storage.removeCalls.length = 0;
  const repository = new LocalRepository(storage, {
    migrations: {
      0: (database) => ({ ...database, schemaVersion: 1 })
    }
  });

  const migrated = repository.initialize();

  assert.equal(migrated.schemaVersion, APP_SCHEMA_VERSION);
  assert.doesNotThrow(() => validateJsonSnapshot(migrated));
  assert.deepEqual(storage.setCalls, [BACKUP_KEY, STORAGE_KEY]);
  assert.deepEqual(storage.removeCalls, [BACKUP_KEY]);
  assert.deepEqual(storage.setEntries[0], [BACKUP_KEY, stored]);
  assert.equal(storage.has(BACKUP_KEY), false);
});

test('initialize 迁移步骤失败时清理备份并保留原始主键', () => {
  const stored = createInitialDatabase(1_700_000_000_000);
  stored.schemaVersion = 0;
  const storage = new FaultStorage();
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  storage.removeCalls.length = 0;
  const repository = new LocalRepository(storage, {
    migrations: { 0: () => { throw new Error('private step failure'); } }
  });

  const error = captureThrown(() => repository.initialize());

  assert.equal(error instanceof StorageError, true);
  assert.equal(error.code, 'MIGRATION_FAILED');
  assert.doesNotMatch(error.message, /private step failure/);
  assert.deepEqual(storage.get(STORAGE_KEY), stored);
  assert.equal(storage.has(BACKUP_KEY), false);
  assert.equal(repository.cache, null);
  assert.deepEqual(storage.setCalls, [BACKUP_KEY]);
  assert.deepEqual(storage.removeCalls, [BACKUP_KEY]);
});

test('initialize 迁移结果校验失败时不会保留非法主键', () => {
  const stored = createInitialDatabase(1_700_000_000_000);
  stored.schemaVersion = 0;
  const storage = new FaultStorage();
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  storage.removeCalls.length = 0;
  const repository = new LocalRepository(storage, {
    migrations: {
      0: (database) => {
        const invalid = { ...database, schemaVersion: 1 };
        delete invalid.localProfile;
        return invalid;
      }
    }
  });

  const error = captureThrown(() => repository.initialize());

  assert.equal(error.code, 'MIGRATION_FAILED');
  assert.deepEqual(storage.get(STORAGE_KEY), stored);
  assert.equal(storage.has(BACKUP_KEY), false);
  assert.equal(repository.cache, null);
});

test('initialize 迁移主键写后失败且补偿失败时报告状态不确定', () => {
  const stored = createInitialDatabase(1_700_000_000_000);
  stored.schemaVersion = 0;
  stored.wishes.push({
    id: 'wish_migration_private',
    title: 'PRIVATE_MIGRATION_TITLE',
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt
  });
  const storage = new FaultStorage();
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  storage.removeCalls.length = 0;
  storage.failSetAfterWriteOnCall = 2;
  storage.failSetOnCall = 3;
  const repository = new LocalRepository(storage, {
    migrations: { 0: (database) => ({ ...database, schemaVersion: 1 }) }
  });

  const error = captureThrown(() => repository.initialize());

  assert.equal(error.code, 'MIGRATION_ROLLBACK_UNCERTAIN');
  assert.doesNotMatch(error.message, /PRIVATE_MIGRATION_TITLE/);
  assert.equal(repository.cache, null);
  assert.deepEqual(storage.setCalls, [BACKUP_KEY, STORAGE_KEY, STORAGE_KEY, BACKUP_KEY]);
  assert.equal(storage.has(BACKUP_KEY), true);
  assert.deepEqual(storage.get(BACKUP_KEY), stored);

  storage.failSetAfterWriteOnCall = null;
  storage.failSetOnCall = null;
  storage.setCalls.length = 0;
  const restartedRepository = new LocalRepository(storage, {
    migrations: { 0: (database) => ({ ...database, schemaVersion: 1 }) }
  });
  const recovered = restartedRepository.initialize();

  assert.equal(recovered.schemaVersion, APP_SCHEMA_VERSION);
  assert.equal(storage.has(BACKUP_KEY), false);
  assert.equal(recovered.wishes.some((item) => item.id === 'wish_migration_private'), true);
});

test('initialize 先恢复遗留备份，再从原始版本重新执行迁移', () => {
  const original = createInitialDatabase(1_700_000_000_000);
  original.schemaVersion = 0;
  const halfMigrated = { schemaVersion: 1, interrupted: true };
  const storage = new FaultStorage();
  storage.set(STORAGE_KEY, halfMigrated);
  storage.set(BACKUP_KEY, original);
  storage.setCalls.length = 0;
  storage.removeCalls.length = 0;
  const repository = new LocalRepository(storage, {
    migrations: { 0: (database) => ({ ...database, schemaVersion: 1 }) }
  });

  const migrated = repository.initialize();

  assert.doesNotThrow(() => validateJsonSnapshot(migrated));
  assert.deepEqual(storage.setCalls, [STORAGE_KEY, BACKUP_KEY, STORAGE_KEY]);
  assert.deepEqual(storage.removeCalls, [BACKUP_KEY, BACKUP_KEY]);
  assert.equal(storage.has(BACKUP_KEY), false);
  assert.deepEqual(storage.get(STORAGE_KEY), migrated);
});

test('initialize 在键枚举或主值读取失败时停止启动且零写入', () => {
  const cases = [
    {
      label: '枚举失败',
      storage: {
        has() { throw new Error('enumeration failed'); },
        get() { throw new Error('get should not run'); }
      }
    },
    {
      label: '读取失败',
      storage: {
        has(key) { return key === STORAGE_KEY; },
        get() { throw new Error('read failed'); }
      }
    }
  ];

  for (const item of cases) {
    const writes = [];
    item.storage.set = (...args) => writes.push(['set', ...args]);
    item.storage.remove = (...args) => writes.push(['remove', ...args]);
    assert.throws(
      () => new LocalRepository(item.storage).initialize(),
      (error) => error instanceof StorageError && error.code === 'DATA_CORRUPTED',
      item.label
    );
    assert.deepEqual(writes, [], item.label);
  }
});

test('initialize 严格校验合法当前版本快照且不重复写入', () => {
  const storage = new FaultStorage();
  const stored = createInitialDatabase(1_700_000_000_000);
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  const repository = new LocalRepository(storage, { now: () => 1_700_000_000_100 });

  const loaded = repository.initialize();

  assert.deepEqual(loaded, stored);
  assert.notEqual(loaded, repository.cache);
  loaded.wishes.push({ id: 'wish_outside', title: '只修改返回值' });
  assert.deepEqual(repository.cache, stored);
  assert.deepEqual(storage.get(STORAGE_KEY), stored);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);
});

test('initialize 对同版本缺失暂停字段的日志只规范化内存且零写入', () => {
  const storage = new FaultStorage();
  const stored = createInitialDatabase(1_700_000_000_000);
  const legacyLog = createTimeLog({
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_061_000,
    source: 'manual'
  }, 1_700_000_061_000);
  legacyLog.durationMinutes = 1;
  delete legacyLog.pausedDurationSeconds;
  stored.timeLogs.push(legacyLog);
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  const repository = new LocalRepository(storage, { now: () => 1_700_000_061_001 });

  const loaded = repository.initialize();

  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.timeLogs[0].pausedDurationSeconds, 0);
  assert.equal(loaded.timeLogs[0].durationMinutes, 2);
  assert.equal(Object.hasOwn(storage.get(STORAGE_KEY).timeLogs[0], 'pausedDurationSeconds'), false);
  assert.equal(storage.get(STORAGE_KEY).timeLogs[0].durationMinutes, 1);
  assert.equal(storage.has(BACKUP_KEY), false);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);
});

test('transaction 在写入前校验完整快照并对非法 TimeLog 零写入', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  storage.setCalls.length = 0;

  assert.throws(
    () => repository.transaction((database) => {
      const log = createTimeLog({
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_060_000,
        source: 'manual'
      }, 1_700_000_060_000);
      log.pausedDurationSeconds = 60;
      database.timeLogs.push(log);
    }),
    (error) => error instanceof DomainError && error.code === 'IMPORT_SCHEMA_INVALID'
  );

  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(storage.get(STORAGE_KEY), oldSnapshot);
  assert.deepEqual(storage.setCalls, []);
});

test('transaction 主快照写入后抛错时恢复旧存储和缓存，同一操作可安全重试', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  storage.setCalls.length = 0;
  storage.failSetAfterWriteOnce = true;

  const addWish = (database) => {
    database.wishes.push({
      id: 'wish_transaction_retry',
      title: '事务重试',
      createdAt: oldSnapshot.updatedAt,
      updatedAt: oldSnapshot.updatedAt
    });
  };

  assert.throws(
    () => repository.transaction(addWish),
    (error) => error instanceof StorageError
      && error.code === 'WRITE_FAILED'
      && /已保留/.test(error.message)
  );

  assert.deepEqual(storage.get(STORAGE_KEY), oldSnapshot);
  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(repository.read(), oldSnapshot);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY, STORAGE_KEY]);

  const retried = repository.transaction(addWish).database;
  assert.equal(retried.wishes.filter((wish) => wish.id === 'wish_transaction_retry').length, 1);
  assert.equal(storage.get(STORAGE_KEY).wishes.filter((wish) => wish.id === 'wish_transaction_retry').length, 1);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY, STORAGE_KEY, STORAGE_KEY]);
});

test('transaction 原主快照不存在时写后失败会删除主键并恢复缓存', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  storage.remove(STORAGE_KEY);
  storage.setCalls.length = 0;
  storage.removeCalls.length = 0;
  storage.failSetAfterWriteOnce = true;

  assert.throws(
    () => repository.transaction((database) => {
      database.wishes.push({
        id: 'wish_transaction_missing_main',
        title: '缺失主键回滚',
        createdAt: oldSnapshot.updatedAt,
        updatedAt: oldSnapshot.updatedAt
      });
    }),
    (error) => error instanceof StorageError
      && error.code === 'WRITE_FAILED'
      && /已保留/.test(error.message)
  );

  assert.equal(storage.has(STORAGE_KEY), false);
  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(repository.read(), oldSnapshot);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY]);
  assert.deepEqual(storage.removeCalls, [STORAGE_KEY]);
});

test('transaction 补偿失败时恢复缓存并报告持久化结果不确定', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  storage.setCalls.length = 0;
  storage.failSetAfterWriteOnce = true;
  storage.failSetOnCall = 2;

  const error = captureThrown(() => repository.transaction((database) => {
    database.wishes.push({
      id: 'wish_transaction_uncertain',
      title: '补偿失败',
      createdAt: oldSnapshot.updatedAt,
      updatedAt: oldSnapshot.updatedAt
    });
  }));

  assert.ok(error instanceof StorageError);
  assert.equal(error.code, 'WRITE_FAILED');
  assert.match(error.message, /无法确认原数据是否完整保留/);
  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(repository.read(), oldSnapshot);
  assert.equal(
    storage.get(STORAGE_KEY).wishes.some((wish) => wish.id === 'wish_transaction_uncertain'),
    true
  );
  assert.deepEqual(storage.setCalls, [STORAGE_KEY, STORAGE_KEY]);
});

test('transaction 显式 updatedAt 会持久化且不调用 repository.now', () => {
  const storage = new FaultStorage();
  let nowCalls = 0;
  const repository = new LocalRepository(storage, {
    now: () => {
      nowCalls += 1;
      return 1_700_000_000_000;
    }
  });
  repository.initialize();
  const updatedAt = 1_700_000_000_100;
  nowCalls = 0;
  storage.setCalls.length = 0;

  const database = repository.transaction((next) => {
    next.localProfile.updatedAt = updatedAt;
  }, { updatedAt }).database;

  assert.equal(nowCalls, 0);
  assert.equal(database.updatedAt, updatedAt);
  assert.equal(storage.get(STORAGE_KEY).updatedAt, updatedAt);
  assert.equal(storage.get(STORAGE_KEY).localProfile.updatedAt, updatedAt);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY]);
});

test('transaction 使用缓存快照补偿且不重复读取整库主键', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  storage.setCalls.length = 0;
  storage.failGetKey = STORAGE_KEY;

  assert.doesNotThrow(() => repository.transaction((database) => {
    database.localProfile.updatedAt += 1;
  }));

  assert.deepEqual(storage.setCalls, [STORAGE_KEY]);
});

test('成功事务会将读入时补全的暂停 0 和重算分钟自然持久化', () => {
  const storage = new FaultStorage();
  const stored = createInitialDatabase(1_700_000_000_000);
  const legacyLog = createTimeLog({
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_061_000,
    source: 'manual'
  }, 1_700_000_061_000);
  legacyLog.durationMinutes = 1;
  delete legacyLog.pausedDurationSeconds;
  stored.timeLogs.push(legacyLog);
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  const repository = new LocalRepository(storage, { now: () => 1_700_000_061_001 });
  repository.initialize();

  repository.transaction((database) => {
    database.localProfile.updatedAt = 1_700_000_061_001;
  });

  assert.equal(storage.get(STORAGE_KEY).timeLogs[0].pausedDurationSeconds, 0);
  assert.equal(storage.get(STORAGE_KEY).timeLogs[0].durationMinutes, 2);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY]);
});

test('initialize 兼容旧 idle 计时器的 endedAt，并只在读取结果中剥离', () => {
  const storage = new FaultStorage();
  const stored = createInitialDatabase(1_700_000_000_000);
  stored.timer.endedAt = null;
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  const repository = new LocalRepository(storage, { now: () => 1_700_000_000_100 });

  const loaded = repository.initialize();

  assert.deepEqual(loaded.timer, {
    status: 'idle', startedAt: null, pausedAt: null, pauses: [], draft: {}
  });
  assert.equal(Object.prototype.hasOwnProperty.call(loaded.timer, 'endedAt'), false);
  assert.deepEqual(storage.get(STORAGE_KEY), stored);
  assert.deepEqual(storage.setCalls, []);
  assert.doesNotThrow(() => validateJsonSnapshot(loaded));
});

test('initialize 将旧 ended 计时安全降级为可核实的恢复草稿', () => {
  const storage = new FaultStorage();
  const startedAt = 1_700_000_000_000;
  const endedAt = startedAt + 60_000;
  const stored = createInitialDatabase(startedAt);
  stored.timer = {
    status: 'ended',
    startedAt,
    endedAt,
    pausedAt: null,
    pauses: [],
    draft: { note: '旧版已结束计时', tags: ['迁移'] }
  };
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  const repository = new LocalRepository(storage, { now: () => endedAt + 1 });

  const loaded = repository.initialize();

  assert.deepEqual(loaded.timer, {
    status: 'idle', startedAt: null, pausedAt: null, pauses: [], draft: {}
  });
  assert.equal(loaded.recoveryDraft.timer.status, 'idle');
  assert.equal(Object.prototype.hasOwnProperty.call(loaded.recoveryDraft.timer, 'endedAt'), false);
  assert.deepEqual(loaded.recoveryDraft.candidatePreview, {
    startedAt,
    endedAt,
    pausedDurationSeconds: 0,
    durationMinutes: 1,
    source: 'timer'
  });
  assert.deepEqual(storage.setCalls, []);
  assert.doesNotThrow(() => validateJsonSnapshot(loaded));
});

test('旧 ended 计时无法形成候选预览时保留待修正草稿', () => {
  const storage = new FaultStorage();
  const startedAt = 1_700_000_000_000;
  const stored = createInitialDatabase(startedAt);
  stored.timer = {
    status: 'ended',
    startedAt,
    endedAt: startedAt,
    pausedAt: null,
    pauses: [],
    draft: { note: '需要手工修正', tags: [] }
  };
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  const repository = new LocalRepository(storage, { now: () => startedAt + 1 });

  const loaded = repository.initialize();

  assert.equal(loaded.timer.status, 'idle');
  assert.equal(loaded.recoveryDraft.timer.status, 'idle');
  assert.equal(loaded.recoveryDraft.timer.startedAt, startedAt);
  assert.equal(Object.prototype.hasOwnProperty.call(loaded.recoveryDraft, 'candidatePreview'), false);
  assert.deepEqual(storage.setCalls, []);
  assert.doesNotThrow(() => validateJsonSnapshot(loaded));
});

test('initialize 将结构完整但暂停语义不一致的活动计时留给恢复流程', () => {
  const storage = new FaultStorage();
  const stored = createInitialDatabase(1_700_000_000_000);
  stored.timer = {
    status: 'paused',
    startedAt: 1_700_000_000_000,
    pausedAt: 1_700_000_050_000,
    pauses: [
      { startedAt: 1_700_000_030_000, endedAt: 1_700_000_020_000 }
    ],
    draft: { tags: [] }
  };
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  const repository = new LocalRepository(storage, { now: () => 1_700_000_060_000 });

  const loaded = repository.initialize();

  assert.deepEqual(loaded.timer, stored.timer);
  assert.deepEqual(repository.cache, stored);
  assert.deepEqual(storage.get(STORAGE_KEY), stored);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);
});

test('initialize 允许已保存恢复草稿保留反向暂停区间供用户修正', () => {
  const storage = new FaultStorage();
  const stored = createInitialDatabase(1_700_000_000_000);
  stored.recoveryDraft = {
    reason: '暂停区间待修正',
    timer: {
      status: 'paused',
      startedAt: 1_700_000_000_000,
      pausedAt: 1_700_000_050_000,
      pauses: [
        { startedAt: 1_700_000_030_000, endedAt: 1_700_000_020_000 }
      ],
      draft: { tags: [] }
    },
    createdAt: 1_700_000_060_000
  };
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  const repository = new LocalRepository(storage, { now: () => 1_700_000_070_000 });

  const loaded = repository.initialize();

  assert.deepEqual(loaded.recoveryDraft, stored.recoveryDraft);
  assert.deepEqual(repository.cache, stored);
  assert.deepEqual(storage.get(STORAGE_KEY), stored);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);
  assert.doesNotThrow(() => repository.replace(loaded));
});

test('initialize 对可恢复计时仍严格校验必需字段、容器、枚举、时间戳和草稿类型', () => {
  const cases = [
    ['缺少字段', (timer) => { delete timer.pausedAt; }],
    ['暂停容器错误', (timer) => { timer.pauses = {}; }],
    ['暂停字段缺失', (timer) => { timer.pauses = [{ startedAt: 1_700_000_010_000 }]; }],
    ['状态枚举错误', (timer) => { timer.status = 'recovering'; }],
    ['时间戳类型错误', (timer) => { timer.startedAt = '1700000000000'; }],
    ['草稿类型错误', (timer) => { timer.draft = { note: 42, tags: [] }; }]
  ];

  cases.forEach(([label, mutate]) => {
    const storage = new FaultStorage();
    const stored = createInitialDatabase(1_700_000_000_000);
    stored.timer = {
      status: 'running',
      startedAt: 1_700_000_000_000,
      pausedAt: null,
      pauses: [],
      draft: { tags: [] }
    };
    mutate(stored.timer);
    storage.set(STORAGE_KEY, stored);
    storage.setCalls.length = 0;
    const repository = new LocalRepository(storage);

    assert.throws(
      () => repository.initialize(),
      (error) => error instanceof StorageError && error.code === 'DATA_CORRUPTED',
      label
    );
    assert.equal(repository.cache, null, label);
    assert.deepEqual(storage.get(STORAGE_KEY), stored, label);
    assert.deepEqual(storage.setCalls, [], label);
    assert.deepEqual(storage.removeCalls, [], label);
  });
});

test('initialize 拒绝同版本损坏快照，后续事务仍零写入且缓存不受污染', () => {
  const storage = new FaultStorage();
  const stored = createInitialDatabase(1_700_000_000_000);
  const sentinel = 'PRIVATE_LOCAL_SNAPSHOT_SENTINEL_749';
  stored.wishes.push({
    id: 'wish_private',
    title: sentinel,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt
  });
  stored.timer = {
    status: 'running',
    startedAt: stored.createdAt,
    pausedAt: null,
    pauses: [],
    draft: { tags: [] }
  };
  delete stored.tasks;
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  const repository = new LocalRepository(storage, { now: () => 1_700_000_000_100 });

  const error = captureThrown(() => repository.initialize());

  assert.equal(error instanceof StorageError, true);
  assert.equal(error.code, 'DATA_CORRUPTED');
  assert.match(error.message, /停止写入/);
  assert.doesNotMatch(error.message, new RegExp(sentinel));
  assert.equal(repository.cache, null);
  assert.deepEqual(storage.get(STORAGE_KEY), stored);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);

  let mutatorCalled = false;
  assert.throws(
    () => repository.transaction(() => {
      mutatorCalled = true;
    }),
    (transactionError) => transactionError instanceof StorageError
      && transactionError.code === 'DATA_CORRUPTED'
  );
  assert.equal(mutatorCalled, false);
  assert.equal(repository.cache, null);
  assert.deepEqual(storage.get(STORAGE_KEY), stored);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);
});

test('initialize 将同版本重复 ID 领域错误转换为安全的损坏错误', () => {
  const storage = new FaultStorage();
  const stored = createInitialDatabase(1_700_000_000_000);
  stored.wishes.push({
    id: stored.localProfile.id,
    title: '重复标识',
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt
  });
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  const repository = new LocalRepository(storage);

  const error = captureThrown(() => repository.initialize());

  assert.equal(error instanceof StorageError, true);
  assert.equal(error.code, 'DATA_CORRUPTED');
  assert.doesNotMatch(error.message, /IMPORT_DUPLICATE_ID|重复标识/);
  assert.equal(repository.cache, null);
  assert.deepEqual(storage.get(STORAGE_KEY), stored);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);
});

test('initialize 将同版本校验器原生异常转换为安全的损坏错误', () => {
  const storage = new FaultStorage();
  const stored = createInitialDatabase(1_700_000_000_000);
  const sentinel = 'PRIVATE_NATIVE_VALIDATION_SENTINEL_749';
  stored.wishes.push({
    id: 'wish_private_native',
    title: sentinel,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt
  });
  stored.timeLogs = [null];
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  const repository = new LocalRepository(storage);

  const error = captureThrown(() => repository.initialize());

  assert.equal(error instanceof StorageError, true);
  assert.equal(error.code, 'DATA_CORRUPTED');
  assert.equal(error.name, 'StorageError');
  assert.doesNotMatch(error.message, /TypeError|Cannot read|source/);
  assert.doesNotMatch(error.message, new RegExp(sentinel));
  assert.equal(repository.cache, null);
  assert.deepEqual(storage.get(STORAGE_KEY), stored);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);
});

test('initialize 拒绝高版本快照且不校验或覆盖未来数据', () => {
  const storage = new FaultStorage();
  const stored = createInitialDatabase(1_700_000_000_000);
  const sentinel = 'PRIVATE_FUTURE_SNAPSHOT_SENTINEL_749';
  stored.schemaVersion = APP_SCHEMA_VERSION + 1;
  stored.futurePayload = sentinel;
  delete stored.tasks;
  storage.set(STORAGE_KEY, stored);
  storage.setCalls.length = 0;
  const repository = new LocalRepository(storage);

  const error = captureThrown(() => repository.initialize());

  assert.equal(error instanceof StorageError, true);
  assert.equal(error.code, 'DATA_VERSION_UNSUPPORTED');
  assert.match(error.message, /不会覆盖/);
  assert.doesNotMatch(error.message, new RegExp(sentinel));
  assert.equal(repository.cache, null);
  assert.deepEqual(storage.get(STORAGE_KEY), stored);
  assert.equal(storage.has(BACKUP_KEY), false);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);
});

test('replace 在候选快照校验失败时不写入且不改变缓存', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  const invalid = changedSnapshot(oldSnapshot);
  invalid.localProfile.createdAt = 'not-a-timestamp';
  storage.setCalls.length = 0;

  assert.throws(
    () => repository.replace(invalid, { clearMigrationBackup: true }),
    (error) => error instanceof DomainError && error.code === 'IMPORT_SCHEMA_INVALID'
  );

  assert.deepEqual(storage.get(STORAGE_KEY), oldSnapshot);
  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);
});

test('replace 主快照写入失败时保留存储和缓存', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  storage.setCalls.length = 0;
  storage.failSet = true;

  assert.throws(
    () => repository.replace(changedSnapshot(oldSnapshot)),
    (error) => error instanceof StorageError && error.code === 'WRITE_FAILED'
  );

  assert.deepEqual(storage.get(STORAGE_KEY), oldSnapshot);
  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY, STORAGE_KEY]);
  assert.deepEqual(storage.removeCalls, [BACKUP_KEY]);
});

test('普通 replace 主快照已写入后抛错会恢复旧存储和旧缓存', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  const backup = { schemaVersion: 0, sentinel: 'ordinary-after-write-backup' };
  storage.set(BACKUP_KEY, backup);
  storage.setCalls.length = 0;
  storage.failSetAfterWriteOnce = true;

  assert.throws(
    () => repository.replace(changedSnapshot(oldSnapshot)),
    (error) => error instanceof StorageError
      && error.code === 'WRITE_FAILED'
      && /已保留/.test(error.message)
  );

  assert.deepEqual(storage.get(STORAGE_KEY), oldSnapshot);
  assert.deepEqual(storage.get(BACKUP_KEY), backup);
  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY, STORAGE_KEY, BACKUP_KEY]);
  assert.deepEqual(storage.removeCalls, []);
});

test('replace 仅在有效候选快照写入成功后清理迁移备份', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  const backup = { schemaVersion: 0, sentinel: 'old-backup' };
  storage.set(BACKUP_KEY, backup);
  storage.setCalls.length = 0;

  repository.replace(changedSnapshot(oldSnapshot), { clearMigrationBackup: true });

  assert.equal(storage.has(BACKUP_KEY), false);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY]);
  assert.deepEqual(storage.removeCalls, [BACKUP_KEY]);
});

test('replace 清理备份失败时恢复旧主快照和旧备份，并保持缓存', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  const backup = { schemaVersion: 0, sentinel: 'old-backup' };
  storage.set(BACKUP_KEY, backup);
  storage.setCalls.length = 0;
  storage.failRemoveAfterDelete = true;

  assert.throws(
    () => repository.replace(changedSnapshot(oldSnapshot), { clearMigrationBackup: true }),
    (error) => error instanceof StorageError && error.code === 'WRITE_FAILED'
  );

  assert.deepEqual(storage.get(STORAGE_KEY), oldSnapshot);
  assert.deepEqual(storage.get(BACKUP_KEY), backup);
  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY, STORAGE_KEY, BACKUP_KEY]);
  assert.deepEqual(storage.removeCalls, [BACKUP_KEY]);
});

test('replace 清理不存在的旧备份失败时精确恢复为不存在', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  storage.setCalls.length = 0;
  storage.failRemoveAfterDelete = true;

  assert.throws(
    () => repository.replace(changedSnapshot(oldSnapshot), { clearMigrationBackup: true }),
    (error) => error instanceof StorageError && error.code === 'WRITE_FAILED'
  );

  assert.deepEqual(storage.get(STORAGE_KEY), oldSnapshot);
  assert.equal(storage.has(BACKUP_KEY), false);
  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY, STORAGE_KEY]);
  assert.deepEqual(storage.removeCalls, [BACKUP_KEY, BACKUP_KEY]);
});

test('replace 补偿不完整时使用中性安全错误且不泄漏业务数据', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  const backup = { schemaVersion: 0, sentinel: 'sensitive-business-sentinel' };
  storage.set(BACKUP_KEY, backup);
  storage.setCalls.length = 0;
  storage.failRemoveAfterDelete = true;
  storage.failSetOnCall = 2;

  const error = captureThrown(
    () => repository.replace(changedSnapshot(oldSnapshot), { clearMigrationBackup: true })
  );

  assert.equal(error instanceof StorageError, true);
  assert.equal(error.code, 'WRITE_FAILED');
  assert.match(error.message, /无法确认原数据是否完整保留/);
  assert.doesNotMatch(error.message, /sensitive-business-sentinel/);
  assert.notDeepEqual(storage.get(STORAGE_KEY), oldSnapshot);
  assert.deepEqual(storage.get(BACKUP_KEY), backup);
  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY, STORAGE_KEY, BACKUP_KEY]);
  assert.deepEqual(storage.removeCalls, [BACKUP_KEY]);
});

test('replace 读取旧主快照失败时零写入、零删除并保留缓存', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  storage.setCalls.length = 0;
  storage.failGetKey = STORAGE_KEY;

  const error = captureThrown(() => repository.replace(changedSnapshot(oldSnapshot)));

  assert.equal(error instanceof StorageError, true);
  assert.equal(error.code, 'WRITE_FAILED');
  assert.doesNotMatch(error.message, /get failed|plan-and-record|sensitive-business-sentinel/);
  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);
  storage.failGetKey = null;
  assert.deepEqual(storage.get(STORAGE_KEY), oldSnapshot);
});

test('replace 读取旧迁移备份失败时零写入、零删除并保留缓存', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  storage.set(BACKUP_KEY, { schemaVersion: 0, sentinel: 'sensitive-business-sentinel' });
  storage.setCalls.length = 0;
  storage.failGetKey = BACKUP_KEY;

  const error = captureThrown(
    () => repository.replace(changedSnapshot(oldSnapshot), { clearMigrationBackup: true })
  );

  assert.equal(error instanceof StorageError, true);
  assert.equal(error.code, 'WRITE_FAILED');
  assert.doesNotMatch(error.message, /get failed|plan-and-record|sensitive-business-sentinel/);
  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.removeCalls, []);
  storage.failGetKey = null;
  assert.deepEqual(storage.get(STORAGE_KEY), oldSnapshot);
});

test('增量 replace 不删除迁移备份', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  const backup = { schemaVersion: 0, sentinel: 'keep-backup' };
  storage.set(BACKUP_KEY, backup);
  storage.setCalls.length = 0;

  repository.replace(changedSnapshot(oldSnapshot));

  assert.deepEqual(storage.get(BACKUP_KEY), backup);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY]);
  assert.deepEqual(storage.removeCalls, []);
});

test('replace 对超过 1MB 的候选零写入并返回安全用量信息', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  const oversized = clone(oldSnapshot);
  oversized.recoveryDraft = {
    reason: 'x'.repeat(1024 * 1024),
    timer: clone(oversized.timer),
    createdAt: oldSnapshot.updatedAt
  };
  storage.setCalls.length = 0;

  const error = captureThrown(() => repository.replace(oversized));

  assert.equal(error instanceof StorageError, true);
  assert.equal(error.code, 'STORAGE_CAPACITY_EXCEEDED');
  assert.equal(error.details.usage.exceeded, true);
  assert.equal(error.details.usage.databaseLimitBytes, 1024 * 1024);
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(storage.get(STORAGE_KEY), oldSnapshot);
  assert.deepEqual(repository.cache, oldSnapshot);
});

test('replace 对 90% 至 1MB 的候选只预警而不阻断', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const candidate = repository.read();
  candidate.recoveryDraft = {
    reason: 'x'.repeat(Math.ceil(1024 * 1024 * 0.9)),
    timer: clone(candidate.timer),
    createdAt: candidate.updatedAt
  };
  storage.setCalls.length = 0;

  const usage = repository.getStorageUsage(candidate);
  const saved = repository.replace(candidate);

  assert.equal(usage.warning, true);
  assert.equal(usage.exceeded, false);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY]);
  assert.deepEqual(saved, candidate);
});

test('无参数容量读模型按主键实际持久化原值计量而非规范化缓存', () => {
  const stored = createInitialDatabase(1_700_000_000_000);
  const raw = JSON.stringify({
    ...stored,
    unknownPadding: 'x'.repeat(Math.ceil(1024 * 1024 * 0.9))
  }, null, 2);
  const storage = new FaultStorage();
  storage.set(STORAGE_KEY, raw);
  storage.setCalls.length = 0;
  const repository = new LocalRepository(storage);
  const normalized = repository.initialize();

  const persistedUsage = repository.getStorageUsage();
  const candidateUsage = repository.getStorageUsage(normalized);

  assert.equal(persistedUsage.warning, true);
  assert.equal(persistedUsage.databaseBytes, Buffer.byteLength(raw, 'utf8'));
  assert.equal(candidateUsage.warning, false);
  assert.deepEqual(storage.setCalls, []);
});

test('90% 候选清理迁移备份失败仍归类为写入错误而非容量错误', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  const candidate = clone(oldSnapshot);
  candidate.recoveryDraft = {
    reason: 'x'.repeat(Math.ceil(1024 * 1024 * 0.9)),
    timer: clone(candidate.timer),
    createdAt: candidate.updatedAt
  };
  storage.set(BACKUP_KEY, { schemaVersion: 0, sentinel: 'migration-backup' });
  storage.setCalls.length = 0;
  storage.failRemove = true;

  const error = captureThrown(
    () => repository.replace(candidate, { clearMigrationBackup: true })
  );

  assert.equal(error.code, 'WRITE_FAILED');
  assert.match(error.message, /已保留当前数据/);
  assert.deepEqual(storage.get(STORAGE_KEY), oldSnapshot);
  assert.deepEqual(repository.cache, oldSnapshot);
});

test('平台报告 quota 写入失败时恢复旧值并映射容量错误', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  storage.setCalls.length = 0;
  storage.failSetMessage = 'storage quota exceeded';
  storage.failSetAfterWriteOnce = true;

  const error = captureThrown(() => repository.transaction((database) => {
    database.localProfile.updatedAt += 1;
  }));

  assert.equal(error instanceof StorageError, true);
  assert.equal(error.code, 'STORAGE_CAPACITY_EXCEEDED');
  assert.equal(error.details.usage.exceeded, false);
  assert.deepEqual(storage.get(STORAGE_KEY), oldSnapshot);
  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY, STORAGE_KEY]);
});

test('quota 写后失败且补偿失败时优先报告数据状态不确定', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  storage.setCalls.length = 0;
  storage.failSetMessage = 'storage quota exceeded';
  storage.failSetAfterWriteOnce = true;
  storage.failSetOnCall = 2;

  const error = captureThrown(() => repository.transaction((database) => {
    database.localProfile.updatedAt += 1;
  }));

  assert.equal(error.code, 'WRITE_FAILED');
  assert.match(error.message, /无法确认原数据是否完整保留/);
  assert.equal(error.details, null);
  assert.notDeepEqual(storage.get(STORAGE_KEY), oldSnapshot);
  assert.deepEqual(repository.cache, oldSnapshot);
});

test('reset 原子建立不含分类聚合的新资料库和空运行态', () => {
  const storage = new FaultStorage();
  const { repository, setNow } = createRepository(storage);
  const oldSnapshot = repository.read();
  storage.set(BACKUP_KEY, { schemaVersion: 0, sentinel: 'migration-backup' });
  storage.setCalls.length = 0;
  setNow(1_700_000_001_000);

  const reset = repository.reset();

  assert.notEqual(reset.localProfile.id, oldSnapshot.localProfile.id);
  assert.equal(reset.localProfile.createdAt, 1_700_000_001_000);
  assert.equal(Object.prototype.hasOwnProperty.call(reset, 'categories'), false);
  for (const collection of ['wishes', 'projects', 'tasks', 'calendarEvents', 'repeatRules', 'occurrenceExceptions', 'timeLogs']) {
    assert.deepEqual(reset[collection], []);
  }
  assert.deepEqual(reset.timer, { status: 'idle', startedAt: null, pausedAt: null, pauses: [], draft: {} });
  assert.equal(reset.recoveryDraft, null);
  assert.equal(storage.has(BACKUP_KEY), false);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY]);
  assert.deepEqual(storage.removeCalls, [BACKUP_KEY]);
});

test('reset 主快照写入失败时保留旧资料库', () => {
  const storage = new FaultStorage();
  const { repository } = createRepository(storage);
  const oldSnapshot = repository.read();
  storage.setCalls.length = 0;
  storage.failSet = true;

  assert.throws(
    () => repository.reset(),
    (error) => error instanceof StorageError && error.code === 'WRITE_FAILED'
  );

  assert.deepEqual(storage.get(STORAGE_KEY), oldSnapshot);
  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY, STORAGE_KEY]);
  assert.deepEqual(storage.removeCalls, [BACKUP_KEY]);
});

test('reset 主快照已写入后抛错会恢复旧存储、旧备份和旧缓存', () => {
  const storage = new FaultStorage();
  const { repository, setNow } = createRepository(storage);
  const oldSnapshot = repository.read();
  const backup = { schemaVersion: 0, sentinel: 'reset-after-write-backup' };
  storage.set(BACKUP_KEY, backup);
  storage.setCalls.length = 0;
  storage.failSetAfterWriteOnce = true;
  setNow(1_700_000_001_000);

  assert.throws(
    () => repository.reset(),
    (error) => error instanceof StorageError
      && error.code === 'WRITE_FAILED'
      && /已保留/.test(error.message)
  );

  assert.deepEqual(storage.get(STORAGE_KEY), oldSnapshot);
  assert.deepEqual(storage.get(BACKUP_KEY), backup);
  assert.deepEqual(repository.cache, oldSnapshot);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY, STORAGE_KEY, BACKUP_KEY]);
  assert.deepEqual(storage.removeCalls, []);
});

test('仓储和存储适配器实现都不调用 wx.clearStorageSync', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const repositorySource = fs.readFileSync(
    path.join(__dirname, '../miniprogram/repository/local-repository.js'),
    'utf8'
  );
  const adapterSource = fs.readFileSync(
    path.join(__dirname, '../miniprogram/repository/storage-adapter.js'),
    'utf8'
  );

  assert.doesNotMatch(repositorySource, /wx\.clearStorageSync\s*\(/);
  assert.doesNotMatch(adapterSource, /wx\.clearStorageSync\s*\(/);
});

test('WxStorageAdapter.remove 只调用目标键的 wx.removeStorageSync', () => {
  const previousWx = global.wx;
  const calls = [];
  global.wx = {
    removeStorageSync(key) {
      calls.push(['removeStorageSync', key]);
    },
    clearStorageSync() {
      calls.push(['clearStorageSync']);
    }
  };

  try {
    const storage = new WxStorageAdapter();
    storage.remove('target-key');
  } finally {
    if (previousWx === undefined) {
      delete global.wx;
    } else {
      global.wx = previousWx;
    }
  }

  assert.deepEqual(calls, [['removeStorageSync', 'target-key']]);
});

test('WxStorageAdapter.has 只通过同步键列表判断键是否存在', () => {
  const previousWx = global.wx;
  const calls = [];
  global.wx = {
    getStorageInfoSync() {
      calls.push('getStorageInfoSync');
      return { keys: ['stored-falsy'] };
    },
    getStorageSync() {
      calls.push('getStorageSync');
      return '';
    }
  };

  try {
    const storage = new WxStorageAdapter();
    assert.equal(storage.has('stored-falsy'), true);
    assert.equal(storage.has('missing'), false);
  } finally {
    if (previousWx === undefined) delete global.wx; else global.wx = previousWx;
  }

  assert.deepEqual(calls, ['getStorageInfoSync', 'getStorageInfoSync']);
});

test('MemoryStorageAdapter.info 使用 KB 单位并返回独立键列表', () => {
  const storage = new MemoryStorageAdapter();
  storage.set('a', 'x');

  const first = storage.info();
  first.keys.push('mutated');
  const second = storage.info();

  assert.equal(first.currentSize, 1);
  assert.equal(first.limitSize, 10240);
  assert.deepEqual(second.keys, ['a']);
});

test('WxStorageAdapter.info 保留平台容量字段并克隆键列表', () => {
  const previousWx = global.wx;
  const platformInfo = {
    keys: ['plan-and-record.database'],
    currentSize: 128,
    limitSize: 10240,
    extra: 'kept'
  };
  global.wx = {
    getStorageInfoSync() { return platformInfo; }
  };

  try {
    const info = new WxStorageAdapter().info();
    info.keys.push('mutated');

    assert.equal(info.currentSize, 128);
    assert.equal(info.limitSize, 10240);
    assert.equal(info.extra, 'kept');
    assert.deepEqual(platformInfo.keys, ['plan-and-record.database']);
  } finally {
    if (previousWx === undefined) delete global.wx; else global.wx = previousWx;
  }
});
