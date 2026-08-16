import type { SettingsService } from "../settings/settings-service";
import type { CloudAccount } from "./cloud-client";
import { createCloudClient, type CloudClientOverrides } from "./cloud-mode";

/**
 * What the Account panel's "Test connection" button does. Deliberately usable
 * before the account mode is switched over, so someone can find out whether
 * their relay and token work while the local path is still the one running.
 */
export async function testCloudConnection(
  settings: SettingsService,
  overrides: CloudClientOverrides = {},
): Promise<CloudAccount> {
  const client = createCloudClient(
    { settings: settings.settings, secrets: settings.store.secrets },
    overrides,
  );
  const account = await client.getMe();
  // Remembering the email is the only thing a successful test changes, so the
  // panel can still name the account after the panel is closed and reopened.
  if (account.email && account.email !== settings.settings.auth.accountEmail) {
    await settings.update({ auth: { accountEmail: account.email } });
  }
  return account;
}
