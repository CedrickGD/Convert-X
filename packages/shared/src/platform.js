/** @type {import('./platform').PlatformAdapter|null} */
let _adapter = null;

export function setPlatform(adapter) {
  _adapter = adapter;
}

export function getPlatform() {
  if (!_adapter) throw new Error("Platform adapter not initialized. Call setPlatform() first.");
  return _adapter;
}
