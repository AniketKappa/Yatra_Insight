// Groq client setup and shared helpers.

import Groq from "groq-sdk";

export const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
type Effort = "low" | "medium" | "high";
export const EFFORT: Effort = (["low", "medium", "high"] as const).find((e) => e === process.env.GROQ_REASONING_EFFORT) ?? "medium";
/** Reasoning controls are only accepted by Groq's reasoning models. */
export const IS_REASONING_MODEL = /gpt-oss|qwen3/i.test(MODEL);

let client: Groq | null = null;

export function llmConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

export function getClient(): Groq | null {
  if (!llmConfigured()) return null;
  client ??= new Groq({ maxRetries: 2, timeout: 120_000 });
  return client;
}

/** Extra request params for reasoning models: think, but don't print the reasoning into the answer. */
export function reasoningParams(): { reasoning_effort?: Effort; include_reasoning?: boolean } {
  return IS_REASONING_MODEL ? { reasoning_effort: EFFORT, include_reasoning: false } : {};
}

/** Human-readable explanation for an API failure (shown in the UI). */
export function describeError(err: unknown): string {
  if (err instanceof Groq.AuthenticationError) return "The Groq API key was rejected. Check GROQ_API_KEY in .env.";
  if (err instanceof Groq.PermissionDeniedError) return "This Groq API key doesn't have access to the configured model.";
  if (err instanceof Groq.NotFoundError) return `The model "${MODEL}" wasn't found on Groq. Check GROQ_MODEL.`;
  if (err instanceof Groq.RateLimitError) return "The Groq rate limit was reached. Try again in a minute.";
  if (err instanceof Groq.BadRequestError) return `Groq rejected the request: ${err.message}`;
  if (err instanceof Groq.APIConnectionTimeoutError) return "The request to Groq timed out.";
  if (err instanceof Groq.APIUserAbortError) return "The request was cancelled.";
  if (err instanceof Groq.APIConnectionError) return "Couldn't reach the Groq API (network error).";
  if (err instanceof Groq.APIError) return `Groq API error ${err.status ?? ""}: ${err.message}`.trim();
  return (err as Error)?.message || "Unknown error";
}
