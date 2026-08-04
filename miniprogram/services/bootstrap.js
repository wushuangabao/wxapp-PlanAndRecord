const { LocalRepository } = require('../repository/local-repository');
const { WxStorageAdapter } = require('../repository/storage-adapter');
const { ApplicationService } = require('./application-service');
const { DataRecoveryService } = require('./data-recovery-service');
const { WxExportTempFileStore } = require('./export-temp-file-store');
const { createDisabledPorts } = require('./ports');
const { MAX_TIMER_SPAN_MS } = require('../domain/constants');
const { StorageError } = require('../domain/errors');

const DEVELOPMENT_RECOVERY_TIMER_SPAN_MS = 8 * 1000;

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
  const exportTempFileStore = options.exportTempFileStore || new WxExportTempFileStore();
  const ApplicationServiceClass = options.ApplicationServiceClass || ApplicationService;
  const DataRecoveryServiceClass = options.DataRecoveryServiceClass || DataRecoveryService;

  try {
    repository.initialize();
  } catch (error) {
    if (!(error instanceof StorageError)
      || !['DATA_CORRUPTED', 'DATA_VERSION_UNSUPPORTED'].includes(error.code)) {
      throw error;
    }
    return {
      phase: 'M1',
      mode: 'data-recovery',
      initializedAt: now(),
      recoveryReason: error.code,
      recoveryService: new DataRecoveryServiceClass({
        repository,
        storage,
        exportTempFileStore,
        now
      })
    };
  }

  const applicationService = new ApplicationServiceClass(repository, {
    now,
    exportTempFileStore,
    ...createRecoveryTimerOptions(getRuntimeAccountInfo())
  });
  const recovery = applicationService.initialize();
  return {
    phase: 'M1',
    mode: 'ready',
    initializedAt: now(),
    applicationService,
    ports: createDisabledPorts(repository),
    recovery
  };
}

module.exports = {
  DEVELOPMENT_RECOVERY_TIMER_SPAN_MS,
  createBootstrapState,
  createRecoveryTimerOptions
};
