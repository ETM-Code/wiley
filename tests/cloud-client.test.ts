import { describe, expect, it } from "vitest";

import {
  CloudAuthError,
  CloudClient,
  CloudRequestError,
  CloudUnavailableError,
  normalizeRelayBaseUrl,
  relayApiBaseUrl,
  type FetchLike,
} from "../src/main/cloud/cloud-client";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Records what the client asked for and replays a canned answer. */
function recordingFetch(reply: (call: Call) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(reply({ url, init }));
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function client(
  fetchImpl: FetchLike,
  options: { token?: string | undefined; timeoutMs?: number } = {},
): CloudClient {
  return new CloudClient({
    baseUrl: "https://relay.example.com/",
    getToken: () => Promise.resolve("token" in options ? options.token : "tok_live"),
    fetch: fetchImpl,
    timeoutMs: options.timeoutMs ?? 5_000,
  });
}

/** A relay that answers nothing, the way a hung host behaves under abort. */
const hangingFetch: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
  const fail = () => reject(new DOMException("aborted", "AbortError"));
  if (init?.signal?.aborted) return fail();
  init?.signal?.addEventListener("abort", fail);
});

describe("normalizeRelayBaseUrl", () => {
  it("drops trailing slashes so paths join cleanly", () => {
    expect(normalizeRelayBaseUrl("https://relay.example.com///")).toBe("https://relay.example.com");
  });

  it("refuses an empty or unparseable URL", () => {
    expect(() => normalizeRelayBaseUrl("   ")).toThrow(CloudRequestError);
    expect(() => normalizeRelayBaseUrl("relay.example.com")).toThrow(CloudRequestError);
  });

  it("refuses a non-http scheme", () => {
    expect(() => normalizeRelayBaseUrl("ftp://relay.example.com")).toThrow(/http or https/);
  });

  it("appends the version prefix an OpenAI-compatible client expects", () => {
    expect(relayApiBaseUrl("https://relay.example.com/")).toBe("https://relay.example.com/v1");
  });
});

describe("CloudClient.mintRealtimeSecret", () => {
  it("posts the model and voice with a bearer token and returns the secret", async () => {
    const { fetch, calls } = recordingFetch(() => json({ value: "ek_abc", expires_at: 123 }));
    const secret = await client(fetch).mintRealtimeSecret({ model: "gpt-realtime-2.1-mini", voice: "marin" });

    expect(secret).toEqual({ value: "ek_abc", expires_at: 123 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://relay.example.com/v1/realtime/secret");
    expect(calls[0].init?.method).toBe("POST");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok_live");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ model: "gpt-realtime-2.1-mini", voice: "marin" });
  });

  it("refuses before any request when no token is saved", async () => {
    const { fetch, calls } = recordingFetch(() => json({ value: "ek_abc" }));
    await expect(client(fetch, { token: undefined }).mintRealtimeSecret()).rejects.toThrow(CloudAuthError);
    expect(calls).toHaveLength(0);
  });

  it("reports a rejected token as an auth failure", async () => {
    const { fetch } = recordingFetch(() => new Response("bad token", { status: 401 }));
    await expect(client(fetch).mintRealtimeSecret()).rejects.toThrow(CloudAuthError);
  });

  it("reports a forbidden account as an auth failure", async () => {
    const { fetch } = recordingFetch(() => new Response("over quota", { status: 403 }));
    const error = await client(fetch).mintRealtimeSecret().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CloudAuthError);
    expect((error as CloudAuthError).status).toBe(403);
  });

  it("reports a relay outage as unavailable", async () => {
    const { fetch } = recordingFetch(() => new Response("boom", { status: 502 }));
    await expect(client(fetch).mintRealtimeSecret()).rejects.toThrow(CloudUnavailableError);
  });

  it("reports a network failure as unavailable rather than leaking the raw error", async () => {
    const fetch: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    const error = await client(fetch).mintRealtimeSecret().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CloudUnavailableError);
    expect((error as Error).message).toContain("https://relay.example.com");
  });

  it("gives up on a relay that never answers", async () => {
    const error = await client(hangingFetch, { timeoutMs: 10 })
      .mintRealtimeSecret()
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CloudUnavailableError);
    expect((error as Error).message).toContain("did not respond");
  });

  it("lets a caller's own cancellation through untouched", async () => {
    const controller = new AbortController();
    const pending = client(hangingFetch).mintRealtimeSecret({ signal: controller.signal });
    controller.abort();
    const error = await pending.catch((thrown: unknown) => thrown);
    expect(error).not.toBeInstanceOf(CloudUnavailableError);
    expect((error as Error).name).toBe("AbortError");
  });

  it("refuses a response with no client secret in it", async () => {
    const { fetch } = recordingFetch(() => json({ expires_at: 1 }));
    await expect(client(fetch).mintRealtimeSecret()).rejects.toThrow(/did not return a realtime client secret/);
  });

  it("refuses a body that is not JSON at all", async () => {
    const { fetch } = recordingFetch(() => new Response("<html>nope</html>", { status: 200 }));
    await expect(client(fetch).mintRealtimeSecret()).rejects.toThrow(CloudRequestError);
  });
});

describe("CloudClient.getMe", () => {
  it("returns the account the relay reports", async () => {
    const { fetch, calls } = recordingFetch(() => json({
      accountId: "acct_1",
      email: "someone@example.com",
      tier: "beta",
      usageThisPeriod: { requests: 12 },
    }));
    const account = await client(fetch).getMe();

    expect(account.email).toBe("someone@example.com");
    expect(account.usageThisPeriod?.requests).toBe(12);
    expect(calls[0].url).toBe("https://relay.example.com/v1/me");
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.body).toBeUndefined();
  });

  it("refuses an account response with no account id", async () => {
    const { fetch } = recordingFetch(() => json({ email: "someone@example.com" }));
    await expect(client(fetch).getMe()).rejects.toThrow(/did not return an account/);
  });
});

describe("CloudClient.listModels", () => {
  it("maps the allowlist into picker options", async () => {
    const { fetch, calls } = recordingFetch(() => json({
      models: [
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", reasoning: true, contextWindow: 272000 },
        { id: "gpt-5.6-sol" },
      ],
    }));
    const models = await client(fetch).listModels();

    expect(calls[0].url).toBe("https://relay.example.com/v1/models");
    expect(models).toEqual([
      { id: "gpt-5.6-luna", provider: "wiley-cloud", name: "GPT-5.6 Luna", reasoning: true, contextWindow: 272000 },
      { id: "gpt-5.6-sol", provider: "wiley-cloud" },
    ]);
  });

  it("drops entries with no id rather than surfacing half a model", async () => {
    const { fetch } = recordingFetch(() => json({
      models: [{ name: "nameless" }, null, "nope", { id: "gpt-5.6-terra" }],
    }));
    expect(await client(fetch).listModels()).toEqual([{ id: "gpt-5.6-terra", provider: "wiley-cloud" }]);
  });

  it("drops a relay model from outside the allowed family", async () => {
    const { fetch } = recordingFetch(() => json({ models: [{ id: "gpt-5.4-mini" }, { id: "gpt-4o" }] }));
    expect(await client(fetch).listModels()).toEqual([]);
  });

  it("accepts a bare array, which is what a plain proxy returns", async () => {
    const { fetch } = recordingFetch(() => json([{ id: "gpt-5.6-luna", provider: "openai" }]));
    expect(await client(fetch).listModels()).toEqual([{ id: "gpt-5.6-luna", provider: "openai" }]);
  });
});
