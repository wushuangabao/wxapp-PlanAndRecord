Component({
  properties: {
    title: { type: String, value: '' },
    showConfirm: { type: Boolean, value: false },
    confirmText: { type: String, value: '确定' },
    cancelText: { type: String, value: '取消' }
  },

  methods: {
    onConfirm() {
      this.triggerEvent('confirm');
    },

    onCancel() {
      this.triggerEvent('cancel');
    }
  }
});
