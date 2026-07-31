const { LocalRepository } = require('../repository/local-repository');
const { WxStorageAdapter } = require('../repository/storage-adapter');
const { ApplicationService } = require('./application-service');
const { WxExportTempFileStore } = require('./export-temp-file-store');
const { createDisabledPorts } = require('./ports');
const { MAX_TIMER_SPAN_MS } = require('../domain/constants');

const DEVELOPMENT_RECOVERY_TIMER_SPAN_MS = 2 * 1000;

function createRecoveryTimerOptions(accountInfo) {
  const envVersion = accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.envVersion;
  if (envVersion === 'develop') {
    return {
      recoveryTimerSpanMs: DEVELOPMENT_RECOVERY_TIMER_SPAN_MS,
      minimumRecoveryDurationMinutes: 1
    };
  }
  return {
    recoveryTimerSpanMs: MAX_TIMER_SPAN_MS,
    minimumRecoveryDurationMinutes: 0
  };
}

function getRuntimeAccountInfo() {
  if (typeof wx === 'undefined' || typeof wx.getAccountInfoSync !== 'function') {
    return null;
  }
  return wx.getAccountInfoSync();
}

function createBootstrapState() {
  const repository = new LocalRepository(new WxStorageAdapter());
  const applicationService = new ApplicationService(repository, {
    exportTempFileStore: new WxExportTempFileStore(),
    ...createRecoveryTimerOptions(getRuntimeAccountInfo())
  });
  const recovery = applicationService.initialize();
  return {
    phase: 'M1',
    initializedAt: Date.now(),
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
