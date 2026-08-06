const { LocalRepository } = require('../repository/local-repository');
const { WxStorageAdapter } = require('../repository/storage-adapter');
const { ApplicationService } = require('./application-service');
const { DataRecoveryService } = require('./data-recovery-service');
const { WxExportTempFileStore } = require('./export-temp-file-store');
const { LocalPreferenceStore } = require('./local-preference-store');
const { createDisabledPorts } = require('./ports');
const { MAX_TIMER_SPAN_MS } = require('../domain/constants');
const { StorageError } = require('../domain/errors');

const DEVELOPMENT_RECOVERY_TIMER_SPAN_MS = 8 * 1000;
const RECOVERY_ERROR_CODES = new Set([
  'DATA_CORRUPTED',
  'DATA_VERSION_UNSUPPORTED',
  'MIGRATION_PATH_MISSING',
  'MIGRATION_FAILED',
  'MIGRATION_ROLLBACK_UNCERTAIN'
]);

function createRecoveryTimerOptions(accountInfo) {
  const envVersion = accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.envVersion;
  if (envVersion === 'develop') {
    return {
      recoveryTimerSpanMs: DEVELOPMENT_RECOVERY_TIMER_SPAN_MS
    };
  }
  return {
    recoveryTimerSpanMs: MAX_TIMER_SPAN_MS
  };
}

function getRuntimeAccountInfo() {
  if (typeof wx === 'undefined' || typeof wx.getAccountInfoSync !== 'function') {
    return null;
  }
  return wx.getAccountInfoSync();
}

function createBootstrapState(options = {}) {
  const now = options.now || Date.now;
  const storage = options.storage || new WxStorageAdapter();
  const repository = options.repository || new LocalRepository(storage, { now });
  const preferenceStore = options.preferenceStore || new LocalPreferenceStore(storage);
  const exportTempFileStore = options.exportTempFileStore || new WxExportTempFileStore();
  const ApplicationServiceClass = options.ApplicationServiceClass || ApplicationService;
  const DataRecoveryServiceClass = options.DataRecoveryServiceClass || DataRecoveryService;

  try {
    repository.initialize();
  } catch (error) {
    if (!(error instanceof StorageError)
      || !RECOVERY_ERROR_CODES.has(error.code)) {
      throw error;
    }
    return {
      phase: 'M1',
      mode: 'data-recovery',
      initializedAt: now(),
      recoveryReason: error.code,
      preferences: preferenceStore,
      recoveryService: new DataRecoveryServiceClass({
        repository,
        storage,
        preferenceStore,
        exportTempFileStore,
        now
      })
    };
  }

  const applicationService = new ApplicationServiceClass(repository, {
    now,
    exportTempFileStore,
    preferenceStore,
    ...createRecoveryTimerOptions(getRuntimeAccountInfo())
  });
  let recovery = null;
  let recoveryError = null;
  try {
    recovery = applicationService.initialize();
  } catch (error) {
    if (!error || error.code !== 'STORAGE_CAPACITY_EXCEEDED') throw error;
    recoveryError = error;
  }
  return {
    phase: 'M1',
    mode: 'ready',
    initializedAt: now(),
    applicationService,
    preferences: preferenceStore,
    ports: createDisabledPorts(repository),
    recovery,
    recoveryError
  };
}

module.exports = {
  DEVELOPMENT_RECOVERY_TIMER_SPAN_MS,
  createBootstrapState,
  createRecoveryTimerOptions
};
