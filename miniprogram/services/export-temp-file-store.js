const { DomainError } = require('../domain/errors');

const CURRENT_EXPORT_TEMP_FILE_NAME = 'plan-and-record-share.json';
const LEGACY_EXPORT_FILE_NAMES = ['plan-and-record-share.csv'];
const LEGACY_EXPORT_FILE_PATTERNS = [
  /^plan-and-record-\d{13}\.json$/,
  /^plan-and-record-logs-\d{13}\.csv$/
];

function errorMessage(error) {
  return error && (error.errMsg || error.message) ? (error.errMsg || error.message) : '';
}

function isMissingFileError(error) {
  return /no such file|not found|enoent/i.test(errorMessage(error));
}

function isOwnedExportTempFileName(fileName) {
  return typeof fileName === 'string'
    && (
      fileName === CURRENT_EXPORT_TEMP_FILE_NAME
      || LEGACY_EXPORT_FILE_NAMES.includes(fileName)
      || LEGACY_EXPORT_FILE_PATTERNS.some((pattern) => pattern.test(fileName))
    );
}

function joinUserDataPath(userDataPath, fileName) {
  return `${String(userDataPath).replace(/\/+$/, '')}/${fileName}`;
}

function cleanupFailedError() {
  return new DomainError(
    'EXPORT_TEMP_FILE_CLEANUP_FAILED',
    '无法确认临时导出文件已清理，数据未清空，请重试'
  );
}

class WxExportTempFileStore {
  constructor(options = {}) {
    this.getFileSystemManager = options.getFileSystemManager
      || (() => wx.getFileSystemManager());
    this.getUserDataPath = options.getUserDataPath
      || (() => wx.env.USER_DATA_PATH);
  }

  removeAllStrict() {
    let fileSystemManager;
    let userDataPath;
    let fileNames;
    try {
      fileSystemManager = this.getFileSystemManager();
      userDataPath = this.getUserDataPath();
      if (!fileSystemManager || typeof userDataPath !== 'string' || !userDataPath) {
        throw new Error('export temp file store unavailable');
      }
      fileNames = fileSystemManager.readdirSync(userDataPath);
    } catch (error) {
      throw cleanupFailedError();
    }

    if (!Array.isArray(fileNames)) {
      throw cleanupFailedError();
    }

    const ownedFileNames = fileNames.filter(isOwnedExportTempFileName);
    for (const fileName of ownedFileNames) {
      try {
        fileSystemManager.unlinkSync(joinUserDataPath(userDataPath, fileName));
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw cleanupFailedError();
        }
      }
    }

    return {
      removedCount: ownedFileNames.length
    };
  }
}

module.exports = {
  CURRENT_EXPORT_TEMP_FILE_NAME,
  LEGACY_EXPORT_FILE_NAMES,
  LEGACY_EXPORT_FILE_PATTERNS,
  WxExportTempFileStore,
  isMissingFileError,
  isOwnedExportTempFileName,
  joinUserDataPath
};
