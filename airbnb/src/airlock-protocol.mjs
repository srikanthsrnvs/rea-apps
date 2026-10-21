import { AirbnbError } from './errors.mjs';

const QUERY_HASH = '0a5c34521666d3e480fa6328d2de819aa58ce484b036de369705da3bf998568f';
const SUBMIT_HASH = '49c3478efb2c2ed263aa05c32b3887f147264e11dbd9130a80c5422bc627c24c';
const INTERNAL_ID = /^-?[0-9]{1,30}$/;
function checkIds(airlock) {
  if (!airlock || typeof airlock.internalAirlockId !== 'string' || !INTERNAL_ID.test(airlock.internalAirlockId)
    || typeof airlock.id !== 'string' || !/^[A-Za-z0-9+/=_-]{1,256}$/.test(airlock.id)) {
    throw new AirbnbError('INVALID_AIRLOCK', 'Airbnb returned an invalid verification identifier.');
  }
}

export function extractAirlock(response) {
  if (response.status !== 420 || !response.body?.client_error_info?.airlockV2) return null;
  const airlock = response.body.client_error_info.airlockV2;
  checkIds(airlock);
  let url;
  try { url = new URL(airlock.airlockWebviewUrl); } catch {}
  if (url?.origin !== 'https://www.airbnb.com' || url.pathname !== '/airlock'
    || url.searchParams.get('al_id') !== airlock.internalAirlockId || url.username || url.password) {
    throw new AirbnbError('INVALID_AIRLOCK', 'Airbnb returned an unexpected verification URL.');
  }
  return airlock;
}

export function airlockWidget(airlock) {
  checkIds(airlock);
  const data = airlock.viewPayload?.frictionData;
  if (airlock.flow !== 'CAPTCHA_FLOW' || airlock.viewPayload?.frictionView !== 'ARKOSE_BOT_DETECTION'
    || typeof data?.publicKey !== 'string' || !/^[A-Fa-f0-9-]{36}$/.test(data.publicKey)
    || typeof data.encodedDataPayload !== 'string' || data.encodedDataPayload.length > 65_536) {
    throw new AirbnbError('UNSUPPORTED_VERIFICATION', 'Airbnb requires a verification step this CLI has not implemented.');
  }
  return { publicKey: data.publicKey, dataExchangeBlob: data.encodedDataPayload };
}

export function buildAirlockQuery(airlock) {
  checkIds(airlock);
  return { operationName: 'AirlockWithCurrentView', hash: QUERY_HASH, variables: { airlockId: airlock.id } };
}
export function buildAirlockStatus(airlock) {
  checkIds(airlock);
  return { path: `airlocks/${airlock.internalAirlockId}` };
}
export function buildAirlockSubmit(airlock, token) {
  checkIds(airlock);
  if (typeof token !== 'string' || token.length < 20 || token.length > 16_000 || /[\x00-\x1f\x7f]/.test(token)) {
    throw new AirbnbError('INVALID_VERIFICATION_TOKEN', 'A complete genuine verification token is required.');
  }
  return { operationName: 'AirlockArkoseBotDetectionSubmitToken', hash: SUBMIT_HASH, method: 'POST',
    variables: { payload: { airlockId: airlock.id, sessionToken: token } } };
}
export function parseAirlockSubmit(data, airlock) {
  checkIds(airlock);
  const result = data?.data?.airlockArkoseBotDetectionSubmitToken;
  if (!result?.airlock || result.errors?.length || result.airlock.id !== airlock.id) {
    throw new AirbnbError('VERIFICATION_REJECTED', 'Airbnb did not accept this verification result.');
  }
  return result.airlock;
}
export function requireAirlockReplay(data, airlock) {
  checkIds(airlock);
  const result = data?.airlock;
  const id = typeof result?.airlockId === 'string' ? result.airlockId
    : typeof result?.id === 'string' ? result.id : Number.isSafeInteger(result?.id) ? String(result.id) : null;
  if (id !== airlock.internalAirlockId || result?.status !== 2 || result.should_replay_request !== true) {
    throw new AirbnbError('VERIFICATION_INCOMPLETE', 'Airbnb has not authorized retrying this request after verification.');
  }
  return { 'x-airbnb-replay-airlock-id': airlock.internalAirlockId };
}
