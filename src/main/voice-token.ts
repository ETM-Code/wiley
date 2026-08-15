import { DEFAULT_VOICE_MODEL, DEFAULT_VOICE_NAME } from "./settings/settings-schema";

const REALTIME_ENDPOINT = "https://api.openai.com/v1/realtime/client_secrets";

export { DEFAULT_VOICE_MODEL, DEFAULT_VOICE_NAME };

export interface RealtimeClientSecret {
  value: string;
  expires_at?: number;
}

export interface MintRealtimeTokenOptions {
  /** The realtime model id from settings. */
  model?: string;
  voice?: string;
  apiKey?: string;
  signal?: AbortSignal;
}

export async function mintRealtimeToken(options: MintRealtimeTokenOptions = {}): Promise<RealtimeClientSecret> {
  const { model = DEFAULT_VOICE_MODEL, voice = DEFAULT_VOICE_NAME, apiKey, signal } = options;
  if (!apiKey) throw new Error("No OpenAI API key is configured. Add one in Settings, or set OPENAI_API_KEY.");
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
        model,
        audio: { output: { voice } },
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
