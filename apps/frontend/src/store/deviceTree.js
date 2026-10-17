// Walking the device chains of every strip (tracks, returns, master), racks included.

// Applies `fn` to the device with this id, wherever it sits (any strip, or
// inside a rack). Unchanged lists and strips keep their identity.
export const mapDeviceAnywhere = (state, deviceId, fn) => {
  const inList = (plugins) => {
    let changed = false;
    const next = plugins.map(p => {
      if (p.id === deviceId) { changed = true; return fn(p); }
      if (p.type === 'rack') {
        const devices = inList(p.devices);
        if (devices !== p.devices) { changed = true; return { ...p, devices }; }
      }
      return p;
    });
    return changed ? next : plugins;
  };
  const inStrips = (strips) => {
    let changed = false;
    const next = strips.map(strip => {
      const plugins = inList(strip.plugins || []);
      if (plugins === (strip.plugins || [])) return strip;
      changed = true;
      return { ...strip, plugins };
    });
    return changed ? next : strips;
  };
  return { tracks: inStrips(state.tracks), returns: inStrips(state.returns), masterPlugins: inList(state.masterPlugins) };
};

// The device with this id, wherever it sits
export const findDevice = (state, deviceId) => {
  const search = (plugins = []) => {
    for (const p of plugins) {
      if (p.id === deviceId) return p;
      if (p.type === 'rack') { const hit = search(p.devices); if (hit) return hit; }
    }
    return null;
  };
  for (const strip of [...state.tracks, ...state.returns]) { const hit = search(strip.plugins); if (hit) return hit; }
  return search(state.masterPlugins);
};
