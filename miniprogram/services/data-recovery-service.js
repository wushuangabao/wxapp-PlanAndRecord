const { createInitialDatabase, clone } = require('../domain/entities');
const { DomainError } = require('../domain/errors');
const { createId } = require('../domain/id');
const { IMPORT_MODE, createImportAnalysis, resolveImportAnalysis } = require('../repository/json-import');
const { parseJsonSnapshot } = require('../repository/json-snapshot');
const { STORAGE_KEY } = require('../repository/local-repository');

class DataRecoveryService {
  constructor({ repository, storage, exportTempFileStore, now = Date.now }) {
    this.repository = repository;
    this.storage = storage;
    this.exportTempFileStore = exportTempFileStore;
    this.now = now;
    this.pendingReplacements = new Map();
  }

  exportRawData() {
    const rawValue = this.storage.get(STORAGE_KEY);
    if (typeof rawValue === 'string') return rawValue;
    try {
      const jsonText = JSON.stringify(rawValue, null, 2);
      return jsonText === undefined ? String(rawValue) : jsonText;
    } catch (error) {
      return String(rawValue);
    }
  }

  prepareReplacement(jsonText) {
    const importedDatabase = parseJsonSnapshot(jsonText);
    const now = this.now();
    const analysis = createImportAnalysis(
      createInitialDatabase(now),
      importedDatabase,
      { mode: IMPORT_MODE.REPLACE, now }
    );
    const resolved = resolveImportAnalysis(analysis);
    const token = createId('recovery-replacement', now);
    this.pendingReplacements.set(token, clone(resolved.database));
    return {
      token,
      schemaVersion: importedDatabase.schemaVersion,
      addedCounts: clone(resolved.summary.addedCounts),
      repairedReferenceCount: resolved.summary.repairedReferenceCount,
      discardedExceptionCount: resolved.summary.discardedExceptionCount,
      resetsRuntime: true
    };
  }

  requireReplacement(token) {
    const database = this.pendingReplacements.get(token);
    if (!database) {
      throw new DomainError('RECOVERY_REPLACEMENT_NOT_FOUND', '恢复预览已失效，请重新选择 JSON 文件');
    }
    return database;
  }

  commitReplacement(token) {
    const database = this.requireReplacement(token);
    this.pendingReplacements.delete(token);
    this.repository.replace(database, { clearMigrationBackup: true });
    return { replaced: true };
  }

  cancelReplacement(token) {
    this.pendingReplacements.delete(token);
  }

  clearAllData(confirmed) {
    if (confirmed !== true) {
      throw new DomainError('CLEAR_CONFIRMATION_REQUIRED', '清空全部本地数据需要明确确认');
    }
    if (!this.exportTempFileStore || typeof this.exportTempFileStore.removeAllStrict !== 'function') {
      throw new DomainError(
        'EXPORT_TEMP_FILE_STORE_UNAVAILABLE',
        '无法确认临时导出文件已清理，数据未清空，请重试'
      );
    }
    this.exportTempFileStore.removeAllStrict();
    const database = createInitialDatabase(this.now());
    this.repository.replace(database, { clearMigrationBackup: true });
    this.pendingReplacements.clear();
    return {
      cleared: true,
      localProfileId: database.localProfile.id
    };
  }
}

module.exports = {
  DataRecoveryService
};
