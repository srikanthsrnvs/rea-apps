import { readState, saveState } from './state.mjs';
import { mapAssetUrl } from './map-vehicle-style.mjs';
export { mapAssetUrl, spriteFrame } from './map-vehicle-style.mjs';


const pair = input => {
  if (!input || typeof input !== 'object') return null;
  const dayImageURL = mapAssetUrl(input.dayImageURL), nightImageURL = mapAssetUrl(input.nightImageURL);
  return dayImageURL || nightImageURL ? { dayImageURL, nightImageURL } : null;
};

/** ProductContext.presentation: original day/night artwork and atlas divisions. */
export function productMapIcons(presentation) {
  const standardMapIcon = pair(presentation?.standardMapIcon);
  const count = presentation?.spriteDivisionCount;
  const spritesheetMapIcon = Number.isSafeInteger(count) && count > 1 && count <= 360 ? pair(presentation?.spritesheetMapIcon) : null;
  return standardMapIcon || spritesheetMapIcon ? { standardMapIcon, spritesheetMapIcon, spriteDivisionCount: spritesheetMapIcon ? count : null } : null;
}


export async function saveTripMapIcons(tripId, userUUID, icons) {
  const normalized = productMapIcons(icons);
  if (!normalized) return false;
  await saveState(`map-artwork-${tripId}`, { version: 1, tripId, userUUID, ...normalized });
  return true;
}

export async function loadTripMapIcons(tripId) {
  const artwork = await readState(`map-artwork-${tripId}`);
  if (!artwork || artwork.version !== 1 || artwork.tripId !== tripId) return null;
  const session = await readState('session');
  return session?.userUUID && artwork.userUUID === session.userUUID ? productMapIcons(artwork) : null;
}
