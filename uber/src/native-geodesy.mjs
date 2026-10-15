/*
 * Copyright (C) 2007 The Android Open Source Project
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * JavaScript port of AOSP android16-release Location.java
 * computeDistanceAndBearing, matching Android SDK36 selected device.
 * Source: https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/core/java/android/location/Location.java
 * Preserve float casts/order. See docs/map-parity.md for verification limits.
 *
 * onSegment is a separate static reconstruction of shipped yt.a.a false
 * branch / jr.c0 helpers in Uber APK 4.651.10003 (Evidence below), not AOSP.
 */
const f32 = Math.fround;
export function androidDistanceAndBearing(lat1, lon1, lat2, lon2) {
  lat1 *= Math.PI / 180;
  lat2 *= Math.PI / 180;
  lon1 *= Math.PI / 180;
  lon2 *= Math.PI / 180;
  const a = 6378137,
    b = 6356752.3142,
    f = (a - b) / a,
    aSqMinusBSqOverBSq = (a * a - b * b) / (b * b);
  const l = lon2 - lon1;
  let aA = 0;
  const u1 = Math.atan((1 - f) * Math.tan(lat1)),
    u2 = Math.atan((1 - f) * Math.tan(lat2));
  const cosU1 = Math.cos(u1),
    cosU2 = Math.cos(u2),
    sinU1 = Math.sin(u1),
    sinU2 = Math.sin(u2),
    cosU1cosU2 = cosU1 * cosU2,
    sinU1sinU2 = sinU1 * sinU2;
  let sigma = 0,
    deltaSigma = 0,
    cosLambda = 0,
    sinLambda = 0,
    lambda = l;
  for (let iter = 0; iter < 20; iter++) {
    const lambdaOrig = lambda;
    cosLambda = Math.cos(lambda);
    sinLambda = Math.sin(lambda);
    const t1 = cosU2 * sinLambda,
      t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda,
      sinSqSigma = t1 * t1 + t2 * t2,
      sinSigma = Math.sqrt(sinSqSigma),
      cosSigma = sinU1sinU2 + cosU1cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = sinSigma === 0 ? 0 : (cosU1cosU2 * sinLambda) / sinSigma,
      cosSqAlpha = 1 - sinAlpha * sinAlpha,
      cos2SM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1sinU2) / cosSqAlpha;
    const uSquared = cosSqAlpha * aSqMinusBSqOverBSq;
    aA =
      1 +
      (uSquared / 16384) *
        (4096 + uSquared * (-768 + uSquared * (320 - 175 * uSquared)));
    const bB =
        (uSquared / 1024) *
        (256 + uSquared * (-128 + uSquared * (74 - 47 * uSquared))),
      cC = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha)),
      cos2SMSq = cos2SM * cos2SM;
    deltaSigma =
      bB *
      sinSigma *
      (cos2SM +
        (bB / 4) *
          (cosSigma * (-1 + 2 * cos2SMSq) -
            (bB / 6) *
              cos2SM *
              (-3 + 4 * sinSigma * sinSigma) *
              (-3 + 4 * cos2SMSq)));
    lambda =
      l +
      (1 - cC) *
        f *
        sinAlpha *
        (sigma +
          cC *
            sinSigma *
            (cos2SM + cC * cosSigma * (-1 + 2 * cos2SM * cos2SM)));
    const delta = (lambda - lambdaOrig) / lambda;
    if (Math.abs(delta) < 1e-12) break;
  }
  const distance = f32(b * aA * (sigma - deltaSigma));
  let initialBearing = f32(
    Math.atan2(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda),
  );
  initialBearing = f32(initialBearing * (180 / Math.PI));
  let finalBearing = f32(
    Math.atan2(cosU1 * sinLambda, -sinU1 * cosU2 + cosU1 * sinU2 * cosLambda),
  );
  finalBearing = f32(finalBearing * (180 / Math.PI));
  return { distance, initialBearing, finalBearing };
}
const rad = (x) => x * 0.017453292519943295;
const hav = (x) => {
  const v = Math.sin(x * 0.5);
  return v * v;
};
const havDistance = (a, b, dLon) => {
  const s = Math.sin((a - b) * 0.5),
    t = Math.sin(dLon * 0.5);
  return Math.cos(b) * Math.cos(a) * t * t + s * s;
};
const mercator = (x) => Math.log(Math.tan(x * 0.5 + Math.PI / 4));
const wrap = (x) =>
  x >= -Math.PI && x < Math.PI
    ? x
    : ((((x + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) -
      Math.PI;
/** yt.a.a(point,[a,b],false,tolerance): Mercator-rhumb test, sphere6371009m.
 * Source ev_6e7d7ea36fc499546695e13ad431079ae420d2c6164e2871ce6541da26c58c0f.
 * jr.c0 helper bytecode corroborated separately; no geodesic=true implementation.
 */
export function onRhumbSegment(point, a, b, toleranceMeters) {
  const polyline = [a, b],
    tolerance = toleranceMeters / 6371009,
    havTolerance = hav(tolerance),
    lat = rad(point.lat),
    lon = rad(point.lon),
    minLat = lat - tolerance,
    maxLat = lat + tolerance,
    m = mercator(lat);
  let lat1 = rad(polyline[0].lat),
    lon1 = rad(polyline[0].lon),
    m1 = mercator(lat1);
  for (const end of polyline) {
    const lat2 = rad(end.lat),
      lon2 = rad(end.lon),
      m2 = mercator(lat2);
    if (Math.max(lat1, lat2) >= minLat && Math.min(lat1, lat2) <= maxLat) {
      const dx = wrap(lon2 - lon1),
        relative = wrap(lon - lon1),
        dy = m2 - m1,
        denominator = dx * dx + dy * dy;
      for (const x of [
        relative,
        relative + 2 * Math.PI,
        relative - 2 * Math.PI,
      ]) {
        let t = denominator <= 0 ? 0 : (x * dx + (m - m1) * dy) / denominator;
        t = Math.max(0, Math.min(1, t));
        const projectedLat = 2 * Math.atan(Math.exp(m1 + t * dy)) - Math.PI / 2;
        if (havDistance(lat, projectedLat, x - t * dx) < havTolerance)
          return true;
      }
    }
    lat1 = lat2;
    lon1 = lon2;
    m1 = m2;
  }
  return false;
}
export const nativeGeodesy = Object.freeze({
  distance: (a, b) =>
    androidDistanceAndBearing(a.lat, a.lon, b.lat, b.lon).distance,
  heading: (a, b) => {
    const value = androidDistanceAndBearing(
      a.lat,
      a.lon,
      b.lat,
      b.lon,
    ).initialBearing;
    return value < 0 ? f32(value + 360) : value;
  },
  onSegment: onRhumbSegment,
});
