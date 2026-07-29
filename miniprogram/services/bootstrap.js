const { LocalRepository } = require('../repository/local-repository');
const { WxStorageAdapter } = require('../repository/storage-adapter');
const { ApplicationService } = require('./application-service');
const { WxExportTempFileStore } = require('./export-temp-file-store');
const { createDisabledPorts } = require('./ports');

function createBootstrapState() {
  const repository = new LocalRepository(new WxStorageAdapter());
  const applicationService = new ApplicationService(repository, {
    exportTempFileStore: new WxExportTempFileStore()
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
  createBootstrapState
};
