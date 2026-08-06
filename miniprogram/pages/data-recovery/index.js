const { getRecoveryService, showError } = require('../../utils/page');

const RECOVERY_COPY = {
  DATA_VERSION_UNSUPPORTED: [
    '数据来自较新版本',
    '当前小程序无法安全读取这份本地数据。你可以先导出原始数据，再用受支持的完整备份恢复，或明确清空后重新开始。'
  ],
  MIGRATION_PATH_MISSING: [
    '缺少数据升级步骤',
    '原始数据未被覆盖，请先导出原始数据并等待支持该版本的升级。'
  ],
  MIGRATION_FAILED: [
    '数据升级未完成',
    '升级失败后已恢复原始数据，请先导出核对再选择恢复方式。'
  ],
  MIGRATION_ROLLBACK_UNCERTAIN: [
    '无法确认数据是否完整',
    '请立即导出原始数据核对，不要继续业务写入。'
  ]
};

const DEFAULT_RECOVERY_COPY = [
  '本地数据损坏',
  '当前本地数据无法安全读取。为保护原始内容，小程序已经停止业务写入。你可以先导出原始数据，再用完整备份恢复，或明确清空后重新开始。'
];

function addedCount(addedCounts) {
  return Object.values(addedCounts || {}).reduce((total, value) => (
    total + (Number.isInteger(value) ? value : 0)
  ), 0);
}

Page({
  data: {
    title: '本地数据损坏',
    explanation: '',
    busy: false,
    rescueFileReady: false,
    rescueFilePath: '',
    rescueFileName: '',
    replacementToken: null,
    replacementPreview: null,
    replacementAddedCount: 0
  },

  onLoad() {
    const bootstrap = getApp().globalData.bootstrap;
    const reason = bootstrap && bootstrap.recoveryReason;
    const [title, explanation] = RECOVERY_COPY[reason] || DEFAULT_RECOVERY_COPY;
    this.setData({
      title,
      explanation
    });
  },

  onUnload() {
    if (this.data.replacementToken) {
      try {
        getRecoveryService().cancelReplacement(this.data.replacementToken);
      } catch (error) {
        // 页面卸载时只释放内存预览，不影响原始资料库。
      }
    }
  },

  clearReplacementPreview() {
    const token = this.data.replacementToken;
    this.setData({
      replacementToken: null,
      replacementPreview: null,
      replacementAddedCount: 0
    });
    if (token) {
      try {
        getRecoveryService().cancelReplacement(token);
      } catch (error) {
        // 本地预览已作废；取消内存 token 失败不能恢复其确认入口。
      }
    }
  },

  exportRawData() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      const content = getRecoveryService().exportRawData();
      const fileName = `plan-and-record-${Date.now()}.json`;
      const filePath = `${String(wx.env.USER_DATA_PATH).replace(/\/+$/, '')}/${fileName}`;
      wx.getFileSystemManager().writeFile({
        filePath,
        data: content,
        encoding: 'utf8',
        success: () => {
          this.setData({
            busy: false,
            rescueFileReady: true,
            rescueFilePath: filePath,
            rescueFileName: fileName
          });
          wx.showToast({ title: '救援文件已准备', icon: 'success' });
        },
        fail: () => {
          this.setData({ busy: false });
          wx.showToast({ title: '原始数据导出失败', icon: 'none' });
        }
      });
    } catch (error) {
      this.setData({ busy: false });
      showError(error);
    }
  },

  shareRawData() {
    if (!this.data.rescueFileReady || !this.data.rescueFilePath) return;
    const filePath = this.data.rescueFilePath;
    const fileName = this.data.rescueFileName;
    let cleanupStarted = false;
    const cleanupRescueFile = () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      if (this.data.rescueFilePath === filePath) {
        this.setData({
          rescueFileReady: false,
          rescueFilePath: '',
          rescueFileName: ''
        });
      }
      try {
        wx.getFileSystemManager().unlink({
          filePath,
          success: () => {},
          fail: () => console.warn('救援临时文件清理失败')
        });
      } catch (error) {
        console.warn('救援临时文件清理失败');
      }
    };
    try {
      wx.shareFileMessage({
        filePath,
        fileName,
        success: cleanupRescueFile,
        fail: (error) => {
          if (!error || !/cancel/i.test(error.errMsg || '')) {
            wx.showToast({ title: '发送失败，请重试', icon: 'none' });
          }
          cleanupRescueFile();
        },
        complete: cleanupRescueFile
      });
    } catch (error) {
      cleanupRescueFile();
      wx.showToast({ title: '发送失败，请重试', icon: 'none' });
    }
  },

  chooseReplacementFile() {
    if (this.data.busy) return;
    this.clearReplacementPreview();
    this.setData({ busy: true });
    try {
      wx.chooseMessageFile({
        count: 1,
        type: 'file',
        extension: ['json'],
        success: (result) => {
          const file = result && Array.isArray(result.tempFiles) ? result.tempFiles[0] : null;
          if (!file || !file.path) {
            this.setData({ busy: false });
            wx.showToast({ title: '未选择有效 JSON 文件，请重新选择', icon: 'none' });
            return;
          }
          this.readReplacementFile(file.path);
        },
        fail: (error) => {
          this.setData({ busy: false });
          wx.showToast({
            title: error && /cancel/i.test(error.errMsg || '')
              ? '未选择 JSON 文件，请重新选择'
              : '选择 JSON 文件失败，请重新选择',
            icon: 'none'
          });
        }
      });
    } catch (error) {
      this.setData({ busy: false });
      wx.showToast({ title: '选择 JSON 文件失败，请重新选择', icon: 'none' });
    }
  },

  readReplacementFile(filePath) {
    const handleReadFailure = () => {
      this.clearReplacementPreview();
      this.setData({ busy: false });
      wx.showToast({ title: '读取 JSON 失败，请重新选择文件', icon: 'none' });
    };
    try {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: 'utf8',
        success: (result) => {
          try {
            const service = getRecoveryService();
            const preview = service.prepareReplacement(result.data);
            this.setData({
              busy: false,
              replacementToken: preview.token,
              replacementPreview: preview,
              replacementAddedCount: addedCount(preview.addedCounts)
            });
          } catch (error) {
            this.clearReplacementPreview();
            this.setData({ busy: false });
            wx.showToast({ title: 'JSON 文件无效，请重新选择', icon: 'none' });
          }
        },
        fail: handleReadFailure
      });
    } catch (error) {
      handleReadFailure();
    }
  },

  confirmReplacement() {
    if (this.data.busy || !this.data.replacementToken) return;
    this.setData({ busy: true });
    try {
      getRecoveryService().commitReplacement(this.data.replacementToken);
      this.setData({
        replacementToken: null,
        replacementPreview: null,
        replacementAddedCount: 0
      });
      this.finishRecovery('数据恢复完成');
    } catch (error) {
      this.setData({
        busy: false,
        replacementToken: null,
        replacementPreview: null,
        replacementAddedCount: 0
      });
      showError(error);
    }
  },

  clearAndRestart() {
    if (this.data.busy) return;
    wx.showModal({
      title: '清空全部本地数据？',
      content: '这会删除当前设备中的原始资料库和本产品临时导出文件，操作无法撤销。',
      confirmText: '继续',
      cancelText: '取消',
      confirmColor: '#9a5550',
      success: (first) => {
        if (!first.confirm) return;
        wx.showModal({
          title: '最后确认',
          content: '确认放弃当前本地数据并建立一个全新的空资料库？',
          confirmText: '确认清空',
          cancelText: '取消',
          confirmColor: '#9a5550',
          success: (second) => {
            if (!second.confirm) return;
            this.setData({ busy: true });
            try {
              getRecoveryService().clearAllData(true);
              this.finishRecovery('已建立空资料库');
            } catch (error) {
              this.setData({ busy: false });
              showError(error);
            }
          }
        });
      }
    });
  },

  finishRecovery(message) {
    try {
      const bootstrap = getApp().rebuildBootstrap();
      if (!bootstrap || bootstrap.mode !== 'ready') {
        throw new Error('新资料库仍无法启动，请先保留原始数据');
      }
      wx.showToast({ title: message, icon: 'success' });
      wx.reLaunch({ url: '/pages/timer/index' });
    } catch (error) {
      this.setData({ busy: false });
      showError(error);
    }
  }
});
