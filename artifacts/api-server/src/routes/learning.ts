import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { UpdateConceptProgressBody } from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  assessmentAttemptsTable,
  assessmentsTable,
  conceptProgressTable,
  conceptsTable,
  topicsTable,
} from "@workspace/db/schema";
import {
  findOwnedCourse,
  studygraphPathParam,
  studygraphOwnerId,
  validStudygraphId,
} from "../lib/studygraph/ownership";

const router: IRouter = Router();

router.get(
  "/courses/:courseId/progress",
  async (req: Request, res: Response) => {
    const ownerId = studygraphOwnerId(res);
    const courseId = studygraphPathParam(req, "courseId");
    if (!validStudygraphId(courseId)) {
      res.status(400).json({ error: "Invalid course id." });
      return;
    }
    if (!(await findOwnedCourse(courseId, ownerId))) {
      res.status(404).json({ error: "Course not found." });
      return;
    }

    const concepts = await db
      .select({
        conceptId: conceptsTable.id,
        name: conceptsTable.name,
        description: conceptsTable.description,
        topicId: topicsTable.id,
        topicName: topicsTable.name,
        confidence: sql<number>`coalesce(${conceptProgressTable.confidence}, 0)`,
        mastery: sql<"new" | "learning" | "mastered">`coalesce(${conceptProgressTable.mastery}, 'new')`,
        lastReviewedAt: conceptProgressTable.lastReviewedAt,
        nextReviewAt: conceptProgressTable.nextReviewAt,
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
      .orderBy(asc(topicsTable.name), asc(conceptsTable.name))
      .limit(1_000);

    const [assessmentTotals] = await db
      .select({ total: count() })
      .from(assessmentsTable)
      .where(
        and(
          eq(assessmentsTable.courseId, courseId),
          eq(assessmentsTable.ownerId, ownerId),
        ),
      );
    const [attemptTotals] = await db
      .select({
        total: sql<number>`count(*)::int`,
        average: sql<number | null>`avg(${assessmentAttemptsTable.score}::float / nullif(${assessmentAttemptsTable.total}, 0) * 100)`,
      })
      .from(assessmentAttemptsTable)
      .innerJoin(
        assessmentsTable,
        eq(assessmentAttemptsTable.assessmentId, assessmentsTable.id),
      )
      .where(
        and(
          eq(assessmentAttemptsTable.ownerId, ownerId),
          eq(assessmentsTable.courseId, courseId),
        ),
      );
    const recentAttempts = await db
      .select({
        id: assessmentAttemptsTable.id,
        assessmentTitle: assessmentsTable.title,
        score: assessmentAttemptsTable.score,
        total: assessmentAttemptsTable.total,
        createdAt: assessmentAttemptsTable.createdAt,
      })
      .from(assessmentAttemptsTable)
      .innerJoin(
        assessmentsTable,
        eq(assessmentAttemptsTable.assessmentId, assessmentsTable.id),
      )
      .where(
        and(
          eq(assessmentAttemptsTable.ownerId, ownerId),
          eq(assessmentsTable.courseId, courseId),
        ),
      )
      .orderBy(desc(assessmentAttemptsTable.createdAt))
      .limit(12);

    const now = Date.now();
    const masteredConcepts = concepts.filter(
      (concept) => concept.mastery === "mastered",
    ).length;
    const learningConcepts = concepts.filter(
      (concept) => concept.mastery === "learning",
    ).length;
    const newConcepts = concepts.length - masteredConcepts - learningConcepts;
    const dueConcepts = concepts.filter(
      (concept) =>
        concept.mastery !== "mastered" &&
        (!concept.nextReviewAt || concept.nextReviewAt.getTime() <= now),
    ).length;

    res.json({
      courseId,
      totalConcepts: concepts.length,
      masteredConcepts,
      learningConcepts,
      newConcepts,
      dueConcepts,
      assessmentCount: Number(assessmentTotals?.total ?? 0),
      attemptCount: Number(attemptTotals?.total ?? 0),
      averageScore:
        attemptTotals?.average == null
          ? null
          : Math.round(Number(attemptTotals.average)),
      concepts,
      recentAttempts,
    });
  },
);

router.patch(
  "/courses/:courseId/concepts/:conceptId/progress",
  async (req: Request, res: Response) => {
    const ownerId = studygraphOwnerId(res);
    const courseId = studygraphPathParam(req, "courseId");
    const conceptId = studygraphPathParam(req, "conceptId");
    if (!validStudygraphId(courseId) || !validStudygraphId(conceptId)) {
      res.status(400).json({ error: "Invalid course or concept id." });
      return;
    }
    const input = UpdateConceptProgressBody.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Choose a confidence level from 0 to 5." });
      return;
    }
    if (!(await findOwnedCourse(courseId, ownerId))) {
      res.status(404).json({ error: "Course not found." });
      return;
    }
    const [concept] = await db
      .select({
        id: conceptsTable.id,
        name: conceptsTable.name,
        description: conceptsTable.description,
        topicId: topicsTable.id,
        topicName: topicsTable.name,
      })
      .from(conceptsTable)
      .innerJoin(topicsTable, eq(conceptsTable.topicId, topicsTable.id))
      .where(
        and(
          eq(conceptsTable.id, conceptId),
          eq(conceptsTable.courseId, courseId),
        ),
      )
      .limit(1);
    if (!concept) {
      res.status(404).json({ error: "Concept not found in this course." });
      return;
    }
    const confidence = input.data.confidence;
    const mastery =
      confidence >= 4 ? "mastered" : confidence > 0 ? "learning" : "new";
    const now = new Date();
    const intervalDays = [1, 1, 2, 4, 7, 14][confidence];
    const nextReviewAt = new Date(now.getTime() + intervalDays * 86_400_000);
    await db
      .insert(conceptProgressTable)
      .values({
        ownerId,
        conceptId,
        confidence,
        mastery,
        lastReviewedAt: now,
        nextReviewAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [conceptProgressTable.ownerId, conceptProgressTable.conceptId],
        set: {
          confidence,
          mastery,
          lastReviewedAt: now,
          nextReviewAt,
          updatedAt: now,
        },
      });
    res.json({
      conceptId,
      name: concept.name,
      description: concept.description,
      topicId: concept.topicId,
      topicName: concept.topicName,
      confidence,
      mastery,
      lastReviewedAt: now,
      nextReviewAt,
    });
  },
);

export default router;
