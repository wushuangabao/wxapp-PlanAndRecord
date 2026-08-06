const DATABASE_STORAGE_LIMIT_BYTES = 1024 * 1024;
const TOTAL_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024;
const STORAGE_WARNING_RATIO = 0.9;

function utf8ByteLength(value) {
  const text = String(value);
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function buildStorageUsage(snapshotOrJson, storageInfo = {}) {
  const json = typeof snapshotOrJson === 'string'
    ? snapshotOrJson
    : JSON.stringify(snapshotOrJson);
  const databaseBytes = utf8ByteLength(json);
  const totalBytes = Number.isFinite(storageInfo.currentSize)
    ? storageInfo.currentSize * 1024
    : null;
  const totalLimitBytes = Number.isFinite(storageInfo.limitSize)
    ? storageInfo.limitSize * 1024
    : TOTAL_STORAGE_LIMIT_BYTES;
  const ratio = databaseBytes / DATABASE_STORAGE_LIMIT_BYTES;
  return {
    databaseBytes,
    databaseLimitBytes: DATABASE_STORAGE_LIMIT_BYTES,
    ratio,
    percent: Math.min(100, Math.round(ratio * 1000) / 10),
    warning: ratio >= STORAGE_WARNING_RATIO,
    exceeded: databaseBytes > DATABASE_STORAGE_LIMIT_BYTES,
    totalBytes,
    totalLimitBytes
  };
}

function isLikelyCapacityFailure(error, attemptedBytes = 0) {
  const message = [error && error.message, error && error.errMsg]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return /exceed|max size|quota|storage full|disk full/.test(message)
    || attemptedBytes >= DATABASE_STORAGE_LIMIT_BYTES * STORAGE_WARNING_RATIO;
}

module.exports = {
  DATABASE_STORAGE_LIMIT_BYTES,
  TOTAL_STORAGE_LIMIT_BYTES,
  STORAGE_WARNING_RATIO,
  utf8ByteLength,
  buildStorageUsage,
  isLikelyCapacityFailure
};
