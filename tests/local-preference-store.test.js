const test = require('node:test');
const assert = require('node:assert/strict');

const { DomainError } = require('../miniprogram/domain/errors');
const { MemoryStorageAdapter } = require('../miniprogram/repository/storage-adapter');
const {
  LocalPreferenceStore,
  PREFERENCES
} = require('../miniprogram/services/local-preference-store');

function createFaultPreferenceStorage({ failRemoveKey = null, failSetKey = null } = {}) {
  const values = new Map();
  return {
    values,
    has: (key) => values.has(key),
    get: (key) => (values.has(key) ? structuredClone(values.get(key)) : ''),
    set(key, value) {
      if (key === failSetKey) throw new Error('set failed');
      values.set(key, structuredClone(value));
    },
    remove(key) {
      if (key === failRemoveKey) throw new Error('remove failed');
      values.delete(key);
    }
  };
}

test('同一偏好只对匹配的 localProfile 可见', () => {
  const store = new LocalPreferenceStore(new MemoryStorageAdapter());
  assert.equal(store.write('RECENT_LOG_HIGHLIGHT', 'profile_a', { logId: 'log_1' }), true);
  assert.deepEqual(store.read('RECENT_LOG_HIGHLIGHT', 'profile_a', null), { logId: 'log_1' });
  assert.equal(store.read('RECENT_LOG_HIGHLIGHT', 'profile_b', null), null);
});

test('格式错误、未知登记名和读取异常静默回退默认值', () => {
  const storage = new MemoryStorageAdapter();
  storage.set(PREFERENCES.TODO_SORT.key, { version: 1, profileId: 7, value: [] });
  const store = new LocalPreferenceStore(storage);
  const fallback = [{ field: 'createdAt' }];

  assert.deepEqual(store.read('TODO_SORT', 'profile_a', fallback), fallback);
  assert.deepEqual(store.read('UNKNOWN', 'profile_a', fallback), fallback);
  assert.notEqual(store.read('TODO_SORT', 'profile_a', fallback), fallback);
});

test('普通偏好写失败返回 false且不泄漏平台异常', () => {
  const store = new LocalPreferenceStore({
    has: () => false,
    set: () => { throw new Error('private write failed'); }
  });
  assert.equal(store.write('TODO_SORT', 'profile_a', []), false);
  assert.equal(store.write('UNKNOWN', 'profile_a', []), false);
  assert.equal(store.write('TODO_SORT', '', []), false);
});

test('严格清空删除失败会恢复此前已删除的偏好', () => {
  const storage = createFaultPreferenceStorage({
    failRemoveKey: PREFERENCES.PROJECT_COLLAPSE.key
  });
  const store = new LocalPreferenceStore(storage);
  store.write('TODO_SORT', 'profile_a', [{ field: 'createdAt' }]);
  store.write('PROJECT_COLLAPSE', 'profile_a', ['project_1']);

  assert.throws(
    () => store.clearAllStrict(),
    (error) => error instanceof DomainError
      && error.code === 'PREFERENCE_CLEAR_FAILED'
      && !/project_1|createdAt/.test(error.message)
  );
  assert.equal(storage.has(PREFERENCES.TODO_SORT.key), true);
  assert.equal(storage.has(PREFERENCES.PROJECT_COLLAPSE.key), true);
});

test('偏好快照可在后续失败时尽力恢复存在与缺失状态', () => {
  const storage = createFaultPreferenceStorage();
  const store = new LocalPreferenceStore(storage);
  store.write('TODO_SORT', 'profile_a', [{ field: 'title' }]);
  const captured = store.clearAllStrict();
  store.write('PROJECT_COLLAPSE', 'profile_a', ['project_new']);

  assert.equal(store.restoreAllBestEffort(captured), true);
  assert.deepEqual(store.read('TODO_SORT', 'profile_a', null), [{ field: 'title' }]);
  assert.equal(storage.has(PREFERENCES.PROJECT_COLLAPSE.key), false);
});
