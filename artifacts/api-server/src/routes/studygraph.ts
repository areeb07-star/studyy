import { randomUUID } from "node:crypto";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  AddYoutubeSourceBody,
  AddYoutubeSourceResponse,
  CreateCourseBody,
  CreateCourseResponse,
  GetCourseSummaryResponse,
  GetIngestionJobResponse,
  GetSourceResponse,
  ListCoursesResponse,
  ListSourcesQueryParams,
  ListSourcesResponse,
  RegisterUploadedSourceBody,
  RegisterUploadedSourceResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  coursesTable,
  ingestionJobsTable,
  sourcesTable,
  topicsTable,
  unitsTable,
} from "@workspace/db/schema";
import { queueIngestion } from "../lib/ingestion/worker";
import { ObjectPermission } from "../lib/objectAcl";
import { ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const storage = new ObjectStorageService();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
  ".mkv",
  ".avi",
  ".mpeg",
  ".mpg",
  ".3gp",
  ".wmv",
  ".flv",
  ".m2ts",
]);

function userId(res: Response): string {
  return res.locals.userId as string;
}

function validId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function courseDto(
  course: typeof coursesTable.$inferSelect,
  counts: {
    sourceCount: number;
    unitCount: number;
    readySourceCount: number;
    processingSourceCount: number;
    failedSourceCount: number;
  },
) {
  return CreateCourseResponse.parse({
    id: course.id,
    name: course.name,
    description: course.description,
    createdAt: course.createdAt.toISOString(),
    ...counts,
  });
}

function sourceDto(source: typeof sourcesTable.$inferSelect) {
  const response = {
    id: source.id,
    courseId: source.courseId,
    title: source.title,
    originalFilename: source.originalFilename,
    sourceType: source.sourceType,
    sourceUrl: source.sourceUrl,
    language: source.language,
    status: source.status,
    progress: source.progress,
    currentStep: source.currentStep,
    error: source.error,
    unitsCreated: source.unitsCreated,
    createdAt: source.createdAt.toISOString(),
  };
  return response;
}

async function ownedCourse(courseId: string, ownerId: string) {
  const [course] = await db
    .select()
    .from(coursesTable)
    .where(and(eq(coursesTable.id, courseId), eq(coursesTable.ownerId, ownerId)))
    .limit(1);
  return course;
}

async function courseCounts(courseId: string) {
  const [totals] = await db
    .select({
      sourceCount: sql<number>`count(distinct ${sourcesTable.id})::int`,
      unitCount: sql<number>`count(${unitsTable.id})::int`,
      readySourceCount: sql<number>`count(distinct ${sourcesTable.id}) filter (where ${sourcesTable.status} = 'ready')::int`,
      processingSourceCount: sql<number>`count(distinct ${sourcesTable.id}) filter (where ${sourcesTable.status} in ('queued', 'processing'))::int`,
      failedSourceCount: sql<number>`count(distinct ${sourcesTable.id}) filter (where ${sourcesTable.status} = 'failed')::int`,
    })
    .from(sourcesTable)
    .leftJoin(unitsTable, eq(unitsTable.sourceId, sourcesTable.id))
    .where(eq(sourcesTable.courseId, courseId));
  return {
    sourceCount: Number(totals?.sourceCount ?? 0),
    unitCount: Number(totals?.unitCount ?? 0),
    readySourceCount: Number(totals?.readySourceCount ?? 0),
    processingSourceCount: Number(totals?.processingSourceCount ?? 0),
    failedSourceCount: Number(totals?.failedSourceCount ?? 0),
  };
}

function inferSourceType(
  filename: string,
  declaredType: "pdf" | "pptx" | "video",
  mimeType: string,
): "pdf" | "pptx" | "video" | null {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (
    declaredType === "pdf" &&
    (extension === ".pdf" || mimeType === "application/pdf")
  ) {
    return "pdf";
  }
  if (
    declaredType === "pptx" &&
    (extension === ".pptx" ||
      mimeType ===
        "application/vnd.openxmlformats-officedocument.presentationml.presentation")
  ) {
    return "pptx";
  }
  if (declaredType === "video" && VIDEO_EXTENSIONS.has(extension)) return "video";
  return null;
}

function youtubeVideoId(value: string): string | null {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") return parsed.pathname.split("/").filter(Boolean)[0] ?? null;
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
      const watchId = parsed.searchParams.get("v");
      if (watchId) return watchId;
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(segments[0] ?? "")) {
        return segments[1] ?? null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function createSourceAndJob(input: {
  courseId: string;
  ownerId: string;
  title: string;
  originalFilename: string | null;
  sourceType: "pdf" | "pptx" | "video";
  storagePath: string | null;
  sourceUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  language: string;
}) {
  const id = randomUUID();
  const [source] = await db
    .insert(sourcesTable)
    .values({
      id,
      ...input,
      status: "queued",
      progress: 0,
      currentStep: "Waiting to start",
      error: null,
    })
    .returning();
  await db.insert(ingestionJobsTable).values({
    id,
    sourceId: id,
    status: "queued",
    progress: 0,
    currentStep: "Waiting to start",
  });
  setImmediate(() => queueIngestion(id));
  return source;
}

router.get("/courses", async (_req: Request, res: Response) => {
  try {
    const courses = await db
      .select()
      .from(coursesTable)
      .where(eq(coursesTable.ownerId, userId(res)))
      .orderBy(desc(coursesTable.createdAt));
    const response = await Promise.all(
      courses.map(async (course) =>
        courseDto(course, await courseCounts(course.id)),
      ),
    );
    res.json(ListCoursesResponse.parse(response));
  } catch (error) {
    logger.error({ error }, "Could not list StudyGraph courses");
    res.status(500).json({ error: "Could not load your courses." });
  }
});

router.post("/courses", async (req: Request, res: Response) => {
  const parsed = CreateCourseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a course name to continue." });
    return;
  }
  try {
    const [course] = await db
      .insert(coursesTable)
      .values({
        ownerId: userId(res),
        name: parsed.data.name.trim(),
        description: parsed.data.description?.trim() || null,
      })
      .returning();
    res.status(201).json(
      courseDto(course, {
        sourceCount: 0,
        unitCount: 0,
        readySourceCount: 0,
        processingSourceCount: 0,
        failedSourceCount: 0,
      }),
    );
  } catch (error) {
    logger.error({ error }, "Could not create StudyGraph course");
    res.status(500).json({ error: "Could not create the course." });
  }
});

router.get("/courses/:courseId/summary", async (req: Request, res: Response) => {
  const courseId = String(req.params.courseId);
  if (!validId(courseId)) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  try {
    const course = await ownedCourse(courseId, userId(res));
    if (!course) {
      res.status(404).json({ error: "Course not found." });
      return;
    }
    const [counts, [topicCount]] = await Promise.all([
      courseCounts(courseId),
      db
        .select({ count: count() })
        .from(topicsTable)
        .where(eq(topicsTable.courseId, courseId)),
    ]);
    res.json(
      GetCourseSummaryResponse.parse({
        courseId,
        ...counts,
        topicCount: topicCount?.count ?? 0,
      }),
    );
  } catch (error) {
    logger.error({ error, courseId }, "Could not load course summary");
    res.status(500).json({ error: "Could not load the course summary." });
  }
});

router.get("/sources", async (req: Request, res: Response) => {
  const parsed = ListSourcesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid source filters." });
    return;
  }
  try {
    const filters = [eq(sourcesTable.ownerId, userId(res))];
    if (parsed.data.courseId) {
      filters.push(eq(sourcesTable.courseId, parsed.data.courseId));
    }
    const sources = await db
      .select()
      .from(sourcesTable)
      .where(and(...filters))
      .orderBy(desc(sourcesTable.createdAt));
    res.json(ListSourcesResponse.parse(sources.map(sourceDto)));
  } catch (error) {
    logger.error({ error }, "Could not list StudyGraph sources");
    res.status(500).json({ error: "Could not load your source library." });
  }
});

router.post("/sources", async (req: Request, res: Response) => {
  const parsed = RegisterUploadedSourceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "The uploaded source details are invalid." });
    return;
  }
  const input = parsed.data;
  const resolvedType = inferSourceType(
    input.originalFilename,
    input.sourceType,
    input.mimeType,
  );
  if (!resolvedType) {
    res.status(400).json({
      error: "Upload a PDF, PPTX, or supported video file.",
    });
    return;
  }
  if (!input.objectPath.startsWith("/objects/uploads/")) {
    res.status(400).json({ error: "The upload path is not valid." });
    return;
  }
  try {
    if (!(await ownedCourse(input.courseId, userId(res)))) {
      res.status(404).json({ error: "Course not found." });
      return;
    }
    const objectFile = await storage.getObjectEntityFile(input.objectPath);
    const [metadata] = await objectFile.getMetadata();
    const sizeBytes = Number(metadata.size ?? 0);
    if (sizeBytes < 1) {
      res.status(400).json({ error: "The uploaded file is empty." });
      return;
    }
    const sourcePath = await storage.trySetObjectEntityAclPolicy(
      input.objectPath,
      { owner: userId(res), visibility: "private" },
    );
    const source = await createSourceAndJob({
      courseId: input.courseId,
      ownerId: userId(res),
      title: input.title.trim(),
      originalFilename: input.originalFilename,
      sourceType: resolvedType,
      storagePath: sourcePath,
      sourceUrl: null,
      mimeType: String(metadata.contentType ?? input.mimeType),
      sizeBytes,
      language: input.language?.trim() || "auto",
    });
    res.status(202).json(
      RegisterUploadedSourceResponse.parse(sourceDto(source)),
    );
  } catch (error) {
    logger.error({ error }, "Could not register uploaded source");
    res.status(500).json({
      error: error instanceof Error ? error.message : "Could not register the file.",
    });
  }
});

router.post("/sources/youtube", async (req: Request, res: Response) => {
  const parsed = AddYoutubeSourceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid YouTube video URL." });
    return;
  }
  const input = parsed.data;
  const videoId = youtubeVideoId(input.url);
  if (!videoId) {
    res.status(400).json({ error: "Use a youtube.com or youtu.be video link." });
    return;
  }
  try {
    if (!(await ownedCourse(input.courseId, userId(res)))) {
      res.status(404).json({ error: "Course not found." });
      return;
    }
    const source = await createSourceAndJob({
      courseId: input.courseId,
      ownerId: userId(res),
      title: input.title?.trim() || `YouTube video ${videoId}`,
      originalFilename: null,
      sourceType: "video",
      storagePath: null,
      sourceUrl: input.url,
      mimeType: null,
      sizeBytes: null,
      language: input.language?.trim() || "auto",
    });
    res.status(202).json(AddYoutubeSourceResponse.parse(sourceDto(source)));
  } catch (error) {
    logger.error({ error }, "Could not add YouTube source");
    res.status(500).json({ error: "Could not add that YouTube video." });
  }
});

router.get("/sources/:sourceId", async (req: Request, res: Response) => {
  const sourceId = String(req.params.sourceId);
  if (!validId(sourceId)) {
    res.status(404).json({ error: "Source not found." });
    return;
  }
  try {
    const [source] = await db
      .select()
      .from(sourcesTable)
      .where(
        and(eq(sourcesTable.id, sourceId), eq(sourcesTable.ownerId, userId(res))),
      )
      .limit(1);
    if (!source) {
      res.status(404).json({ error: "Source not found." });
      return;
    }
    res.json(GetSourceResponse.parse(sourceDto(source)));
  } catch (error) {
    logger.error({ error, sourceId }, "Could not load source");
    res.status(500).json({ error: "Could not load this source." });
  }
});

router.delete("/sources/:sourceId", async (req: Request, res: Response) => {
  const sourceId = String(req.params.sourceId);
  if (!validId(sourceId)) {
    res.status(404).json({ error: "Source not found." });
    return;
  }
  try {
    const [source] = await db
      .select()
      .from(sourcesTable)
      .where(
        and(eq(sourcesTable.id, sourceId), eq(sourcesTable.ownerId, userId(res))),
      )
      .limit(1);
    if (!source) {
      res.status(404).json({ error: "Source not found." });
      return;
    }
    const units = await db
      .select({ locator: unitsTable.locator })
      .from(unitsTable)
      .where(eq(unitsTable.sourceId, sourceId));
    const paths = units
      .map((unit) => unit.locator.imagePath)
      .filter((path): path is string => Boolean(path));
    if (source.storagePath) paths.push(source.storagePath);
    for (const path of new Set(paths)) {
      await storage.deleteObjectEntity(path).catch((error) =>
        logger.warn(
          { sourceId, error },
          "Could not remove one private StudyGraph file",
        ),
      );
    }
    await db.delete(sourcesTable).where(eq(sourcesTable.id, sourceId));
    res.status(204).end();
  } catch (error) {
    logger.error({ error, sourceId }, "Could not delete source");
    res.status(500).json({ error: "Could not delete this source." });
  }
});

router.get("/ingestion-jobs/:jobId", async (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  if (!validId(jobId)) {
    res.status(404).json({ error: "Ingestion job not found." });
    return;
  }
  try {
    const [job] = await db
      .select({
        id: ingestionJobsTable.id,
        sourceId: ingestionJobsTable.sourceId,
        status: ingestionJobsTable.status,
        progress: ingestionJobsTable.progress,
        currentStep: ingestionJobsTable.currentStep,
        unitsCreated: ingestionJobsTable.unitsCreated,
        error: ingestionJobsTable.error,
        updatedAt: ingestionJobsTable.updatedAt,
      })
      .from(ingestionJobsTable)
      .innerJoin(
        sourcesTable,
        eq(sourcesTable.id, ingestionJobsTable.sourceId),
      )
      .where(
        and(
          eq(ingestionJobsTable.id, jobId),
          eq(sourcesTable.ownerId, userId(res)),
        ),
      )
      .limit(1);
    if (!job) {
      res.status(404).json({ error: "Ingestion job not found." });
      return;
    }
    res.json(
      GetIngestionJobResponse.parse({
        ...job,
        updatedAt: job.updatedAt.toISOString(),
      }),
    );
  } catch (error) {
    logger.error({ error, jobId }, "Could not load ingestion progress");
    res.status(500).json({ error: "Could not load ingestion progress." });
  }
});

export default router;
