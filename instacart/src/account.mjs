import { ApiError } from './http.mjs';

export const ACCOUNT_DOCUMENT = "query MinimumUserInfo { currentUser { id admin guest userAccount { accountType hasAccounts } businessOrganizationOptional { id } viewSection { userAccountsEnabledVariant } } viewLayout { storeApp { trackingProperties } } }";

export async function currentAccount(client) {
  const data = await client.graphql('MinimumUserInfo', ACCOUNT_DOCUMENT, {});
  const user = data.currentUser;
  if (!user?.id || user.guest !== false) throw new ApiError('AUTH_REQUIRED', 'Instacart did not return a signed-in customer account.');
  return { id: user.id, guest: user.guest, accountType: user.userAccount?.accountType };
}
