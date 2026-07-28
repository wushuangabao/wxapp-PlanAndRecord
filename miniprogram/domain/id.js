function createId(prefix, now = Date.now(), random = Math.random()) {
  const timePart = Math.floor(now).toString(36);
  const randomPart = Math.floor(random * 0x100000000).toString(36).padStart(7, '0');
  return `${prefix}_${timePart}_${randomPart}`;
}

module.exports = {
  createId
};
