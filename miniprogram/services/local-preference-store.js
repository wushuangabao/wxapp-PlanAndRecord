const { clone } = require('../domain/entities');
const { DomainError } = require('../domain/errors');

const PREFERENCES = Object.freeze({
  TODO_SORT: Object.freeze({ key: 'plan-and-record.todo-sort.v1', version: 1 }),
  PROJECT_COLLAPSE: Object.freeze({ key: 'plan-and-record.project-collapse.v1', version: 1 }),
  RECENT_LOG_HIGHLIGHT: Object.freeze({ key: 'plan-and-record.recent-log-highlight', version: 1 })
});

function cloneValue(value) {
  return value === undefined ? undefined : clone(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

class LocalPreferenceStore {
  constructor(storage) {
    this.storage = storage;
  }

  read(name, profileId, fallback) {
    const preference = PREFERENCES[name];
    if (!preference || typeof profileId !== 'string' || !profileId) {
      return cloneValue(fallback);
    }
    try {
      if (typeof this.storage.has !== 'function' || !this.storage.has(preference.key)) {
        return cloneValue(fallback);
      }
      const envelope = this.storage.get(preference.key);
      if (!isPlainObject(envelope)
        || envelope.version !== preference.version
        || envelope.profileId !== profileId
        || !Object.prototype.hasOwnProperty.call(envelope, 'value')) {
        return cloneValue(fallback);
      }
      return cloneValue(envelope.value);
    } catch (error) {
      return cloneValue(fallback);
    }
  }

  write(name, profileId, value) {
    const preference = PREFERENCES[name];
    if (!preference || typeof profileId !== 'string' || !profileId) return false;
    try {
      this.storage.set(preference.key, {
        version: preference.version,
        profileId,
        value: cloneValue(value)
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  remove(name) {
    const preference = PREFERENCES[name];
    if (!preference) return false;
    try {
      this.storage.remove(preference.key);
      return true;
    } catch (error) {
      return false;
    }
  }

  captureAll() {
    const captured = {};
    try {
      for (const [name, preference] of Object.entries(PREFERENCES)) {
        const exists = this.storage.has(preference.key);
        captured[name] = {
          exists,
          value: exists ? cloneValue(this.storage.get(preference.key)) : null
        };
      }
      return captured;
    } catch (error) {
      throw new DomainError(
        'PREFERENCE_CLEAR_FAILED',
        '无法确认界面设置已安全清理，业务数据未清空，请重试'
      );
    }
  }

  clearAllStrict() {
    const captured = this.captureAll();
    try {
      for (const [name, preference] of Object.entries(PREFERENCES)) {
        if (captured[name].exists) this.storage.remove(preference.key);
      }
      return captured;
    } catch (error) {
      const restored = this.restoreAllBestEffort(captured);
      throw new DomainError(
        'PREFERENCE_CLEAR_FAILED',
        restored
          ? '界面设置清理失败，已恢复原设置，业务数据未清空，请重试'
          : '界面设置清理失败且无法确认是否完整恢复，业务数据未清空，请重新进入核对'
      );
    }
  }

  restoreAllBestEffort(captured) {
    let restored = true;
    for (const [name, preference] of Object.entries(PREFERENCES)) {
      const item = captured && captured[name];
      if (!item || typeof item.exists !== 'boolean') {
        restored = false;
        continue;
      }
      try {
        if (item.exists) this.storage.set(preference.key, cloneValue(item.value));
        else this.storage.remove(preference.key);
      } catch (error) {
        restored = false;
      }
    }
    return restored;
  }

  clearAllBestEffort() {
    return Object.keys(PREFERENCES).reduce((success, name) => this.remove(name) && success, true);
  }
}

module.exports = {
  LocalPreferenceStore,
  PREFERENCES
};
