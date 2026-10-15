import { LinkedInError } from './errors.mjs';

export async function me(client) {
  const payload = await client.graphql({ queryId: 'voyagerIdentityDashProfiles.7186fe864099dc0343c4b65e736363e9',
    queryName: 'ProfilesByMe', variables: {}, field: 'identityDashProfilesByMe' });
  const index = new Map((payload.included ?? payload.data?.included ?? []).map(x => [x.entityUrn, x]));
  const resolve = value => typeof value === 'string' ? index.get(value) : value;
  const root = payload.data?.data ?? payload.data ?? payload;
  const collection = resolve(root.identityDashProfilesByMe ?? root['*identityDashProfilesByMe']);
  const profiles = collection?.elements ?? collection?.['*elements'] ?? [];
  const profile = resolve(profiles[0]);
  if (!/^urn:li:fsd_profile:[\w-]+$/.test(profile?.entityUrn ?? '')) throw new LinkedInError('INVALID_SESSION', 'LinkedIn did not return the authenticated profile.');
  const account = { profileUrn: profile.entityUrn, mailboxUrn: profile.entityUrn,
    publicIdentifier: profile.publicIdentifier ?? null, name: [profile.firstName, profile.lastName].filter(Boolean).join(' ') || null };
  client.session.account = account;
  client.session.validatedAt = new Date().toISOString();
  return account;
}
