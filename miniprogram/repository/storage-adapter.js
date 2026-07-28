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

  set(key, value) {
    this.values.set(key, value);
  }
}

class WxStorageAdapter {
  get(key) {
    return wx.getStorageSync(key);
  }

  set(key, value) {
    wx.setStorageSync(key, value);
  }
}

module.exports = {
  MemoryStorageAdapter,
  WxStorageAdapter
};
