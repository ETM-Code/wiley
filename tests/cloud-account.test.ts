import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CloudAuthError, CloudRequestError, type FetchLike } from "../src/main/cloud/cloud-client";
import { testCloudConnection } from "../src/main/cloud/cloud-account";
import { FileSecretStore } from "../src/main/settings/secret-store";
import { SettingsService } from "../src/main/settings/settings-service";
import { SettingsStore } from "../src/main/settings/settings-store";

function service(options: { relayBaseUrl?: string; token?: string } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "wiley-cloud-account-"));
  const store = SettingsStore.open(dir, new FileSecretStore({ dir }));
  if (options.relayBaseUrl !== undefined) store.update({ auth: { relayBaseUrl: options.relayBaseUrl } });
  if (options.token) store.secrets.set("cloudSessionToken", options.token);
  return { store, service: new SettingsService({ store, env: {} }) };
}

function replyWith(body: unknown, status = 200): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: (url) => {
      urls.push(url);
      return Promise.resolve(new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }));
    },
  };
}

describe("SettingsService secrets view", () => {
  it("reports whether a session token is saved without ever carrying it", async () => {
    const { service: settings, store } = service();
    expect((await settings.view()).secrets.cloudSessionToken).toEqual({ stored: false, backend: "file" });

    await settings.setSecret("cloudSessionToken", "wc_super_secret");
    const view = await settings.view();
    expect(view.secrets.cloudSessionToken.stored).toBe(true);
    expect(JSON.stringify(view)).not.toContain("wc_super_secret");
    expect(store.secrets.get("cloudSessionToken")).toBe("wc_super_secret");
  });

  it("tells listeners a credential changed, since settings.json did not move", async () => {
    const { service: settings, store } = service();
    let notifications = 0;
    store.onChange(() => { notifications += 1; });

    await settings.setSecret("cloudSessionToken", "wc_1");
    await settings.clearSecret("cloudSessionToken");
    expect(notifications).toBe(2);
  });
});

describe("testCloudConnection", () => {
  it("reports the account the relay knows about", async () => {
    const { service: settings } = service({ relayBaseUrl: "https://relay.example.com", token: "wc_1" });
    const { fetch, urls } = replyWith({ accountId: "acct_1", email: "someone@example.com", tier: "beta" });

    const account = await testCloudConnection(settings, { fetch });
    expect(account.tier).toBe("beta");
    expect(urls).toEqual(["https://relay.example.com/v1/me"]);
  });

  it("remembers the email so the panel can name the account later", async () => {
    const { service: settings, store } = service({ relayBaseUrl: "https://relay.example.com", token: "wc_1" });
    const { fetch } = replyWith({ accountId: "acct_1", email: "someone@example.com" });

    await testCloudConnection(settings, { fetch });
    expect(store.get().auth.accountEmail).toBe("someone@example.com");
  });

  it("works before the account mode is switched over", async () => {
    const { service: settings } = service({ relayBaseUrl: "https://relay.example.com", token: "wc_1" });
    expect(settings.settings.auth.mode).toBe("byok");
    const { fetch } = replyWith({ accountId: "acct_1" });
    await expect(testCloudConnection(settings, { fetch })).resolves.toMatchObject({ accountId: "acct_1" });
  });

  it("says which setting is missing when there is no relay", async () => {
    const { service: settings } = service({ token: "wc_1" });
    const { fetch, urls } = replyWith({ accountId: "acct_1" });
    await expect(testCloudConnection(settings, { fetch })).rejects.toThrow(CloudRequestError);
    expect(urls).toEqual([]);
  });

  it("says the token is the problem when the relay rejects it", async () => {
    const { service: settings } = service({ relayBaseUrl: "https://relay.example.com", token: "wc_bad" });
    const { fetch } = replyWith({ error: "unknown token" }, 401);
    await expect(testCloudConnection(settings, { fetch })).rejects.toThrow(CloudAuthError);
  });
});
