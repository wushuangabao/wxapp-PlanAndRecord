const { rangeForView } = require('../../utils/date-range');
const { getService, showError, showSaved } = require('../../utils/page');
const {
  CURRENT_EXPORT_TEMP_FILE_NAME,
  LEGACY_EXPORT_FILE_NAMES,
  LEGACY_EXPORT_FILE_PATTERNS
} = require('../../services/export-temp-file-store');
const IMPORT_MODE = {
  INCREMENTAL: 'incremental',
  REPLACE: 'replace'
};
const CONFLICT_POLICY = {
  KEEP_LOCAL: 'keep-local',
  USE_IMPORTED: 'use-imported'
};
let activeDataOperation = null;

function tempExportPath(tempFileName) {
  return `${wx.env.USER_DATA_PATH}/${tempFileName}`;
}

function twoDigits(value) {
  return value < 10 ? `0${value}` : String(value);
}

function formatExportTimestamp(timestamp) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    twoDigits(date.getMonth() + 1),
    twoDigits(date.getDate())
  ].join('') + '-' + [
    twoDigits(date.getHours()),
    twoDigits(date.getMinutes()),
    twoDigits(date.getSeconds())
  ].join('');
}

function errorMessage(error) {
  return error && (error.errMsg || error.message) ? (error.errMsg || error.message) : '';
}

function isMissingFileError(error) {
  return /no such file|not found/i.test(errorMessage(error));
}

function isUserCancelled(error) {
  return /cancel/i.test(errorMessage(error));
}

function removeTempExport(filePath, onComplete = () => {}) {
  let completed = false;
  const completeOnce = () => {
    if (completed) return;
    completed = true;
    onComplete();
  };
  try {
    wx.getFileSystemManager().unlink({
      filePath,
      success: completeOnce,
      fail: (error) => {
        if (!isMissingFileError(error)) {
          console.warn('导出临时文件清理失败', { filePath, error });
        }
        completeOnce();
      }
    });
  } catch (error) {
    if (!isMissingFileError(error)) {
      console.warn('导出临时文件清理失败', { filePath, error });
    }
    completeOnce();
  }
}

function removeTempExportSync(fileSystemManager, filePath) {
  try {
    fileSystemManager.unlinkSync(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      console.warn('导出临时文件清理失败', { filePath, error });
    }
  }
}

function cleanupStaleExports() {
  let fileSystemManager;
  try {
    fileSystemManager = wx.getFileSystemManager();
  } catch (error) {
    console.warn('导出临时文件清理失败', { error });
    return;
  }
  [CURRENT_EXPORT_TEMP_FILE_NAME].concat(LEGACY_EXPORT_FILE_NAMES)
    .forEach((tempFileName) => {
      removeTempExportSync(fileSystemManager, tempExportPath(tempFileName));
    });
  try {
    fileSystemManager.readdirSync(wx.env.USER_DATA_PATH)
      .filter((fileName) => (
        LEGACY_EXPORT_FILE_PATTERNS.some((pattern) => pattern.test(fileName))
      ))
      .forEach((fileName) => {
        removeTempExportSync(fileSystemManager, tempExportPath(fileName));
      });
  } catch (error) {
    console.warn('导出目录读取失败', { error });
  }
}

function setDataOperationInProgress(page, dataOperationInProgress) {
  if (page && typeof page.setData === 'function') {
    page.setData({ dataOperationInProgress });
  }
}

function beginDataOperation(page, kind, phase) {
  if (activeDataOperation) {
    wx.showToast({ title: '数据管理操作进行中，请稍候', icon: 'none' });
    return null;
  }
  const operation = {
    page,
    kind,
    phase,
    cleanupStarted: false,
    token: null,
    service: null
  };
  activeDataOperation = operation;
  setDataOperationInProgress(page, true);
  return operation;
}

function isCurrentOperation(operation, phase) {
  return activeDataOperation === operation
    && !operation.cleanupStarted
    && (phase === undefined || operation.phase === phase);
}

function advanceOperation(operation, expectedPhase, nextPhase) {
  if (!isCurrentOperation(operation, expectedPhase)) return false;
  operation.phase = nextPhase;
  return true;
}

function finishDataOperation(operation) {
  if (activeDataOperation !== operation) return;
  activeDataOperation = null;
  setDataOperationInProgress(operation.page, false);
}

function finishExport(operation, filePath) {
  if (activeDataOperation !== operation || operation.cleanupStarted) return;
  operation.cleanupStarted = true;
  operation.phase = 'cleaning-export';
  removeTempExport(filePath, () => finishDataOperation(operation));
}

function cancelPendingImport(operation) {
  if (!operation.token || !operation.service) return;
  const token = operation.token;
  operation.token = null;
  try {
    operation.service.cancelJsonImport(token);
  } catch (error) {
    console.warn('导入会话清理失败', { token, error });
  }
}

function finishImport(operation) {
  if (activeDataOperation !== operation) return;
  cancelPendingImport(operation);
  finishDataOperation(operation);
}

function failImportApi(operation, expectedPhase, error, message) {
  if (!advanceOperation(operation, expectedPhase, 'finishing-import')) return;
  if (!isUserCancelled(error)) {
    wx.showToast({ title: message, icon: 'none' });
  }
  finishImport(operation);
}

function showUnsupportedShare(operation) {
  operation.phase = 'unsupported-export';
  const finishUnsupported = (error) => {
    if (!advanceOperation(operation, 'unsupported-export', 'finishing-export')) return;
    if (error && !isUserCancelled(error)) {
      wx.showToast({ title: '无法显示提示，请重试', icon: 'none' });
    }
    finishDataOperation(operation);
  };
  try {
    wx.showModal({
      title: '暂不支持文件发送',
      content: '当前微信版本不支持直接发送文件，请升级微信后重试。',
      showCancel: false,
      success: () => finishUnsupported(),
      fail: finishUnsupported
    });
  } catch (error) {
    finishUnsupported(error);
  }
}

function confirmExportShare(operation, filePath, fileName) {
  const handleConfirmationFailure = (error) => {
    if (!advanceOperation(operation, 'confirming-export', 'finishing-export')) return;
    if (!isUserCancelled(error)) {
      console.error('导出发送确认失败', { fileName, error });
      wx.showToast({ title: '无法确认发送，请重试', icon: 'none' });
    }
    finishExport(operation, filePath);
  };

  try {
    wx.showModal({
      title: '文件已生成',
      content: '导出文件包含项目、记录、备注和标签。确认后建议选择“文件传输助手”，再从电脑微信另存；发送结束后会清理临时文件，此 JSON 可在本产品中手动导入。',
      confirmText: '继续发送',
      cancelText: '取消',
      success: (result) => {
        if (!isCurrentOperation(operation, 'confirming-export')) return;
        if (!result.confirm) {
          operation.phase = 'finishing-export';
          finishExport(operation, filePath);
          return;
        }
        operation.phase = 'sharing-export';
        try {
          wx.shareFileMessage({
            filePath,
            fileName,
            success: () => {
              if (!isCurrentOperation(operation, 'sharing-export')) return;
              console.info('导出文件已发送', { fileName });
              wx.showToast({ title: '文件已发送', icon: 'success' });
            },
            fail: (error) => {
              if (!isCurrentOperation(operation, 'sharing-export')) return;
              if (!isUserCancelled(error)) {
                console.error('导出文件发送失败', { fileName, error });
                wx.showToast({ title: '发送失败，请重试', icon: 'none' });
              }
              finishExport(operation, filePath);
            },
            complete: () => finishExport(operation, filePath)
          });
        } catch (error) {
          if (!isCurrentOperation(operation, 'sharing-export')) return;
          console.error('导出文件发送失败', { fileName, error });
          wx.showToast({ title: '发送失败，请重试', icon: 'none' });
          finishExport(operation, filePath);
        }
      },
      fail: handleConfirmationFailure
    });
  } catch (error) {
    handleConfirmationFailure(error);
  }
}

function shareExport(operation, { fileName, contentFactory }) {
  if (
    typeof wx.shareFileMessage !== 'function'
    || typeof wx.canIUse !== 'function'
    || !wx.canIUse('shareFileMessage')
  ) {
    showUnsupportedShare(operation);
    return;
  }

  const filePath = tempExportPath(CURRENT_EXPORT_TEMP_FILE_NAME);
  let content;
  try {
    content = contentFactory();
  } catch (error) {
    showError(error);
    finishDataOperation(operation);
    return;
  }

  operation.phase = 'writing-export';
  const handleWriteFailure = (error) => {
    if (!advanceOperation(operation, 'writing-export', 'finishing-export')) return;
    console.error('导出文件写入失败', { filePath, error });
    wx.showToast({ title: '导出失败，请重试', icon: 'none' });
    finishExport(operation, filePath);
  };
  try {
    wx.getFileSystemManager().writeFile({
      filePath,
      data: content,
      encoding: 'utf8',
      success: () => {
        if (!advanceOperation(operation, 'writing-export', 'confirming-export')) return;
        confirmExportShare(operation, filePath, fileName);
      },
      fail: handleWriteFailure
    });
  } catch (error) {
    handleWriteFailure(error);
  }
}

function addedCount(addedCounts) {
  return Object.keys(addedCounts || {}).reduce((sum, key) => {
    const count = addedCounts[key];
    return sum + (Number.isFinite(count) ? count : 0);
  }, 0);
}

function importModeLabel(mode) {
  return mode === IMPORT_MODE.REPLACE ? '覆盖本地数据' : '增量导入';
}

function conflictPolicyLabel(policy) {
  if (policy === CONFLICT_POLICY.KEEP_LOCAL) return '全部保留本地';
  if (policy === CONFLICT_POLICY.USE_IMPORTED) return '全部使用导入数据';
  return '无需选择';
}

function importPreviewContent(preview) {
  const summary = [
    `导入模式：${importModeLabel(preview.mode)}`,
    `新增 ${addedCount(preview.addedCounts)} 项，冲突 ${preview.conflictCount || 0} 项。`,
    `冲突策略：${conflictPolicyLabel(preview.conflictPolicy)}。`,
    `修复了 ${preview.repairedReferenceCount || 0} 个失效关联。`
  ].join('\n');
  if (preview.mode !== IMPORT_MODE.REPLACE) return summary;
  return `此操作将覆盖当前设备全部本地数据，并重置计时状态和恢复草稿。\n${summary}`;
}

function showImportConfirmation(operation, preview) {
  operation.phase = 'confirming-import';
  const handleConfirmationFailure = (error) => {
    if (!advanceOperation(operation, 'confirming-import', 'finishing-import')) return;
    if (!isUserCancelled(error)) {
      wx.showToast({ title: '无法确认导入，请重试', icon: 'none' });
    }
    finishImport(operation);
  };
  const isReplacement = preview.mode === IMPORT_MODE.REPLACE;

  try {
    wx.showModal({
      title: isReplacement ? '覆盖本地数据？' : '确认导入 JSON？',
      content: importPreviewContent(preview),
      confirmText: isReplacement ? '确认覆盖' : '确认导入',
      cancelText: '取消',
      confirmColor: isReplacement ? '#b91c1c' : '#16a34a',
      success: (result) => {
        if (!isCurrentOperation(operation, 'confirming-import')) return;
        if (!result.confirm) {
          operation.phase = 'finishing-import';
          finishImport(operation);
          return;
        }
        operation.phase = 'committing-import';
        try {
          operation.service.commitJsonImport(operation.token);
          operation.page.refresh();
          showSaved('导入完成');
        } catch (error) {
          showError(error);
        } finally {
          finishImport(operation);
        }
      },
      fail: handleConfirmationFailure
    });
  } catch (error) {
    handleConfirmationFailure(error);
  }
}

function chooseConflictPolicy(operation) {
  try {
    wx.showActionSheet({
      alertText: '本次导入存在数据冲突，请统一选择处理方式',
      itemList: ['全部保留本地', '全部使用导入数据'],
      success: (result) => {
        if (!advanceOperation(operation, 'choosing-conflict-policy', 'previewing-import')) return;
        if (result.tapIndex === 0) {
          operation.conflictPolicy = CONFLICT_POLICY.KEEP_LOCAL;
        } else if (result.tapIndex === 1) {
          operation.conflictPolicy = CONFLICT_POLICY.USE_IMPORTED;
        } else {
          wx.showToast({ title: '冲突处理方式无效，请重试', icon: 'none' });
          finishImport(operation);
          return;
        }
        previewImport(operation);
      },
      fail: (error) => {
        failImportApi(
          operation,
          'choosing-conflict-policy',
          error,
          '无法选择冲突处理方式，请重试'
        );
      }
    });
  } catch (error) {
    failImportApi(
      operation,
      'choosing-conflict-policy',
      error,
      '无法选择冲突处理方式，请重试'
    );
  }
}

function previewImport(operation) {
  if (!isCurrentOperation(operation, 'previewing-import')) return;
  const options = { mode: operation.mode };
  if (operation.conflictPolicy) {
    options.conflictPolicy = operation.conflictPolicy;
  }

  let preview;
  try {
    preview = operation.service.previewJsonImport(operation.token, options);
  } catch (error) {
    if (!advanceOperation(operation, 'previewing-import', 'finishing-import')) return;
    showError(error);
    finishImport(operation);
    return;
  }

  if (!isCurrentOperation(operation, 'previewing-import')) return;
  if (preview.requiresConflictPolicy) {
    operation.phase = 'choosing-conflict-policy';
    chooseConflictPolicy(operation);
    return;
  }
  showImportConfirmation(operation, preview);
}

function chooseImportMode(operation) {
  try {
    wx.showActionSheet({
      alertText: '请选择 JSON 导入方式',
      itemList: ['增量导入（保留本地）', '覆盖本地数据'],
      success: (result) => {
        if (!advanceOperation(operation, 'choosing-import-mode', 'previewing-import')) return;
        if (result.tapIndex === 0) {
          operation.mode = IMPORT_MODE.INCREMENTAL;
        } else if (result.tapIndex === 1) {
          operation.mode = IMPORT_MODE.REPLACE;
        } else {
          wx.showToast({ title: '导入方式无效，请重试', icon: 'none' });
          finishImport(operation);
          return;
        }
        previewImport(operation);
      },
      fail: (error) => {
        failImportApi(operation, 'choosing-import-mode', error, '无法选择导入方式，请重试');
      }
    });
  } catch (error) {
    failImportApi(operation, 'choosing-import-mode', error, '无法选择导入方式，请重试');
  }
}

function readImportFile(operation, filePath) {
  try {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'utf8',
      success: (result) => {
        if (!advanceOperation(operation, 'reading-import-file', 'preparing-import')) return;
        try {
          const prepared = operation.service.prepareJsonImport(result.data);
          operation.token = prepared.token;
          operation.phase = 'choosing-import-mode';
          chooseImportMode(operation);
        } catch (error) {
          if (!isCurrentOperation(operation, 'preparing-import')) return;
          operation.phase = 'finishing-import';
          showError(error);
          finishImport(operation);
        }
      },
      fail: (error) => {
        failImportApi(operation, 'reading-import-file', error, '读取 JSON 失败，请重试');
      }
    });
  } catch (error) {
    failImportApi(operation, 'reading-import-file', error, '读取 JSON 失败，请重试');
  }
}

function chooseImportFile(operation) {
  try {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json'],
      success: (result) => {
        if (!advanceOperation(operation, 'choosing-import-file', 'reading-import-file')) return;
        const file = result && Array.isArray(result.tempFiles) ? result.tempFiles[0] : null;
        if (!file || typeof file.path !== 'string' || !file.path) {
          wx.showToast({ title: '未选择有效的 JSON 文件', icon: 'none' });
          finishImport(operation);
          return;
        }
        readImportFile(operation, file.path);
      },
      fail: (error) => {
        failImportApi(operation, 'choosing-import-file', error, '无法选择 JSON 文件，请重试');
      }
    });
  } catch (error) {
    failImportApi(operation, 'choosing-import-file', error, '无法选择 JSON 文件，请重试');
  }
}

function confirmImportFileSelection(operation) {
  try {
    wx.showModal({
      title: '请选择并勾选 JSON 文件',
      content: '进入微信文件列表后，请点击文件旁边的圆形勾选框，再点“确定”。直接点击文件名只会尝试预览，无法完成导入。',
      confirmText: '去选择',
      cancelText: '取消',
      success: (result) => {
        if (!isCurrentOperation(operation, 'confirming-import-file-guidance')) return;
        if (!result.confirm) {
          operation.phase = 'finishing-import';
          finishImport(operation);
          return;
        }
        operation.phase = 'choosing-import-file';
        chooseImportFile(operation);
      },
      fail: (error) => {
        failImportApi(
          operation,
          'confirming-import-file-guidance',
          error,
          '无法显示文件选择提示，请重试'
        );
      }
    });
  } catch (error) {
    failImportApi(
      operation,
      'confirming-import-file-guidance',
      error,
      '无法显示文件选择提示，请重试'
    );
  }
}

Page({
  data: {
    categories: [],
    categoryName: '',
    renameId: '',
    renameValue: '',
    includeCandidates: false,
    dataOperationInProgress: false,
    statistics: null,
    categoryStats: [],
    projectStats: [],
    variance: [],
    overlaps: [],
    review: null
  },

  onLoad() {
    cleanupStaleExports();
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    try {
      const service = getService();
      const snapshot = service.snapshot();
      const range = rangeForView(Date.now(), 'week');
      const statistics = service.statistics({
        rangeStart: range.start,
        rangeEnd: range.end,
        includeCandidates: this.data.includeCandidates
      });
      this.setData({
        categories: snapshot.categories,
        statistics,
        categoryStats: statistics.categories,
        projectStats: statistics.projects,
        variance: statistics.planVariance.events,
        overlaps: statistics.overlaps,
        review: statistics.weeklyReview
      });
    } catch (error) {
      showError(error);
    }
  },

  onField(event) {
    this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
  },

  onCandidatesChange(event) {
    this.setData({ includeCandidates: event.detail.value }, () => this.refresh());
  },

  addCategory() {
    try {
      getService().createCategory(this.data.categoryName);
      this.setData({ categoryName: '' });
      showSaved();
      this.refresh();
    } catch (error) { showError(error); }
  },

  startRename(event) {
    const category = event.currentTarget.dataset.item;
    this.setData({ renameId: category.id, renameValue: category.name });
  },

  saveRename() {
    try {
      getService().renameCategory(this.data.renameId, this.data.renameValue);
      this.setData({ renameId: '', renameValue: '' });
      showSaved();
      this.refresh();
    } catch (error) { showError(error); }
  },

  archiveCategory(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: '归档分类',
      content: '归档后不能用于新记录，历史记录中的分类名称会保留。',
      success: (result) => {
        if (!result.confirm) return;
        try {
          getService().archiveCategory(id);
          showSaved('分类已归档');
          this.refresh();
        } catch (error) { showError(error); }
      }
    });
  },

  exportJson() {
    const operation = beginDataOperation(this, 'export', 'checking-export');
    if (!operation) return;
    shareExport(operation, {
      fileName: `plan-and-record-${formatExportTimestamp(Date.now())}.json`,
      contentFactory: () => getService().exportJson()
    });
  },

  importJson() {
    const operation = beginDataOperation(this, 'import', 'confirming-import-file-guidance');
    if (!operation) return;
    try {
      operation.service = getService();
      confirmImportFileSelection(operation);
    } catch (error) {
      showError(error);
      finishImport(operation);
    }
  },

  clearData() {
    const operation = beginDataOperation(this, 'clear', 'confirming-clear');
    if (!operation) return;
    try {
      operation.service = getService();
      wx.showModal({
        title: '清空全部数据？',
        content: '将删除当前设备中的全部用户数据、计时状态、恢复草稿、迁移备份，以及小程序内尚存的导出临时文件，并重建空资料库。已发送或另存的 JSON 不受影响，此操作无法撤销。',
        confirmText: '清空数据',
        cancelText: '取消',
        confirmColor: '#b91c1c',
        success: (result) => {
          if (!isCurrentOperation(operation, 'confirming-clear')) return;
          if (!result.confirm) {
            operation.phase = 'finishing-clear';
            finishDataOperation(operation);
            return;
          }
          operation.phase = 'committing-clear';
          try {
            operation.service.clearAllData(true);
            operation.page.refresh();
            showSaved('数据已清空');
          } catch (error) {
            showError(error);
          } finally {
            finishDataOperation(operation);
          }
        },
        fail: (error) => {
          if (!advanceOperation(operation, 'confirming-clear', 'finishing-clear')) return;
          if (!isUserCancelled(error)) {
            wx.showToast({ title: '无法确认清空，请重试', icon: 'none' });
          }
          finishDataOperation(operation);
        }
      });
    } catch (error) {
      if (isCurrentOperation(operation)) {
        showError(error);
        finishDataOperation(operation);
      }
    }
  }
});
