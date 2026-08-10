import { env } from "../env";

/**
 * Minimal Google Gemini client (Task #378 — cost-analysis generation).
 *
 * Deliberately SEPARATE from the OpenAI-compatible document-parsing path
 * (server/gmail/document-parser.ts): the user explicitly chose Gemini for
 * the cost-analysis appendix. Plain REST call — no SDK dependency.
 *
 * Fails EXPLICITLY when the key is missing or the API errors; no silent
 * fallback to another provider.
 */

export const GEMINI_MODEL_ID = "gemini-2.5-flash";

const GEMINI_TIMEOUT_MS = 120_000;

/**
 * Task #384 — thrown when the Gemini call exceeds the client timeout and is
 * aborted. Lets routes map this specific (transient, retryable) failure to a
 * distinct error code so the UI can offer a one-click retry, while every
 * other failure (missing key, blocked prompt, API error) stays verbatim.
 */
export class GeminiTimeoutError extends Error {
  constructor() {
    super(
      `Gemini did not respond within ${Math.round(GEMINI_TIMEOUT_MS / 1000)}s and the request was aborted.`,
    );
    this.name = "GeminiTimeoutError";
  }
}

export function isGeminiConfigured(): boolean {
  return Boolean(env.GEMINI_API_KEY) || env.E2E_FAKE_GEMINI;
}

export async function generateWithGemini(input: {
  systemPrompt: string;
  userContent: string;
}): Promise<{ text: string; modelId: string }> {
  if (env.E2E_FAKE_GEMINI) {
    return { text: FAKE_GEMINI_COST_ANALYSIS, modelId: "fake-gemini-e2e" };
  }
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured — cost-analysis generation requires a Google Gemini API key.",
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_ID}:generateContent`;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, GEMINI_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: input.userContent }] }],
        generationConfig: { temperature: 0.3 },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut || (err instanceof Error && err.name === "AbortError")) {
      throw new GeminiTimeoutError();
    }
    throw new Error(
      `Gemini request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const bodyText = (await resp.text().catch(() => "")).slice(0, 500);
    throw new Error(`Gemini API error ${resp.status}: ${bodyText}`);
  }

  const data = (await resp.json()) as {
    candidates?: Array<{
      finishReason?: string;
      content?: { parts?: Array<{ text?: string }> };
    }>;
    promptFeedback?: { blockReason?: string };
  };

  if (data.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the request: ${data.promptFeedback.blockReason}`);
  }
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) {
    throw new Error(
      `Gemini returned an empty response${candidate?.finishReason ? ` (finishReason: ${candidate.finishReason})` : ""}.`,
    );
  }
  return { text, modelId: GEMINI_MODEL_ID };
}

/**
 * Deterministic canned output used only under E2E_FAKE_GEMINI (browser
 * tests). Deliberately includes a fragmented table row so the tolerant
 * parser path is exercised end-to-end.
 */
export const FAKE_GEMINI_COST_ANALYSIS = `## Summary
This quotation covers the renovation works with a total budget in line with regional benchmarks. The majority of the spend sits in structural and waterproofing works, which are **mandatory**; several finish-level choices offer savings.

## Cost Center Summary
| Cost Center | Included Sub-Works | Necessity | Est. Cost (TTC) | Savings Opportunity |
| --- | --- | --- | --- | --- |
| Exterior Terrace | Site setup; draining; tiling | Mixed | €20,997.87 | Medium |
| Structural Works | Slab; reinforcement
| Mandatory | €35,000.00
| Low |

## Value Engineering
**Opportunity:** Replace the uncoupling membrane with a standard screed cure period. **Estimated Saving:** €1,800. **Trade-off:** Longer drying time before tiling.
`;
