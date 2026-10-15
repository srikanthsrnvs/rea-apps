import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptNativeMapStyle } from '../src/map-style.mjs';

const style = () => ({ version: '8_u1', name: 'synthetic', sources: { roads: { type: 'vector', url: 'https://tc2.uber.com/manifest/test' } }, sprite: 'https://tc2.uber.com/sprite/test', glyphs: 'https://tc2.uber.com/glyph/{fontstack}/{range}', layers: [
  { id: 'background', type: 'background', paint: { 'background-color': '#fff' }, 'paint.night': { 'background-color': '#333' } },
  { id: 'roads', type: 'line', source: 'roads', 'source-layer': 'roads', minzoom: 8, filter: ['==', 'kind', 'road'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#fff', 'line-width': 2 }, 'paint.night': { 'line-color': '#ccc' }, 'is-stroke': true },
  { id: 'casing', ref: 'roads', paint: { 'line-width': 3, 'line-color': '#111' } },
  { id: 'labels', type: 'symbol', source: 'roads', 'source-layer': 'roads', layout: { 'text-field': '{name}', 'text-font': ['UberMoveText-Medium'], 'x-uber-text-density-padding': 2 }, 'layout.night': { visibility: 'none' } },
  { id: 'insertion', type: 'x-uber-metadata', 'x-uber-insertion-point': 'routes' },
] });

test('retains actual resource URLs, layer order, colors and glyph fonts without mutating input', () => {
  const input = style(), before = structuredClone(input);
  const result = adaptNativeMapStyle(input);
  assert.equal(result.style.version, 8);
  assert.deepEqual(result.style.sources, input.sources);
  assert.equal(result.style.sprite, input.sprite);
  assert.equal(result.style.glyphs, input.glyphs);
  assert.deepEqual(result.style.layers.map(l => l.id), ['background', 'roads', 'casing', 'labels']);
  assert.deepEqual(result.style.layers[3].layout['text-font'], ['UberMoveText-Medium']);
  assert.deepEqual(input, before);
});

test('implements native night class merge and expands ref layout without inheriting its paint', () => {
  const { style: output } = adaptNativeMapStyle(style(), { night: true });
  assert.equal(output.layers[0].paint['background-color'], '#333');
  assert.equal(output.layers[1].paint['line-color'], '#ccc');
  assert.equal(output.layers[1].paint['line-width'], 2);
  assert.equal(output.layers[2].type, 'line');
  assert.equal(output.layers[2].paint['line-color'], '#111');
  assert.deepEqual(output.layers[2].filter, ['==', 'kind', 'road']);
  assert.equal(output.layers[3].layout.visibility, 'none');
});

test('reports native renderer differences instead of silently claiming an identical map', () => {
  const { fidelity } = adaptNativeMapStyle(style());
  assert.equal(fidelity.nativeRenderer, false);
  assert.equal(fidelity.pixelParityVerified, false);
  assert.deepEqual(new Set(fidelity.differences.map(d => d.key)), new Set(['is-stroke', 'x-uber-text-density-padding', 'x-uber-metadata']));
});

test('rejects changed versions, missing references, cycles and duplicate layers', () => {
  assert.throws(() => adaptNativeMapStyle({ ...style(), version: '9_u1' }));
  assert.throws(() => adaptNativeMapStyle({ ...style(), layers: [{ id: 'missing', ref: 'unknown' }] }));
  assert.throws(() => adaptNativeMapStyle({ ...style(), layers: [{ id: 'a', ref: 'b' }, { id: 'b', ref: 'a' }] }));
  assert.throws(() => adaptNativeMapStyle({ ...style(), layers: [{ id: 'a' }, { id: 'a' }] }));
});
