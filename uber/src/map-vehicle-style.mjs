export function mapAssetUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    // Older shopping responses use HTTP for this same static asset CDN.
    if (
      url.protocol === 'http:' &&
      url.hostname === 'd1a3f4spazzrp4.cloudfront.net'
    )
      url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      return null;
    if (
      url.hostname !== 'd1a3f4spazzrp4.cloudfront.net' &&
      url.hostname !== 'duyt4h9nfnj50.cloudfront.net' &&
      !/(^|\.)uber\.com$/.test(url.hostname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

// bn9.s.onDraw uses (numSprites - 1), not numSprites or nearest rounding.
export function spriteFrame(heading, cameraBearing, numSprites) {
  if (
    ![heading, cameraBearing].every(Number.isFinite) ||
    !Number.isInteger(numSprites) ||
    numSprites < 2 ||
    numSprites > 360
  )
    throw new Error('Invalid vehicle sprite orientation');
  const relative = (((heading - cameraBearing) % 360) + 360) % 360;
  return Math.trunc((relative / 360) * (numSprites - 1));
}

// bn9.l.a legacy sprite projection: 0.25 at zoom10, 1 at zoom16.
export function vehicleSpriteScale(zoom) {
  if (!Number.isFinite(zoom)) throw new Error('Invalid vehicle sprite zoom');
  return Math.min(1, Math.max(0.25, ((zoom - 10) / 6) * 0.75 + 0.25));
}
