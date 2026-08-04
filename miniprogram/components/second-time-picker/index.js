function pad(value) {
  return String(value).padStart(2, '0');
}

function parseValue(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) return [0, 0, 0];
  const indices = match.slice(1).map(Number);
  return indices[0] <= 23 && indices[1] <= 59 && indices[2] <= 59
    ? indices
    : [0, 0, 0];
}

const hours = Array.from({ length: 24 }, (_, index) => pad(index));
const minutes = Array.from({ length: 60 }, (_, index) => pad(index));

Component({
  properties: {
    value: {
      type: String,
      value: '00:00:00',
      observer(value) {
        this.setData({ indices: parseValue(value) });
      }
    }
  },

  data: {
    columns: [hours, minutes, minutes],
    indices: [0, 0, 0]
  },

  methods: {
    onPickerChange(event) {
      const indices = event.detail.value.map(Number);
      const value = indices.map(pad).join(':');
      this.setData({ indices });
      this.triggerEvent('change', { value });
    }
  }
});
