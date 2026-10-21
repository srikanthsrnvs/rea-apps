import path from 'node:path';
import { request, requireSuccess } from './http.mjs';
import { captureResponseContext, readRequestContext, updateRequestContext } from './request-context.mjs';
import { withStateLock, stateDirectory } from './state.mjs';
import { AirbnbError } from './errors.mjs';

export function buildDeviceRegistration() {
  return { path: 'client_configs', method: 'POST', body: { configs: [], trebuchet_keys: [],
    deviceAssignmentsToRequest: [{ deviceAssignmentType: 'STRICTLY_NECESSARY', deviceType: 'ANDROID' }] } };
}
export function parseDeviceRegistration(data) {
  const assignment = data?.device_assignments?.find(value => value.device_type === 'ANDROID' && value.device_assignment_type === 'STRICTLY_NECESSARY');
  if (typeof assignment?.device_id !== 'string' || !assignment.device_id || assignment.device_id.length > 65_536
    || /[\x00-\x1f\x7f]/.test(assignment.device_id) || !Number.isSafeInteger(assignment.expire_at_epoch_second)
    || assignment.expire_at_epoch_second < Math.floor(Date.now() / 1000)) {
    throw new AirbnbError('DEVICE_REGISTRATION_FAILED', 'Airbnb did not return a usable native device assignment.');
  }
  return { everestDeviceId: assignment.device_id, everestExpiresAt: assignment.expire_at_epoch_second };
}
// Native startup asks the server for this assignment; it is not a locally
// generated signature or a value taken from a browser/phone session.
export async function ensureDeviceContext({ headers, fetchImpl } = {}) {
  if ((await readRequestContext()).everestDeviceId) return;
  await withStateLock(async () => {
    if ((await readRequestContext()).everestDeviceId) return;
    const response = await request(buildDeviceRegistration(), { headers, fetchImpl });
    await captureResponseContext(response);
    await updateRequestContext(parseDeviceRegistration(requireSuccess(response)));
  }, { directory: path.join(stateDirectory, '.device-mutex'), timeoutMs: 60_000 });
}
