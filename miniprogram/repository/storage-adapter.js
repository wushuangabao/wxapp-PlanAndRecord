class MemoryStorageAdapter {
  constructor(initialValue) {
    this.values = new Map();
    if (initialValue !== undefined) {
      this.values.set('plan-and-record.database', initialValue);
    }
  }

  get(key) {
    return this.values.get(key);
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
}

module.exports = {
  MemoryStorageAdapter,
  WxStorageAdapter
};
