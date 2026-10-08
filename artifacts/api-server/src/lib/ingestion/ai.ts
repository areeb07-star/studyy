import { createHash } from "node:crypto";
import OpenAI from "openai";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { aiCacheTable } from "@workspace/db/schema";

export const modelConfig = {
  structure: process.env.STUDYGRAPH_STRUCTURE_MODEL ?? "gpt-4.1-mini",
  vision: process.env.STUDYGRAPH_VISION_MODEL ?? "gpt-4.1-mini",
  tutor: process.env.STUDYGRAPH_TUTOR_MODEL ?? "gpt-4.1-mini",
  assessment: process.env.STUDYGRAPH_ASSESSMENT_MODEL ?? "gpt-4.1-mini",
  embedding: process.env.STUDYGRAPH_EMBEDDING_MODEL ?? "text-embedding-3-small",
  transcription: process.env.STUDYGRAPH_TRANSCRIPTION_MODEL ?? "whisper-1",
};

let client: OpenAI | undefined;

export function openai(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OpenAI is not configured. Add OPENAI_API_KEY in Replit Secrets before processing sources.",
    );
  }
  client = new OpenAI({ apiKey });
  return client;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const status =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status?: unknown }).status)
          : 0;
      const retryable =
        status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
      if (!retryable || attempt === 4) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(800 * 2 ** attempt, 12_000)),
      );
    }
  }
  throw lastError;
}

export async function cachedAI<T>(
  cacheKey: string,
  model: string,
  create: () => Promise<T>,
): Promise<T> {
  const [cached] = await db
    .select({ response: aiCacheTable.response })
    .from(aiCacheTable)
    .where(eq(aiCacheTable.cacheKey, cacheKey))
    .limit(1);
  if (cached) return cached.response as T;

  const response = await create();
  await db
    .insert(aiCacheTable)
    .values({ cacheKey, model, response })
    .onConflictDoUpdate({
      target: aiCacheTable.cacheKey,
      set: { model, response, createdAt: new Date() },
    });
  return response;
}

export async function mapLimit<T, R>(
  values: T[],
  limit: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]");
}
