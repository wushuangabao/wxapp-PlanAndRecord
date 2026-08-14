function normalizedDisplayNote(note) {
  return String(note || '')
    .replace(/[\s\u200B-\u200D\uFEFF]+/g, ' ')
    .trim();
}

function displayLogTitle(log = {}) {
  return normalizedDisplayNote(log.note)
    || log.taskNameSnapshot
    || '时间记录';
}

module.exports = {
  displayLogTitle,
  normalizedDisplayNote
};
