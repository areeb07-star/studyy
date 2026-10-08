import { and, asc, desc, eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  assessmentAttemptsTable,
  assessmentsTable,
  conceptProgressTable,
  conceptsTable,
  coursesTable,
  sourcesTable,
  topicsTable,
  unitConceptsTable,
  unitsTable,
} from "@workspace/db/schema";
import {
  studygraphOwnerId,
  studygraphPathParam,
  validStudygraphId,
} from "../lib/studygraph/ownership";

const router: IRouter = Router();

function downloadName(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "studygraph-course"
  );
}

function locatorLabel(locator: {
  type: string;
  page?: number;
  slide?: number;
  start_sec?: number;
  end_sec?: number;
}): string {
  if (locator.type === "page" && locator.page) return `Page ${locator.page}`;
  if (locator.type === "slide" && locator.slide) return `Slide ${locator.slide}`;
  if (locator.type === "video") {
    const start = Math.max(0, Math.floor(locator.start_sec ?? 0));
    const end = Math.max(start, Math.floor(locator.end_sec ?? start));
    const stamp = (seconds: number) =>
      `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    return `${stamp(start)}–${stamp(end)}`;
  }
  return "Source location unavailable";
}

function escapeCsv(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

router.get(
  "/courses/:courseId/export/markdown",
  async (req: Request, res: Response) => {
    await sendExport(req, res, "markdown");
  },
);

router.get(
  "/courses/:courseId/export/csv",
  async (req: Request, res: Response) => {
    await sendExport(req, res, "csv");
  },
);

async function sendExport(
  req: Request,
  res: Response,
  format: "markdown" | "csv",
) {
  const ownerId = studygraphOwnerId(res);
  const courseId = studygraphPathParam(req, "courseId");
  if (!validStudygraphId(courseId)) {
    res.status(400).json({ error: "Invalid course id." });
    return;
  }
  const [course] = await db
    .select()
    .from(coursesTable)
    .where(
      and(
        eq(coursesTable.id, courseId),
        eq(coursesTable.ownerId, ownerId),
      ),
    )
    .limit(1);
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }
  const rows = await db
    .select({
      unitId: unitsTable.id,
      text: unitsTable.text,
      figureCaption: unitsTable.figureCaption,
      locator: unitsTable.locator,
      sourceId: sourcesTable.id,
      sourceTitle: sourcesTable.title,
      sourceType: sourcesTable.sourceType,
      topicName: topicsTable.name,
      conceptId: conceptsTable.id,
      conceptName: conceptsTable.name,
      confidence: conceptProgressTable.confidence,
      mastery: conceptProgressTable.mastery,
    })
    .from(unitsTable)
    .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
    .leftJoin(unitConceptsTable, eq(unitConceptsTable.unitId, unitsTable.id))
    .leftJoin(conceptsTable, eq(unitConceptsTable.conceptId, conceptsTable.id))
    .leftJoin(topicsTable, eq(conceptsTable.topicId, topicsTable.id))
    .leftJoin(
      conceptProgressTable,
      and(
        eq(conceptProgressTable.conceptId, conceptsTable.id),
        eq(conceptProgressTable.ownerId, ownerId),
      ),
    )
    .where(
      and(
        eq(sourcesTable.courseId, courseId),
        eq(sourcesTable.ownerId, ownerId),
        eq(sourcesTable.status, "ready"),
      ),
    )
    .orderBy(asc(sourcesTable.title), asc(unitsTable.createdAt));

  const conceptGroups = await db
    .select({
      topicName: topicsTable.name,
      conceptName: conceptsTable.name,
      description: conceptsTable.description,
      confidence: conceptProgressTable.confidence,
      mastery: conceptProgressTable.mastery,
    })
    .from(conceptsTable)
    .innerJoin(topicsTable, eq(conceptsTable.topicId, topicsTable.id))
    .leftJoin(
      conceptProgressTable,
      and(
        eq(conceptProgressTable.conceptId, conceptsTable.id),
        eq(conceptProgressTable.ownerId, ownerId),
      ),
    )
    .where(eq(conceptsTable.courseId, courseId))
    .orderBy(asc(topicsTable.name), asc(conceptsTable.name));

  const assessments = await db
    .select({
      title: assessmentsTable.title,
      difficulty: assessmentsTable.difficulty,
      score: assessmentAttemptsTable.score,
      total: assessmentAttemptsTable.total,
      createdAt: assessmentAttemptsTable.createdAt,
    })
    .from(assessmentsTable)
    .leftJoin(
      assessmentAttemptsTable,
      and(
        eq(assessmentAttemptsTable.assessmentId, assessmentsTable.id),
        eq(assessmentAttemptsTable.ownerId, ownerId),
      ),
    )
    .where(
      and(
        eq(assessmentsTable.courseId, courseId),
        eq(assessmentsTable.ownerId, ownerId),
      ),
    )
    .orderBy(desc(assessmentAttemptsTable.createdAt));

  const filename = downloadName(course.name);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}.${format === "markdown" ? "md" : "csv"}"`,
  );
  if (format === "csv") {
    const header = [
      "course",
      "source",
      "source_type",
      "locator",
      "topic",
      "concept",
      "mastery",
      "confidence",
      "unit_text",
      "figure_caption",
    ];
    const records = rows.map((row) => [
      course.name,
      row.sourceTitle,
      row.sourceType,
      locatorLabel(row.locator),
      row.topicName,
      row.conceptName,
      row.mastery ?? "new",
      row.confidence ?? 0,
      row.text,
      row.figureCaption,
    ]);
    res.type("text/csv").send(
      [header, ...records].map((record) => record.map(escapeCsv).join(",")).join("\r\n"),
    );
    return;
  }

  const lines = [
    `# ${course.name} — StudyGraph study guide`,
    "",
    course.description || "A source-linked collection of study material.",
    "",
    `Exported ${new Date().toISOString()}.`,
    "",
    "## Concept map and progress",
    "",
  ];
  if (!conceptGroups.length) {
    lines.push("No concepts have been extracted yet.", "");
  } else {
    let currentTopic = "";
    for (const concept of conceptGroups) {
      if (concept.topicName !== currentTopic) {
        currentTopic = concept.topicName;
        lines.push(`### ${currentTopic}`, "");
      }
      const state =
        concept.mastery === "mastered"
          ? "Mastered"
          : concept.mastery === "learning"
            ? "Learning"
            : "Not reviewed";
      lines.push(
        `- **${concept.conceptName}** — ${state} (${concept.confidence ?? 0}/5)${concept.description ? `: ${concept.description}` : ""}`,
      );
    }
    lines.push("");
  }
  lines.push("## Source-linked study units", "");
  let lastUnitId = "";
  for (const row of rows) {
    if (row.unitId === lastUnitId) continue;
    lastUnitId = row.unitId;
    lines.push(
      `### ${row.sourceTitle} — ${locatorLabel(row.locator)}`,
      "",
      `**Source type:** ${row.sourceType}`,
      row.topicName ? `**Topic:** ${row.topicName}` : "",
      row.conceptName ? `**Concept:** ${row.conceptName}` : "",
      "",
      row.text,
      row.figureCaption ? `\n> ${row.figureCaption}` : "",
      "",
    );
  }
  lines.push("## Assessment history", "");
  const completed = assessments.filter(
    (item): item is typeof item & { score: number; total: number; createdAt: Date } =>
      item.score !== null && item.total !== null && item.createdAt !== null,
  );
  if (!completed.length) {
    lines.push("No assessment attempts have been recorded.", "");
  } else {
    for (const attempt of completed) {
      lines.push(
        `- **${attempt.title}** (${attempt.difficulty}) — ${attempt.score}/${attempt.total}, ${new Date(attempt.createdAt).toLocaleDateString("en", { dateStyle: "medium", timeZone: "UTC" })}`,
      );
    }
    lines.push("");
  }
  res.type("text/markdown").send(lines.filter((line) => line !== "").join("\n"));
}

export default router;
