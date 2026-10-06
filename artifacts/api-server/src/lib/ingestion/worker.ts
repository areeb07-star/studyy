import { createWriteStream } from "node:fs";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  conceptEdgesTable,
  conceptsTable,
  aiCacheTable,
  ingestionJobsTable,
  sourcesTable,
  topicsTable,
  unitConceptsTable,
  unitsTable,
  type SourceLocator,
} from "@workspace/db/schema";
import { ObjectStorageService } from "../objectStorage";
import {
  cachedAI,
  errorMessage,
  mapLimit,
  modelConfig,
  openai,
  sha256,
  withRetry,
} from "./ai";
import { logger } from "../logger";

const storage = new ObjectStorageService();
const MAX_VIDEO_SECONDS = 2 * 60 * 60;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const VIDEO_FRAME_INTERVAL_SEC = 90;
const MAX_VIDEO_FRAMES = 80;

type DocumentPage = {
  number: number;
  text: string;
  image: string;
  type: "page" | "slide";
};

type UnitDraft = {
  text: string;
  figureCaption: string | null;
  locator: SourceLocator;
  language: string;
};

type VisualDescription = {
  hasMeaningfulVisual: boolean;
  caption: string | null;
};

type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

type Taxonomy = {
  topics: Array<{
    name: string;
    description: string;
    concepts: Array<{
      name: string;
      description: string;
      unitIndexes: number[];
      prerequisiteNames: string[];
    }>;
  }>;
};

function sourceError(error: unknown): string {
  const message = errorMessage(error).trim();
  return message.slice(0, 1200) || "Source processing failed.";
}

async function setProgress(
  sourceId: string,
  status: "queued" | "processing" | "ready" | "failed",
  progress: number,
  currentStep: string | null,
  error: string | null = null,
  unitsCreated?: number,
): Promise<void> {
  const updatedAt = new Date();
  const values = {
    status,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    currentStep,
    error,
    updatedAt,
    ...(unitsCreated === undefined ? {} : { unitsCreated }),
  };
  await Promise.all([
    db.update(sourcesTable).set(values).where(eq(sourcesTable.id, sourceId)),
    db
      .update(ingestionJobsTable)
      .set(values)
      .where(eq(ingestionJobsTable.id, sourceId)),
  ]);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; maxOutput?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const process = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    const maxOutput = options.maxOutput ?? 2 * 1024 * 1024;

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > maxOutput) {
        process.kill("SIGKILL");
        rejectPromise(new Error(`${command} produced too much output.`));
        return;
      }
      target.push(chunk);
    };
    process.stdout.on("data", collect(stdout));
    process.stderr.on("data", collect(stderr));
    process.on("error", (error) => {
      rejectPromise(
        new Error(
          `Could not start ${command}. Install the required system tool and try again: ${error.message}`,
        ),
      );
    });
    process.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolvePromise(result);
      } else {
        const detail = (result.stderr || result.stdout).trim().slice(-1600);
        rejectPromise(
          new Error(`${command} exited with code ${code ?? "unknown"}: ${detail}`),
        );
      }
    });
  });
}

async function downloadSource(source: typeof sourcesTable.$inferSelect, workDir: string) {
  if (source.sourceType === "video" && source.sourceUrl) {
    const root = resolve(process.cwd(), "../..");
    const target = join(workDir, "video.%(ext)s");
    await runCommand(
      "uv",
      [
        "run",
        "--project",
        root,
        "python3",
        "-m",
        "yt_dlp",
        "--no-playlist",
        "--format",
        "best[height<=720]/best",
        "--merge-output-format",
        "mp4",
        "--max-filesize",
        `${Math.floor(MAX_VIDEO_BYTES / (1024 * 1024))}M`,
        "--output",
        target,
        "--",
        source.sourceUrl,
      ],
      { cwd: root, maxOutput: 8 * 1024 * 1024 },
    );
    const files = (await readdir(workDir)).filter(
      (name) => name.startsWith("video.") && !name.endsWith(".part"),
    );
    const video = files.find((name) => extname(name).toLowerCase() !== ".description");
    if (!video) throw new Error("YouTube did not provide a downloadable video.");
    return join(workDir, video);
  }

  if (!source.storagePath) {
    throw new Error("The uploaded source has no storage path.");
  }
  const file = await storage.getObjectEntityFile(source.storagePath);
  const [metadata] = await file.getMetadata();
  const actualSize = Number(metadata.size ?? 0);
  if (actualSize < 1) throw new Error("The uploaded file is empty.");
  if (actualSize > MAX_VIDEO_BYTES && source.sourceType === "video") {
    throw new Error("Video files larger than 500 MB cannot be processed.");
  }
  const extension = extname(source.originalFilename ?? "") || ".bin";
  const target = join(workDir, `source${extension}`);
  await pipeline(file.createReadStream(), createWriteStream(target));
  return target;
}

function splitText(text: string, maxLength = 1400): string[] {
  const normalized = text.replace(/\r/g, "").trim();
  if (normalized.length <= maxLength) return normalized ? [normalized] : [];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    let boundary = remaining.lastIndexOf("\n\n", maxLength);
    if (boundary < maxLength * 0.55) boundary = remaining.lastIndexOf(" ", maxLength);
    if (boundary < maxLength * 0.55) boundary = maxLength;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function describeImage(imagePath: string): Promise<VisualDescription> {
  const image = await readFile(imagePath);
  const key = `vision:${modelConfig.vision}:${sha256(image)}`;
  return cachedAI<VisualDescription>(key, modelConfig.vision, async () => {
    const completion = await withRetry(() =>
      openai().chat.completions.create({
        model: modelConfig.vision,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Describe only meaningful diagrams, charts, equations, tables, or instructional images visible in the supplied lecture page. Do not repeat body text. Do not infer unreadable labels or facts. If there is no meaningful visual, return {\"hasMeaningfulVisual\":false,\"caption\":null}. Otherwise return concise factual JSON: {\"hasMeaningfulVisual\":true,\"caption\":\"...\"}.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Provide an accurate, source-grounded caption for this page image.",
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${image.toString("base64")}`,
                  detail: "high",
                },
              },
            ],
          },
        ],
        max_completion_tokens: 350,
      }),
    );
    const content = completion.choices[0]?.message.content;
    if (!content) throw new Error("The vision model returned an empty response.");
    const parsed = JSON.parse(content) as Partial<VisualDescription>;
    if (typeof parsed.hasMeaningfulVisual !== "boolean") {
      throw new Error("The vision model returned an invalid caption response.");
    }
    const caption =
      parsed.hasMeaningfulVisual && typeof parsed.caption === "string"
        ? parsed.caption.trim().slice(0, 1800)
        : null;
    return { hasMeaningfulVisual: parsed.hasMeaningfulVisual, caption };
  });
}

function addDocumentPageUnits(
  page: DocumentPage,
  caption: string | null,
  imagePath: string | undefined,
  language: string,
): UnitDraft[] {
  const locator: SourceLocator =
    page.type === "slide"
      ? { type: "slide", slide: page.number, ...(imagePath ? { imagePath } : {}) }
      : { type: "page", page: page.number, ...(imagePath ? { imagePath } : {}) };
  const chunks = splitText(page.text);
  if (!chunks.length && caption) chunks.push(caption);
  if (!chunks.length) return [];
  return chunks.map((text, index) => ({
    text,
    figureCaption: index === 0 ? caption : null,
    locator,
    language,
  }));
}

async function processDocument(
  source: typeof sourcesTable.$inferSelect,
  inputPath: string,
  workDir: string,
): Promise<UnitDraft[]> {
  const root = resolve(process.cwd(), "../..");
  const scriptPath = resolve(
    process.cwd(),
    "src/lib/ingestion/extract.py",
  );
  const renderDir = join(workDir, "rendered");
  await runCommand(
    "uv",
    [
      "run",
      "--project",
      root,
      "python3",
      scriptPath,
      source.sourceType,
      inputPath,
      renderDir,
    ],
    { cwd: root, maxOutput: 4 * 1024 * 1024 },
  );
  const manifest = JSON.parse(
    await readFile(join(renderDir, "manifest.json"), "utf8"),
  ) as { pages: DocumentPage[] };
  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    throw new Error("No pages or slides could be extracted from this file.");
  }

  await setProgress(
    source.id,
    "processing",
    34,
    `Describing figures and rendering source pages (0/${manifest.pages.length})`,
  );
  let completed = 0;
  let progressWrites = Promise.resolve();
  const drafts = await mapLimit(manifest.pages, 3, async (page) => {
    const description = await describeImage(page.image);
    const caption = description.caption;
    let imagePath: string | undefined;
    if (page.text.trim() || caption) {
      imagePath = await storage.saveDerivedObject({
        sourceId: source.id,
        fileName: `${page.type}-${String(page.number).padStart(4, "0")}.png`,
        contentType: "image/png",
        bytes: await readFile(page.image),
        ownerId: source.ownerId,
      });
    }
    completed += 1;
    const current = completed;
    progressWrites = progressWrites.then(() =>
      setProgress(
        source.id,
        "processing",
        34 + (current / manifest.pages.length) * 24,
        `Describing figures and rendering source pages (${current}/${manifest.pages.length})`,
      ),
    );
    await progressWrites;
    return addDocumentPageUnits(page, caption, imagePath, source.language);
  });
  return drafts.flat();
}

async function getVideoDuration(videoPath: string): Promise<number> {
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    videoPath,
  ]);
  const parsed = JSON.parse(result.stdout) as { format?: { duration?: string } };
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("The video duration could not be read.");
  }
  if (duration > MAX_VIDEO_SECONDS) {
    throw new Error("Videos longer than two hours are not supported.");
  }
  return duration;
}

async function hasAudioStream(videoPath: string): Promise<boolean> {
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a",
    "-show_entries",
    "stream=index",
    "-of",
    "json",
    videoPath,
  ]);
  const parsed = JSON.parse(result.stdout) as { streams?: unknown[] };
  return Boolean(parsed.streams?.length);
}

async function transcribeAudio(
  videoPath: string,
  duration: number,
  workDir: string,
  language: string,
): Promise<TranscriptSegment[]> {
  const audioDir = join(workDir, "audio");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(audioDir, { recursive: true }),
  );
  await runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "segment",
    "-segment_time",
    "600",
    "-reset_timestamps",
    "1",
    "-segment_format",
    "wav",
    join(audioDir, "chunk-%03d.wav"),
  ]);
  const chunks = (await readdir(audioDir))
    .filter((name) => name.endsWith(".wav"))
    .sort();
  if (!chunks.length) throw new Error("No audio could be extracted from this video.");

  const segments = await mapLimit(chunks, 2, async (name, index) => {
    const chunkPath = join(audioDir, name);
    const offset = index * 600;
    const transcription = await withRetry(() =>
      openai().audio.transcriptions.create({
        file: createReadStream(chunkPath),
        model: modelConfig.transcription,
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
        ...(language && language !== "auto" ? { language } : {}),
      }),
    );
    const result = transcription as {
      text?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
    };
    if (Array.isArray(result.segments) && result.segments.length) {
      return result.segments
        .filter((segment) => segment.text.trim())
        .map((segment) => ({
          start: offset + Math.max(0, segment.start),
          end: Math.min(duration, offset + Math.max(segment.end, segment.start + 0.1)),
          text: segment.text.trim(),
        }));
    }
    if (result.text?.trim()) {
      return [
        {
          start: offset,
          end: Math.min(duration, offset + 600),
          text: result.text.trim(),
        },
      ];
    }
    return [];
  });
  return segments.flat().sort((a, b) => a.start - b.start);
}

async function processVideo(
  source: typeof sourcesTable.$inferSelect,
  videoPath: string,
  workDir: string,
): Promise<UnitDraft[]> {
  const duration = await getVideoDuration(videoPath);
  let transcript: TranscriptSegment[] = [];
  if (await hasAudioStream(videoPath)) {
    await setProgress(source.id, "processing", 30, "Transcribing video audio");
    transcript = await transcribeAudio(videoPath, duration, workDir, source.language);
  }

  const framesDir = join(workDir, "frames");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(framesDir, { recursive: true }),
  );
  await setProgress(source.id, "processing", 50, "Sampling representative video frames");
  await runCommand(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      videoPath,
      "-vf",
      `fps=1/${VIDEO_FRAME_INTERVAL_SEC},scale='min(1280,iw)':-2`,
      "-frames:v",
      String(MAX_VIDEO_FRAMES),
      "-q:v",
      "3",
      join(framesDir, "frame-%04d.jpg"),
    ],
    { maxOutput: 1024 * 1024 },
  );
  const frameFiles = (await readdir(framesDir))
    .filter((name) => name.endsWith(".jpg"))
    .sort();
  const frameDescriptions = await mapLimit(frameFiles, 3, async (name, index) => {
    const framePath = join(framesDir, name);
    const bytes = await readFile(framePath);
    const timeSec = Math.min(duration, index * VIDEO_FRAME_INTERVAL_SEC);
    const key = `video-vision:${modelConfig.vision}:${sha256(bytes)}`;
    const description = await cachedAI<VisualDescription>(
      key,
      modelConfig.vision,
      async () => {
        const completion = await withRetry(() =>
          openai().chat.completions.create({
            model: modelConfig.vision,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  "Describe only meaningful instructional visuals, diagrams, equations, charts, or on-screen text. Do not invent speech or events. If there is no useful visual, return {\"hasMeaningfulVisual\":false,\"caption\":null}; otherwise return concise factual JSON {\"hasMeaningfulVisual\":true,\"caption\":\"...\"}.",
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `This is a sampled frame at ${timeSec} seconds. Caption only what is visibly present.`,
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/jpeg;base64,${bytes.toString("base64")}`,
                      detail: "high",
                    },
                  },
                ],
              },
            ],
            max_completion_tokens: 350,
          }),
        );
        const content = completion.choices[0]?.message.content;
        if (!content) throw new Error("The vision model returned an empty response.");
        const parsed = JSON.parse(content) as Partial<VisualDescription>;
        if (typeof parsed.hasMeaningfulVisual !== "boolean") {
          throw new Error("The vision model returned an invalid frame caption.");
        }
        return {
          hasMeaningfulVisual: parsed.hasMeaningfulVisual,
          caption:
            parsed.hasMeaningfulVisual && typeof parsed.caption === "string"
              ? parsed.caption.trim().slice(0, 1800)
              : null,
        };
      },
    );
    return { timeSec, framePath, bytes, caption: description.caption };
  });

  const imagePaths = await Promise.all(
    frameDescriptions.map(async (frame, index) => {
      if (!frame.caption) return undefined;
      return storage.saveDerivedObject({
        sourceId: source.id,
        fileName: `frame-${String(index + 1).padStart(4, "0")}.jpg`,
        contentType: "image/jpeg",
        bytes: frame.bytes,
        ownerId: source.ownerId,
      });
    }),
  );

  const assignedFrames = new Set<number>();
  const drafts: UnitDraft[] = transcript.map((segment) => {
    const midpoint = (segment.start + segment.end) / 2;
    let closest = -1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < frameDescriptions.length; index += 1) {
      const distance = Math.abs(frameDescriptions[index].timeSec - midpoint);
      if (distance <= VIDEO_FRAME_INTERVAL_SEC / 2 && distance < closestDistance) {
        closest = index;
        closestDistance = distance;
      }
    }
    const caption = closest >= 0 ? frameDescriptions[closest].caption : null;
    const imagePath = closest >= 0 ? imagePaths[closest] : undefined;
    if (closest >= 0 && caption) assignedFrames.add(closest);
    return {
      text: segment.text,
      figureCaption: caption ?? null,
      locator: {
        type: "video",
        start_sec: segment.start,
        end_sec: segment.end,
        ...(imagePath ? { imagePath } : {}),
      },
      language: source.language,
    };
  });

  frameDescriptions.forEach((frame, index) => {
    if (!frame.caption || assignedFrames.has(index)) return;
    const start = frame.timeSec;
    drafts.push({
      text: `Visual scene: ${frame.caption}`,
      figureCaption: frame.caption,
      locator: {
        type: "video",
        start_sec: start,
        end_sec: Math.min(duration, start + VIDEO_FRAME_INTERVAL_SEC),
        ...(imagePaths[index] ? { imagePath: imagePaths[index] } : {}),
      },
      language: source.language,
    });
  });

  if (!drafts.length) {
    throw new Error("No speech transcript or meaningful visual frames were extracted.");
  }
  return drafts;
}

async function embedUnits(
  unitRows: Array<{ id: string; text: string; figureCaption: string | null }>,
): Promise<void> {
  for (let start = 0; start < unitRows.length; start += 64) {
    const batch = unitRows.slice(start, start + 64);
    const texts = batch.map((unit) =>
      [unit.text, unit.figureCaption ? `Figure: ${unit.figureCaption}` : ""]
        .filter(Boolean)
        .join("\n"),
    );
    const cacheKeys = texts.map(
      (text) => `embedding:${modelConfig.embedding}:${sha256(text)}`,
    );
    const cachedRows = await db
      .select({ cacheKey: aiCacheTable.cacheKey, response: aiCacheTable.response })
      .from(aiCacheTable)
      .where(inArray(aiCacheTable.cacheKey, cacheKeys));
    const vectorsByKey = new Map<string, number[]>(
      cachedRows.map((row) => [row.cacheKey, row.response as number[]]),
    );
    const missingIndexes = cacheKeys
      .map((key, index) => (vectorsByKey.has(key) ? -1 : index))
      .filter((index) => index >= 0);

    if (missingIndexes.length) {
      const response = await withRetry(() =>
        openai().embeddings.create({
          model: modelConfig.embedding,
          input: missingIndexes.map((index) => texts[index]),
          encoding_format: "float",
        }),
      );
      const ordered = [...response.data].sort((a, b) => a.index - b.index);
      if (
        ordered.length !== missingIndexes.length ||
        ordered.some((row) => !row.embedding.length)
      ) {
        throw new Error("The embedding provider returned an incomplete result.");
      }
      if (ordered.some((row) => row.embedding.length !== 1536)) {
        throw new Error(
          "The configured embedding model must return 1,536 dimensions to match the indexed StudyGraph vector schema.",
        );
      }
      const cacheEntries = ordered.map((row, index) => ({
        cacheKey: cacheKeys[missingIndexes[index]],
        model: modelConfig.embedding,
        response: row.embedding,
      }));
      await db
        .insert(aiCacheTable)
        .values(cacheEntries)
        .onConflictDoUpdate({
          target: aiCacheTable.cacheKey,
          set: { response: sql`excluded.response`, model: modelConfig.embedding },
        });
      cacheEntries.forEach((entry) =>
        vectorsByKey.set(entry.cacheKey, entry.response as number[]),
      );
    }

    const vectors = cacheKeys.map((key) => vectorsByKey.get(key));
    if (vectors.some((vector) => !vector)) {
      throw new Error("A source unit could not be matched to its cached embedding.");
    }
    await Promise.all(
      batch.map((unit, index) =>
        db
          .update(unitsTable)
          .set({ embedding: vectors[index]! })
          .where(eq(unitsTable.id, unit.id)),
      ),
    );
  }
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180);
}

async function buildTaxonomy(
  courseId: string,
  unitRows: Array<{ id: string; text: string; figureCaption: string | null }>,
): Promise<void> {
  const pendingEdges: Array<{ prerequisite: string; dependent: string }> = [];
  for (let start = 0; start < unitRows.length; start += 20) {
    const batch = unitRows.slice(start, start + 20);
    const promptData = batch.map((unit, index) => ({
      unitIndex: index,
      excerpt: `${unit.text}\n${unit.figureCaption ? `Visual: ${unit.figureCaption}` : ""}`.slice(
        0,
        2000,
      ),
    }));
    const serialized = JSON.stringify(promptData);
    const cacheKey = `taxonomy:${modelConfig.structure}:${sha256(serialized)}`;
    const taxonomy = await cachedAI<Taxonomy>(cacheKey, modelConfig.structure, async () => {
      const completion = await withRetry(() =>
        openai().chat.completions.create({
          model: modelConfig.structure,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "Organize the supplied study units into a concise topic hierarchy and atomic concepts. Use only ideas supported by the excerpts. Return JSON {\"topics\":[{\"name\":\"...\",\"description\":\"...\",\"concepts\":[{\"name\":\"...\",\"description\":\"...\",\"unitIndexes\":[0],\"prerequisiteNames\":[]}]}]}. Each concept must cite one or more supplied unitIndexes. Do not invent concepts or prerequisite relationships. Use at most 8 topics and 8 concepts per topic for this batch. If the excerpts contain no teachable content, return {\"topics\":[]}.",
            },
            {
              role: "user",
              content: `Create source-grounded topics and concepts for these units:\n${serialized}`,
            },
          ],
          max_completion_tokens: 2500,
        }),
      );
      const content = completion.choices[0]?.message.content;
      if (!content) throw new Error("The structure model returned an empty response.");
      const parsed = JSON.parse(content) as Partial<Taxonomy>;
      if (!Array.isArray(parsed.topics)) {
        throw new Error("The structure model returned an invalid topic hierarchy.");
      }
      return {
        topics: parsed.topics.map((topic) => ({
          name: String(topic.name ?? "").trim().slice(0, 180),
          description: String(topic.description ?? "").trim().slice(0, 1200),
          concepts: Array.isArray(topic.concepts)
            ? topic.concepts.map((concept) => ({
                name: String(concept.name ?? "").trim().slice(0, 180),
                description: String(concept.description ?? "").trim().slice(0, 1200),
                unitIndexes: Array.isArray(concept.unitIndexes)
                  ? concept.unitIndexes.filter(
                      (value): value is number =>
                        Number.isInteger(value) && value >= 0 && value < batch.length,
                    )
                  : [],
                prerequisiteNames: Array.isArray(concept.prerequisiteNames)
                  ? concept.prerequisiteNames
                      .filter((value): value is string => typeof value === "string")
                      .map((value) => value.trim().slice(0, 180))
                  : [],
              }))
            : [],
        })),
      };
    });

    for (const topic of taxonomy.topics) {
      const topicKey = normalizeName(topic.name);
      if (!topicKey) continue;
      const [existingTopic] = await db
        .select({ id: topicsTable.id })
        .from(topicsTable)
        .where(
          and(
            eq(topicsTable.courseId, courseId),
            eq(topicsTable.normalizedName, topicKey),
          ),
        )
        .limit(1);
      let topicId = existingTopic?.id;
      if (!topicId) {
        const [insertedTopic] = await db
          .insert(topicsTable)
          .values({
            courseId,
            name: topic.name || "Uncategorized",
            normalizedName: topicKey,
            description: topic.description || null,
          })
          .onConflictDoNothing()
          .returning({ id: topicsTable.id });
        topicId = insertedTopic?.id;
      }
      if (!topicId) {
        const [racedTopic] = await db
          .select({ id: topicsTable.id })
          .from(topicsTable)
          .where(
            and(
              eq(topicsTable.courseId, courseId),
              eq(topicsTable.normalizedName, topicKey),
            ),
          )
          .limit(1);
        topicId = racedTopic?.id;
      }
      if (!topicId) continue;

      for (const concept of topic.concepts) {
        const conceptKey = normalizeName(concept.name);
        if (!conceptKey) continue;
        const [existingConcept] = await db
          .select({ id: conceptsTable.id })
          .from(conceptsTable)
          .where(
            and(
              eq(conceptsTable.courseId, courseId),
              eq(conceptsTable.normalizedName, conceptKey),
            ),
          )
          .limit(1);
        let conceptId = existingConcept?.id;
        if (!conceptId) {
          const [insertedConcept] = await db
            .insert(conceptsTable)
            .values({
              courseId,
              topicId,
              name: concept.name,
              normalizedName: conceptKey,
              description: concept.description || null,
            })
            .onConflictDoNothing()
            .returning({ id: conceptsTable.id });
          conceptId = insertedConcept?.id;
        }
        if (!conceptId) {
          const [racedConcept] = await db
            .select({ id: conceptsTable.id })
            .from(conceptsTable)
            .where(
              and(
                eq(conceptsTable.courseId, courseId),
                eq(conceptsTable.normalizedName, conceptKey),
              ),
            )
            .limit(1);
          conceptId = racedConcept?.id;
        }
        if (!conceptId) continue;

        const unitIds = concept.unitIndexes
          .map((unitIndex) => batch[unitIndex]?.id)
          .filter((id): id is string => Boolean(id));
        if (unitIds.length) {
          await db
            .insert(unitConceptsTable)
            .values(unitIds.map((unitId) => ({ unitId, conceptId: conceptId! })))
            .onConflictDoNothing();
        }
        for (const prerequisite of concept.prerequisiteNames) {
          const prerequisiteKey = normalizeName(prerequisite);
          if (prerequisiteKey && prerequisiteKey !== conceptKey) {
            pendingEdges.push({
              prerequisite: prerequisiteKey,
              dependent: conceptKey,
            });
          }
        }
      }
    }
  }

  if (pendingEdges.length) {
    const courseConcepts = await db
      .select({ id: conceptsTable.id, key: conceptsTable.normalizedName })
      .from(conceptsTable)
      .where(eq(conceptsTable.courseId, courseId));
    const ids = new Map(courseConcepts.map((concept) => [concept.key, concept.id]));
    const edges = pendingEdges
      .map((edge) => ({
        courseId,
        prerequisiteConceptId: ids.get(edge.prerequisite),
        dependentConceptId: ids.get(edge.dependent),
      }))
      .filter(
        (
          edge,
        ): edge is {
          courseId: string;
          prerequisiteConceptId: string;
          dependentConceptId: string;
        } =>
          Boolean(
            edge.prerequisiteConceptId &&
              edge.dependentConceptId &&
              edge.prerequisiteConceptId !== edge.dependentConceptId,
          ),
      );
    if (edges.length) {
      await db.insert(conceptEdgesTable).values(edges).onConflictDoNothing();
    }
  }
}

async function processSource(sourceId: string): Promise<void> {
  const [source] = await db
    .select()
    .from(sourcesTable)
    .where(eq(sourcesTable.id, sourceId))
    .limit(1);
  if (!source) return;
  let step = "Preparing source";
  const workDir = await mkdtemp(join(tmpdir(), "studygraph-"));
  try {
    openai();
    await setProgress(sourceId, "processing", 3, step, null, 0);
    const inputPath = await downloadSource(source, workDir);
    step = source.sourceType === "video" ? "Extracting video audio and frames" : "Extracting document pages";
    await setProgress(sourceId, "processing", 15, step);
    const drafts =
      source.sourceType === "video"
        ? await processVideo(source, inputPath, workDir)
        : await processDocument(source, inputPath, workDir);
    if (!drafts.length) {
      throw new Error("No source-derived text, captions, or transcript segments were extracted.");
    }

    step = "Saving source-linked units";
    await setProgress(sourceId, "processing", 60, step);
    await db.delete(unitsTable).where(eq(unitsTable.sourceId, sourceId));
    const inserted = await db
      .insert(unitsTable)
      .values(
        drafts.map((draft) => ({
          sourceId,
          text: draft.text,
          figureCaption: draft.figureCaption,
          locator: draft.locator,
          language: draft.language,
        })),
      )
      .returning({
        id: unitsTable.id,
        text: unitsTable.text,
        figureCaption: unitsTable.figureCaption,
      });
    if (!inserted.length) throw new Error("No source-linked units could be saved.");

    step = "Embedding source units";
    await setProgress(sourceId, "processing", 64, step, null, inserted.length);
    await embedUnits(inserted);

    step = "Building topics, concepts, and prerequisites";
    await setProgress(sourceId, "processing", 76, step, null, inserted.length);
    await buildTaxonomy(source.courseId, inserted);

    await setProgress(
      sourceId,
      "ready",
      100,
      "Source indexed and ready",
      null,
      inserted.length,
    );
  } catch (error) {
    const message = sourceError(error);
    logger.error({ sourceId, step, error: message }, "StudyGraph ingestion failed");
    await setProgress(
      sourceId,
      "failed",
      source.progress,
      `Stopped during ${step}`,
      message,
    ).catch((progressError) =>
      logger.error(
        { sourceId, error: sourceError(progressError) },
        "Could not persist ingestion failure",
      ),
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

let running = false;
const waiting = new Set<string>();

export function queueIngestion(sourceId: string): void {
  waiting.add(sourceId);
  void drainQueue();
}

async function drainQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (waiting.size) {
      const sourceId = waiting.values().next().value as string;
      waiting.delete(sourceId);
      await processSource(sourceId);
    }
  } finally {
    running = false;
    if (waiting.size) void drainQueue();
  }
}

export async function resumeIngestionJobs(): Promise<void> {
  const interrupted = await db
    .select({ id: ingestionJobsTable.id })
    .from(ingestionJobsTable)
    .where(inArray(ingestionJobsTable.status, ["queued", "processing"]));
  for (const job of interrupted) {
    await db
      .update(ingestionJobsTable)
      .set({ status: "queued", currentStep: "Resuming after server restart" })
      .where(eq(ingestionJobsTable.id, job.id));
    await db
      .update(sourcesTable)
      .set({ status: "queued", currentStep: "Resuming after server restart" })
      .where(eq(sourcesTable.id, job.id));
    queueIngestion(job.id);
  }
}
