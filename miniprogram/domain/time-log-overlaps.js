const { LOG_STATUS } = require('./constants');

function isPersistedTimeLog(log) {
  return Boolean(log
    && typeof log === 'object'
    && typeof log.id === 'string'
    && log.id
    && log.virtual !== true
    && (log.status === LOG_STATUS.CONFIRMED || log.status === LOG_STATUS.CANDIDATE)
    && Number.isFinite(log.startedAt)
    && Number.isFinite(log.endedAt)
    && log.endedAt > log.startedAt);
}

function emptyMetadata() {
  return {
    totalCount: 0,
    confirmedCount: 0,
    candidateCount: 0
  };
}

function incrementMetadata(metadata, target, counterpart) {
  const current = metadata.get(target.id) || emptyMetadata();
  current.totalCount += 1;
  if (counterpart.status === LOG_STATUS.CONFIRMED) current.confirmedCount += 1;
  if (counterpart.status === LOG_STATUS.CANDIDATE) current.candidateCount += 1;
  metadata.set(target.id, current);
}

function buildTimeLogOverlapMetadata(logs) {
  const persistedLogs = (Array.isArray(logs) ? logs : []).filter(isPersistedTimeLog);
  const metadata = new Map();
  for (let firstIndex = 0; firstIndex < persistedLogs.length; firstIndex += 1) {
    const first = persistedLogs[firstIndex];
    for (let secondIndex = firstIndex + 1; secondIndex < persistedLogs.length; secondIndex += 1) {
      const second = persistedLogs[secondIndex];
      if (first.id === second.id) continue;
      if (first.startedAt < second.endedAt && second.startedAt < first.endedAt) {
        incrementMetadata(metadata, first, second);
        incrementMetadata(metadata, second, first);
      }
    }
  }
  return metadata;
}

module.exports = {
  buildTimeLogOverlapMetadata
};
