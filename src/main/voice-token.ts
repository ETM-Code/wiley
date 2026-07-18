const REALTIME_ENDPOINT = "https://api.openai.com/v1/realtime/client_secrets";
export const VOICE_MODEL = "gpt-realtime-2.1" as const;

export interface RealtimeClientSecret {
  value: string;
  expires_at?: number;
}

export async function mintRealtimeToken(
  apiKey = process.env.OPENAI_API_KEY,
  signal?: AbortSignal,
): Promise<RealtimeClientSecret> {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured in the Electron main process");
  const response = await fetch(REALTIME_ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: {
        type: "realtime",
        model: VOICE_MODEL,
        audio: { output: { voice: "marin" } },
      },
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Realtime token request failed (${response.status}): ${detail}`);
  }
  const body = (await response.json()) as RealtimeClientSecret;
  if (!body.value?.startsWith("ek_")) throw new Error("Realtime token response did not contain a client secret");
  return body;
}
