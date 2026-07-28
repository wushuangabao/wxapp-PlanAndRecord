const { DomainError } = require('../domain/errors');

class AnonymousIdentity {
  constructor(repository) {
    this.repository = repository;
  }

  getLocalProfileId() {
    return this.repository.read().localProfile.id;
  }
}

class DisabledPort {
  constructor(featureName) {
    this.featureName = featureName;
  }

  execute() {
    throw new DomainError('FEATURE_UNAVAILABLE', `当前版本暂不支持${this.featureName}`);
  }
}

function createDisabledPorts(repository) {
  return {
    identity: new AnonymousIdentity(repository),
    sync: new DisabledPort('云端同步'),
    import: new DisabledPort('智能导入'),
    entitlement: new DisabledPort('会员与支付'),
    reminder: new DisabledPort('云端提醒')
  };
}

module.exports = {
  AnonymousIdentity,
  DisabledPort,
  createDisabledPorts
};
