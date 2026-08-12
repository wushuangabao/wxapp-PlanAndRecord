const { normalizeJsonSnapshot } = require('../repository/json-snapshot');
const { createIdleTimer } = require('../domain/entities');

function exportJson(database) {
  const exported = normalizeJsonSnapshot(database);
  exported.timer = createIdleTimer();
  exported.recoveryDraft = null;
  return JSON.stringify(exported, null, 2);
}

module.exports = {
  exportJson
};
