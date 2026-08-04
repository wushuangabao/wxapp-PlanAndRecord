function readWindowWidth(wxApi, methodName) {
  if (!wxApi || typeof wxApi[methodName] !== 'function') return null;
  try {
    const info = wxApi[methodName]();
    const width = info && info.windowWidth;
    return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : null;
  } catch (error) {
    return null;
  }
}

function getRuntimeWindowWidth(wxApi) {
  const windowWidth = readWindowWidth(wxApi, 'getWindowInfo');
  if (windowWidth !== null) return windowWidth;
  return readWindowWidth(wxApi, 'getSystemInfoSync');
}

module.exports = {
  getRuntimeWindowWidth
};
