import { authenticatedOperation } from './client.mjs';

export function normalizePaymentProfiles(payload) {
  if (!Array.isArray(payload?.paymentProfiles))
    throw new Error('Unrecognized payment profile response');
  return {
    profiles: payload.paymentProfiles
      .filter((p) => p && typeof p.uuid === 'string')
      .map((p) => ({
        id: p.uuid,
        name:
          typeof p.displayable?.displayName === 'string'
            ? p.displayable.displayName
            : null,
        type: typeof p.cardType === 'string' ? p.cardType : null,
        status: typeof p.status === 'string' ? p.status : null,
        expired: typeof p.isExpired === 'boolean' ? p.isExpired : null,
        useCase: typeof p.useCase === 'string' ? p.useCase : null,
      })),
    inactiveProfileCount: Array.isArray(payload.inactivePaymentProfiles)
      ? payload.inactivePaymentProfiles.length
      : null,
  };
}
export async function fetchPaymentProfiles(send) {
  // POST on this path creates a payment profile. Reads must use GET.
  return send('/rt/payment/v3/payment-profiles', undefined, { method: 'GET' });
}
export async function fetchUserProfiles(send, userUUID) {
  return send('/rt/profiles/v2/get-profiles', {
    request: { userUuid: userUUID },
  });
}
export function selectPaymentProfile(rawPayments, rawProfiles, explicitId) {
  const personal = rawProfiles?.profiles?.filter(
    (profile) => profile.type === 'Personal' && profile.status === 'active',
  );
  if (!Array.isArray(personal) || personal.length !== 1)
    throw new Error(
      'No unique active Personal profile; explicit profile selection is required',
    );
  const profile = personal[0];
  const id =
    explicitId ??
    profile.defaultPaymentProfileByProduct?.RIDER ??
    profile.defaultPaymentProfileUuid;
  const payments = normalizePaymentProfiles(rawPayments).profiles.filter(
    (payment) => payment.id === id,
  );
  if (
    payments.length !== 1 ||
    payments[0].status !== 'active' ||
    payments[0].expired === true
  )
    throw new Error(
      'Selected payment method is unavailable or expired; inspect uber payments',
    );
  return {
    payment: payments[0],
    userProfile: { id: profile.uuid, type: 'PERSONAL' },
  };
}
export async function listPaymentProfiles() {
  return authenticatedOperation(async ({ session, send }) => {
    const summary = normalizePaymentProfiles(await fetchPaymentProfiles(send));
    const rawProfiles = await fetchUserProfiles(send, session.userUUID);
    const personal = rawProfiles?.profiles?.filter(
      (p) => p.type === 'Personal' && p.status === 'active',
    );
    const defaultId =
      personal?.length === 1
        ? (personal[0].defaultPaymentProfileByProduct?.RIDER ??
          personal[0].defaultPaymentProfileUuid)
        : null;
    return {
      ...summary,
      profiles: summary.profiles.map((p) => ({
        ...p,
        defaultForRides:
          typeof defaultId === 'string' ? p.id === defaultId : null,
      })),
    };
  });
}
