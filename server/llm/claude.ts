// Claude client setup and shared helpers.

import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const efforts: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const EFFORT: Effort = efforts.find((e) => e === process.env.ANTHROPIC_EFFORT) ?? "medium";
// Server-side refusal fallback: if the model declines for policy reasons the API
// retries on its default fallback model inside the same call. Set
// ANTHROPIC_FALLBACKS=off to disable.
export const USE_FALLBACKS = process.env.ANTHROPIC_FALLBACKS !== "off";
export const FALLBACK_BETAS = USE_FALLBACKS ? ["server-side-fallback-2026-07-01"] : [];

let client: Anthropic | null = null;

export function llmConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function getClient(): Anthropic | null {
  if (!llmConfigured()) return null;
  client ??= new Anthropic({ maxRetries: 2, timeout: 120_000 });
  return client;
}

export class RefusalError extends Error {}

/** Human-readable explanation for an API failure (shown in the UI). */
export function describeError(err: unknown): string {
  if (err instanceof RefusalError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key doesn't have access to the configured model.";
  if (err instanceof Anthropic.NotFoundError) return `The model "${MODEL}" wasn't found. Check ANTHROPIC_MODEL.`;
  if (err instanceof Anthropic.RateLimitError) return "The Claude API rate limit was reached. Try again in a minute.";
  if (err instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "The request to Claude timed out.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Claude API (network error).";
  if (err instanceof Anthropic.APIUserAbortError) return "The request was cancelled.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ""}: ${err.message}`.trim();
  return (err as Error)?.message || "Unknown error";
}

export function fallbackParams(): { betas?: string[]; fallbacks?: "default" } {
  return USE_FALLBACKS ? { betas: FALLBACK_BETAS, fallbacks: "default" } : {};
}
