// Uber Android 4.651.10003: UberMapView.setDefaultStyle / in9.a.
// Keep upstream cartography and resource URLs. This adapter does not claim
// equivalence to Uber's native renderer; every unsupported extension is reported.
export const nativeStyles = Object.freeze({
  default: 'https://tc2.uber.com/style/default/native?o=DEFAULT',
  auto: 'https://tc2.uber.com/style/auto/native?o=DEFAULT',
});

export function adaptNativeMapStyle(input, { night = false } = {}) {
  if (!input || !['8_u1', 8].includes(input.version) || !Array.isArray(input.layers) || !input.sources) {
    throw new Error('Unsupported Uber map style');
  }
  const originals = new Map();
  for (const layer of input.layers) {
    if (!layer || typeof layer.id !== 'string' || originals.has(layer.id)) throw new Error('Invalid or duplicate map layer');
    originals.set(layer.id, layer);
  }
  const differences = [];
  function resolve(layer, seen = new Set()) {
    if (seen.has(layer.id)) throw new Error('Map style contains a reference cycle');
    seen.add(layer.id);
    const resolved = { ...layer };
    if (layer.ref !== undefined) {
      const parent = originals.get(layer.ref);
      if (!parent) throw new Error('Map style references a missing layer');
      const inherited = resolve(parent, seen);
      // Legacy ref layers share layout/filter/source, and have separate paints.
      for (const key of ['type', 'source', 'source-layer', 'minzoom', 'maxzoom', 'filter', 'layout', 'layout.night']) {
        if (resolved[key] === undefined && inherited[key] !== undefined) resolved[key] = inherited[key];
      }
    }
    return resolved;
  }
  const layers = [];
  for (const original of input.layers) {
    const layer = resolve(original);
    if (layer.type === 'x-uber-metadata') {
      differences.push({ layer: layer.id, key: 'x-uber-metadata', effect: 'Native insertion metadata is not interpreted' });
      continue;
    }
    const result = {};
    for (const key of ['id', 'type', 'source', 'source-layer', 'minzoom', 'maxzoom', 'filter']) {
      if (layer[key] !== undefined) result[key] = structuredClone(layer[key]);
    }
    for (const kind of ['paint', 'layout']) {
      const values = { ...layer[kind], ...(night ? layer[`${kind}.night`] : {}) };
      const output = {};
      for (const [key, value] of Object.entries(values)) {
        if (key.startsWith('x-uber-')) {
          differences.push({ layer: layer.id, key, effect: 'Native placement/default behavior is not implemented' });
        } else output[key] = structuredClone(value);
      }
      if (Object.keys(output).length) result[kind] = output;
    }
    for (const key of Object.keys(layer)) {
      if (key === 'is-stroke' || key.startsWith('x-uber-')) {
        differences.push({ layer: layer.id, key, effect: 'Native layer behavior is not implemented' });
      }
    }
    layers.push(result);
  }
  return {
    style: {
      version: 8, name: input.name, sources: structuredClone(input.sources),
      ...(input.sprite ? { sprite: input.sprite } : {}),
      ...(input.glyphs ? { glyphs: input.glyphs } : {}), layers,
    },
    fidelity: { nativeRenderer: false, pixelParityVerified: false, differences },
  };
}
