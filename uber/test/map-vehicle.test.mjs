import test from 'node:test';
import assert from 'node:assert/strict';
import { productMapIcons, spriteFrame, mapAssetUrl } from '../src/map-vehicle.mjs';
import { vehicleSpriteScale } from '../src/map-vehicle-style.mjs';

test('keeps native day/night icon assets, divisions and safe legacy CDN upgrade', () => {
  const icons = productMapIcons({ standardMapIcon: { dayImageURL: 'http://d1a3f4spazzrp4.cloudfront.net/car-types/mapIconsStandard/car_x_2d.png' }, spritesheetMapIcon: { dayImageURL: 'https://d1a3f4spazzrp4.cloudfront.net/car-types/haloMapIconsSpritesheet/v1/uberX_Spritesheet_v1.png' }, spriteDivisionCount: 64, privateField: 'do not copy' });
  assert.equal(icons.spriteDivisionCount, 64);
  assert.match(icons.standardMapIcon.dayImageURL, /^https:/);
  assert.equal(icons.privateField, undefined);
  assert.equal(productMapIcons({ spritesheetMapIcon: { dayImageURL: 'https://tc2.uber.com/test.png' }, spriteDivisionCount: 100000 }), null);
  for (const value of ['javascript:bad', 'https://uber.com.evil.example/car.png', 'http://tc2.uber.com/car.png', 'https://user:pass@tc2.uber.com/a']) assert.equal(mapAssetUrl(value), null);
});

test('sprite size follows the recovered legacy zoom projection and clamps its extremes', () => {
  assert.equal(vehicleSpriteScale(0), 0.25);
  assert.equal(vehicleSpriteScale(10), 0.25);
  assert.equal(vehicleSpriteScale(13), 0.625);
  assert.equal(vehicleSpriteScale(16), 1);
  assert.equal(vehicleSpriteScale(22), 1);
  assert.throws(() => vehicleSpriteScale(Infinity));
});

test('sprite quantization follows the native last-frame convention across wrap and camera rotation', () => {
  assert.equal(spriteFrame(0, 0, 64), 0);
  assert.equal(spriteFrame(90, 0, 64), 15);
  assert.equal(spriteFrame(180, 0, 64), 31);
  assert.equal(spriteFrame(270, 0, 64), 47);
  assert.equal(spriteFrame(360, 0, 64), 0);
  assert.equal(spriteFrame(-90, 0, 64), 47);
  assert.equal(spriteFrame(180, 90, 64), 15);
  assert.throws(() => spriteFrame(NaN, 0, 64));
});
