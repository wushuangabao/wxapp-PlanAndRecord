const { utf8ByteLength } = require('./storage-capacity');

class MemoryStorageAdapter {
  constructor(initialValue) {
    this.values = new Map();
    if (initialValue !== undefined) {
      this.values.set('plan-and-record.database', initialValue);
    }
  }

  get(key) {
    return this.values.has(key) ? this.values.get(key) : '';
  }

  has(key) {
    return this.values.has(key);
  }

  set(key, value) {
    this.values.set(key, value);
  }

  remove(key) {
    this.values.delete(key);
  }

  info() {
    let totalBytes = 0;
    for (const [key, value] of this.values.entries()) {
      const json = JSON.stringify(value);
      totalBytes += utf8ByteLength(key);
      totalBytes += utf8ByteLength(json === undefined ? '' : json);
    }
    return {
      keys: [...this.values.keys()],
      currentSize: Math.ceil(totalBytes / 1024),
      limitSize: 10240
    };
  }
}

class WxStorageAdapter {
  has(key) {
    return wx.getStorageInfoSync().keys.includes(key);
  }

  get(key) {
    return wx.getStorageSync(key);
  }

  set(key, value) {
    wx.setStorageSync(key, value);
  }

  remove(key) {
    wx.removeStorageSync(key);
  }

  info() {
    const info = wx.getStorageInfoSync();
    return {
      ...info,
      keys: Array.isArray(info.keys) ? [...info.keys] : []
    };
  }
}

module.exports = {
  MemoryStorageAdapter,
  WxStorageAdapter
};
