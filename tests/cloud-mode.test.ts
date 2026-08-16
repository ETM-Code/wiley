import { describe, expect, it } from "vitest";

import { CloudAuthError, CloudRequestError, type FetchLike } from "../src/main/cloud/cloud-client";
import {
  cloudClientIfReady,
  cloudRelayBaseUrl,
  cloudSessionToken,
  isCloudMode,
  mintConfiguredVoiceToken,
  type CloudHost,
} from "../src/main/cloud/cloud-mode";
import { CLOUD_PROVIDER_ID, effectiveProvider, loadSettings } from "../src/main/settings/settings-schema";

function settingsWith(auth: { mode?: "byok" | "cloud"; relayBaseUrl?: string }) {
  return loadSettings({ auth: { mode: "byok", relayBaseUrl: "", ...auth } });
}

function host(
  auth: { mode?: "byok" | "cloud"; relayBaseUrl?: string },
  token?: string,
): CloudHost & { apiKey?: string } {
  return {
    settings: settingsWith(auth),
    secrets: { get: (name) => (name === "cloudSessionToken" ? token : undefined) },
  };
}

function recordingFetch(body: unknown, status = 200): { fetch: FetchLike; urls: string[] } {
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

describe("effectiveProvider", () => {
  it("leaves the configured provider alone in bring-your-own-key mode", () => {
    expect(effectiveProvider(settingsWith({ mode: "byok" }))).toBe("openai");
  });

  it("derives the cloud provider from the account mode, not a second switch", () => {
    expect(effectiveProvider(settingsWith({ mode: "cloud", relayBaseUrl: "https://relay.example.com" })))
      .toBe(CLOUD_PROVIDER_ID);
  });
});

describe("cloud mode resolution", () => {
  it("reads the mode and the saved token", () => {
    expect(isCloudMode(settingsWith({ mode: "byok" }))).toBe(false);
    expect(cloudSessionToken(host({ mode: "cloud" }, "tok_1"))).toBe("tok_1");
    expect(cloudSessionToken(host({ mode: "cloud" }))).toBeUndefined();
  });

  it("names the missing setting when cloud mode has no relay", () => {
    expect(() => cloudRelayBaseUrl(settingsWith({ mode: "cloud" }))).toThrow(CloudRequestError);
    expect(() => cloudRelayBaseUrl(settingsWith({ mode: "cloud" }))).toThrow(/no relay base URL is set/);
  });

  it("hands back no client at all in bring-your-own-key mode", () => {
    expect(cloudClientIfReady(host({ mode: "byok", relayBaseUrl: "https://relay.example.com" }, "tok"))).toBeUndefined();
  });

  it("hands back no client when cloud mode is selected but unconfigured", () => {
    expect(cloudClientIfReady(host({ mode: "cloud" }, "tok"))).toBeUndefined();
  });

  it("hands back a client once the relay is configured", () => {
    const client = cloudClientIfReady(host({ mode: "cloud", relayBaseUrl: "https://relay.example.com/" }, "tok"));
    expect(client?.baseUrl).toBe("https://relay.example.com");
  });
});

describe("mintConfiguredVoiceToken", () => {
  it("goes straight to OpenAI with the user's own key by default", async () => {
    const { fetch, urls } = recordingFetch({ value: "ek_byok" });
    const secret = await mintConfiguredVoiceToken({ ...host({ mode: "byok" }), apiKey: "sk-test" }, { fetch });

    expect(secret.value).toBe("ek_byok");
    expect(urls).toEqual(["https://api.openai.com/v1/realtime/client_secrets"]);
  });

  it("goes to the relay in cloud mode", async () => {
    const { fetch, urls } = recordingFetch({ value: "ek_cloud" });
    const secret = await mintConfiguredVoiceToken(
      { ...host({ mode: "cloud", relayBaseUrl: "https://relay.example.com" }, "tok_1"), apiKey: "sk-test" },
      { fetch },
    );

    expect(secret.value).toBe("ek_cloud");
    expect(urls).toEqual(["https://relay.example.com/v1/realtime/secret"]);
  });

  it("surfaces a cloud failure instead of quietly spending the user's own key", async () => {
    const { fetch, urls } = recordingFetch({ error: "nope" }, 401);
    const attempt = mintConfiguredVoiceToken(
      { ...host({ mode: "cloud", relayBaseUrl: "https://relay.example.com" }, "tok_1"), apiKey: "sk-test" },
      { fetch },
    );

    await expect(attempt).rejects.toThrow(CloudAuthError);
    expect(urls).toEqual(["https://relay.example.com/v1/realtime/secret"]);
  });

  it("refuses without ever calling OpenAI when cloud mode has no token", async () => {
    const { fetch, urls } = recordingFetch({ value: "ek_byok" });
    const attempt = mintConfiguredVoiceToken(
      { ...host({ mode: "cloud", relayBaseUrl: "https://relay.example.com" }), apiKey: "sk-test" },
      { fetch },
    );

    await expect(attempt).rejects.toThrow(CloudAuthError);
    expect(urls).toEqual([]);
  });

  it("still asks for a key in bring-your-own-key mode when none is configured", async () => {
    const { fetch, urls } = recordingFetch({ value: "ek_byok" });
    await expect(mintConfiguredVoiceToken(host({ mode: "byok" }), { fetch }))
      .rejects.toThrow(/No OpenAI API key is configured/);
    expect(urls).toEqual([]);
  });
});
