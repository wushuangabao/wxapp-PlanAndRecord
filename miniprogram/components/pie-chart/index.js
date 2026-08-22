function pieBackground(slices) {
  const visibleSlices = (Array.isArray(slices) ? slices : [])
    .filter((slice) => (
      slice
      && Number.isFinite(slice.value)
      && slice.value > 0
      && typeof slice.color === 'string'
    ));
  const total = visibleSlices.reduce((sum, slice) => sum + slice.value, 0);
  if (!total) return 'transparent';

  let accumulated = 0;
  const stops = visibleSlices.map((slice) => {
    const start = (accumulated / total) * 100;
    accumulated += slice.value;
    const end = (accumulated / total) * 100;
    return `${slice.color} ${start.toFixed(4)}% ${end.toFixed(4)}%`;
  });
  return `conic-gradient(from 0deg, ${stops.join(', ')})`;
}

Component({
  properties: {
    slices: { type: Array, value: [] }
  },

  data: {
    pieBackground: 'transparent'
  },

  observers: {
    slices(value) {
      this.updatePieBackground(value);
    }
  },

  lifetimes: {
    attached() {
      this.updatePieBackground(this.data.slices);
    }
  },

  methods: {
    updatePieBackground(slices) {
      const nextBackground = pieBackground(slices);
      if (nextBackground !== this.data.pieBackground) {
        this.setData({ pieBackground: nextBackground });
      }
    }
  }
});
