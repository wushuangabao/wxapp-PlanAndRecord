const { normalizeJsonSnapshot } = require('../repository/json-snapshot');

function exportJson(database) {
  return JSON.stringify(normalizeJsonSnapshot(database), null, 2);
}

module.exports = {
  exportJson
};
