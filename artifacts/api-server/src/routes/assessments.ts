import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateCourseAssessmentBody,
  SubmitAssessmentAttemptBody,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  assessmentAttemptsTable,
  assessmentsTable,
  conceptProgressTable,
  conceptsTable,
  sourcesTable,
  topicsTable,
  unitConceptsTable,
  unitsTable,
  type AssessmentQuestionFeedback,
  type StoredAssessmentAnswer,
  type StoredAssessmentQuestion,
} from "@workspace/db/schema";
import { logger } from "../lib/logger";
import { modelConfig, openai, withRetry } from "../lib/ingestion/ai";
import {
  findOwnedCourse,
  studygraphPathParam,
  studygraphOwnerId,
  validStudygraphId,
} from "../lib/studygraph/ownership";
import { citationFor, type GroundedUnit } from "../lib/studygraph/retrieval";

const router: IRouter = Router();

type AssessmentQuestionView = Pick<
  StoredAssessmentQuestion,
  "id" | "prompt" | "options" | "citations"
>;

function questionView(question: StoredAssessmentQuestion): AssessmentQuestionView {
  return {
    id: question.id,
    prompt: question.prompt,
    options: question.options,
    citations: question.citations,
  };
}

function attemptView(attempt: typeof assessmentAttemptsTable.$inferSelect) {
  return {
    id: attempt.id,
    assessmentId: attempt.assessmentId,
    score: attempt.score,
    total: attempt.total,
    percentage: Math.round((attempt.score / Math.max(attempt.total, 1)) * 100),
    feedback: attempt.feedback,
    createdAt: attempt.createdAt,
  };
}

function parseGeneratedAssessment(raw: string): {
  title: string;
  questions: Array<{
    prompt: string;
    options: string[];
    correctOption: number;
    explanation: string;
    unitIds: string[];
  }>;
} | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.title !== "string" || !Array.isArray(record.questions)) {
      return null;
    }
    const questions = record.questions.map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      return {
        prompt: typeof item.prompt === "string" ? item.prompt.trim() : "",
        options: Array.isArray(item.options)
          ? item.options.filter((option): option is string => typeof option === "string")
          : [],
        correctOption:
          typeof item.correctOption === "number" ? item.correctOption : -1,
        explanation:
          typeof item.explanation === "string" ? item.explanation.trim() : "",
        unitIds: Array.isArray(item.unitIds)
          ? item.unitIds.filter((id): id is string => typeof id === "string")
          : [],
      };
    });
    if (questions.some((item) => item === null)) return null;
    return {
      title: record.title.trim(),
      questions: questions as NonNullable<(typeof questions)[number]>[],
    };
  } catch {
    return null;
  }
}

function assessmentDto(
  assessment: typeof assessmentsTable.$inferSelect,
  attempts: (typeof assessmentAttemptsTable.$inferSelect)[],
) {
  const scores = attempts.map((attempt) =>
    Math.round((attempt.score / Math.max(attempt.total, 1)) * 100),
  );
  return {
    id: assessment.id,
    courseId: assessment.courseId,
    title: assessment.title,
    difficulty: assessment.difficulty,
    questionCount: assessment.questions.length,
    attemptCount: attempts.length,
    bestScore: scores.length ? Math.max(...scores) : null,
    createdAt: assessment.createdAt,
  };
}

function assessmentDetailDto(
  assessment: typeof assessmentsTable.$inferSelect,
  attempts: (typeof assessmentAttemptsTable.$inferSelect)[],
) {
  return {
    ...assessmentDto(assessment, attempts),
    questions: assessment.questions.map(questionView),
  };
}

router.get(
  "/courses/:courseId/assessments",
  async (req: Request, res: Response) => {
    const ownerId = studygraphOwnerId(res);
    const courseId = studygraphPathParam(req, "courseId");
    if (!validStudygraphId(courseId)) {
      res.status(400).json({ error: "Invalid course id." });
      return;
    }
    const course = await findOwnedCourse(courseId, ownerId);
    if (!course) {
      res.status(404).json({ error: "Course not found." });
      return;
    }
    const assessments = await db
      .select()
      .from(assessmentsTable)
      .where(
        and(
          eq(assessmentsTable.courseId, courseId),
          eq(assessmentsTable.ownerId, ownerId),
        ),
      )
      .orderBy(desc(assessmentsTable.createdAt))
      .limit(60);
    const attempts =
      assessments.length > 0
        ? await db
            .select()
            .from(assessmentAttemptsTable)
            .where(
              and(
                eq(assessmentAttemptsTable.ownerId, ownerId),
                inArray(
                  assessmentAttemptsTable.assessmentId,
                  assessments.map((item) => item.id),
                ),
              ),
            )
        : [];
    const attemptsByAssessment = new Map<
      string,
      (typeof assessmentAttemptsTable.$inferSelect)[]
    >();
    for (const attempt of attempts) {
      const group = attemptsByAssessment.get(attempt.assessmentId) ?? [];
      group.push(attempt);
      attemptsByAssessment.set(attempt.assessmentId, group);
    }
    res.json(
      assessments.map((assessment) =>
        assessmentDto(assessment, attemptsByAssessment.get(assessment.id) ?? []),
      ),
    );
  },
);

router.post(
  "/courses/:courseId/assessments",
  async (req: Request, res: Response) => {
    const ownerId = studygraphOwnerId(res);
    const courseId = studygraphPathParam(req, "courseId");
    if (!validStudygraphId(courseId)) {
      res.status(400).json({ error: "Invalid course id." });
      return;
    }
    const input = CreateCourseAssessmentBody.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Assessment settings are invalid." });
      return;
    }
    const course = await findOwnedCourse(courseId, ownerId);
    if (!course) {
      res.status(404).json({ error: "Course not found." });
      return;
    }
    const topicId = input.data.topicId || undefined;
    if (topicId) {
      if (!validStudygraphId(topicId)) {
        res.status(400).json({ error: "Invalid topic id." });
        return;
      }
      const [topic] = await db
        .select({ id: topicsTable.id })
        .from(topicsTable)
        .where(
          and(
            eq(topicsTable.id, topicId),
            eq(topicsTable.courseId, courseId),
          ),
        )
        .limit(1);
      if (!topic) {
        res.status(404).json({ error: "Topic not found in this course." });
        return;
      }
    }

    const topicUnitRows = topicId
      ? await db
          .select({ unitId: unitConceptsTable.unitId })
          .from(unitConceptsTable)
          .innerJoin(
            conceptsTable,
            eq(unitConceptsTable.conceptId, conceptsTable.id),
          )
          .where(
            and(
              eq(conceptsTable.courseId, courseId),
              eq(conceptsTable.topicId, topicId),
            ),
          )
      : [];
    const topicUnitIds = [...new Set(topicUnitRows.map((row) => row.unitId))];
    const unitFilters = [
      eq(sourcesTable.courseId, courseId),
      eq(sourcesTable.ownerId, ownerId),
      eq(sourcesTable.status, "ready"),
      ...(topicId
        ? [topicUnitIds.length ? inArray(unitsTable.id, topicUnitIds) : eq(unitsTable.id, "00000000-0000-0000-0000-000000000000")]
        : []),
    ];
    const unitRows = await db
      .select({
        id: unitsTable.id,
        sourceId: unitsTable.sourceId,
        text: unitsTable.text,
        figureCaption: unitsTable.figureCaption,
        locator: unitsTable.locator,
        sourceTitle: sourcesTable.title,
        sourceType: sourcesTable.sourceType,
      })
      .from(unitsTable)
      .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
      .where(and(...unitFilters))
      .orderBy(desc(unitsTable.createdAt))
      .limit(40);
    if (unitRows.length === 0) {
      res.status(409).json({
        error: "Process at least one relevant source before creating an assessment.",
      });
      return;
    }

    const unitIds = unitRows.map((unit) => unit.id);
    const conceptLinks = await db
      .select({
        unitId: unitConceptsTable.unitId,
        conceptId: unitConceptsTable.conceptId,
      })
      .from(unitConceptsTable)
      .where(inArray(unitConceptsTable.unitId, unitIds));
    const conceptsByUnit = new Map<string, string[]>();
    for (const link of conceptLinks) {
      const linked = conceptsByUnit.get(link.unitId) ?? [];
      linked.push(link.conceptId);
      conceptsByUnit.set(link.unitId, linked);
    }

    try {
      const unitContext = unitRows
        .map((unit) =>
          [
            `UNIT_ID: ${unit.id}`,
            `SOURCE: ${unit.sourceTitle}`,
            `LOCATOR: ${JSON.stringify(unit.locator)}`,
            `CONTENT: ${unit.text.slice(0, 2_000)}`,
          ].join("\n"),
        )
        .join("\n\n---\n\n");
      const response = await withRetry(() =>
        openai().chat.completions.create({
          model: modelConfig.assessment,
          max_completion_tokens: Math.min(4_000, input.data.questionCount * 420),
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: [
                "Generate a rigorous but fair multiple-choice practice assessment using only the supplied course units.",
                "Create exactly the requested number of questions. Every question must have exactly four distinct options, one defensible correct answer, and a short explanation supported by its cited units.",
                "Do not use outside facts. Use only exact UNIT_ID values from the supplied material.",
                `Difficulty: ${input.data.difficulty}.`,
                `Return only JSON shaped as {"title":string,"questions":[{"prompt":string,"options":string[],"correctOption":integer,"explanation":string,"unitIds":string[]}]}.`,
                `COURSE MATERIAL:\n${unitContext}`,
              ].join("\n\n"),
            },
            {
              role: "user",
              content: `Create ${input.data.questionCount} questions. ${
                topicId ? "Focus on the selected topic." : "Cover the course broadly."
              }`,
            },
          ],
        }),
      );
      const raw = response.choices[0]?.message?.content;
      const generated = raw ? parseGeneratedAssessment(raw) : null;
      if (!generated) throw new Error("Assessment model returned invalid JSON.");
      const unitById = new Map(unitRows.map((row) => [row.id, row]));
      const questions: StoredAssessmentQuestion[] = generated.questions
        .slice(0, input.data.questionCount)
        .map((item) => {
          const options = item.options.map((option) => option.trim()).filter(Boolean);
          const validUnitIds = [...new Set(item.unitIds)].filter((id) =>
            unitById.has(id),
          );
          if (
            item.prompt.length < 8 ||
            options.length !== 4 ||
            new Set(options).size !== 4 ||
            !Number.isInteger(item.correctOption) ||
            item.correctOption < 0 ||
            item.correctOption > 3 ||
            item.explanation.length < 5 ||
            validUnitIds.length === 0
          ) {
            return null;
          }
          const citations = validUnitIds
            .map((id) => unitById.get(id))
            .filter((unit): unit is (typeof unitRows)[number] => Boolean(unit))
            .map((unit) =>
              citationFor({
                ...unit,
                similarity: 1,
              } as GroundedUnit),
            );
          return {
            id: randomUUID(),
            prompt: item.prompt,
            options,
            correctOption: item.correctOption,
            explanation: item.explanation,
            citations,
            conceptIds: [
              ...new Set(
                validUnitIds.flatMap((id) => conceptsByUnit.get(id) ?? []),
              ),
            ],
          };
        })
        .filter((question): question is StoredAssessmentQuestion => Boolean(question));
      if (questions.length < Math.max(2, Math.ceil(input.data.questionCount * 0.6))) {
        throw new Error("Assessment model did not return enough valid questions.");
      }
      const [assessment] = await db
        .insert(assessmentsTable)
        .values({
          courseId,
          ownerId,
          topicId: topicId ?? null,
          title: generated.title.slice(0, 160) || `${input.data.difficulty} practice`,
          difficulty: input.data.difficulty,
          questions,
        })
        .returning();
      res.status(201).json(assessmentDetailDto(assessment, []));
    } catch (error) {
      logger.error({ error, courseId }, "Assessment generation failed");
      res.status(503).json({
        error: "StudyGraph could not build a source-supported assessment. Try again after checking course material and model settings.",
      });
    }
  },
);

async function findOwnedAssessment(assessmentId: string, ownerId: string) {
  const [assessment] = await db
    .select()
    .from(assessmentsTable)
    .where(
      and(
        eq(assessmentsTable.id, assessmentId),
        eq(assessmentsTable.ownerId, ownerId),
      ),
    )
    .limit(1);
  return assessment;
}

async function attemptsFor(assessmentId: string, ownerId: string) {
  return db
    .select()
    .from(assessmentAttemptsTable)
    .where(
      and(
        eq(assessmentAttemptsTable.assessmentId, assessmentId),
        eq(assessmentAttemptsTable.ownerId, ownerId),
      ),
    )
    .orderBy(desc(assessmentAttemptsTable.createdAt))
    .limit(50);
}

router.get(
  "/assessments/:assessmentId",
  async (req: Request, res: Response) => {
    const ownerId = studygraphOwnerId(res);
    const assessmentId = studygraphPathParam(req, "assessmentId");
    if (!validStudygraphId(assessmentId)) {
      res.status(400).json({ error: "Invalid assessment id." });
      return;
    }
    const assessment = await findOwnedAssessment(assessmentId, ownerId);
    if (!assessment) {
      res.status(404).json({ error: "Assessment not found." });
      return;
    }
    res.json(
      assessmentDetailDto(
        assessment,
        await attemptsFor(assessmentId, ownerId),
      ),
    );
  },
);

router.get(
  "/assessments/:assessmentId/attempts",
  async (req: Request, res: Response) => {
    const ownerId = studygraphOwnerId(res);
    const assessmentId = studygraphPathParam(req, "assessmentId");
    if (!validStudygraphId(assessmentId)) {
      res.status(400).json({ error: "Invalid assessment id." });
      return;
    }
    if (!(await findOwnedAssessment(assessmentId, ownerId))) {
      res.status(404).json({ error: "Assessment not found." });
      return;
    }
    res.json((await attemptsFor(assessmentId, ownerId)).map(attemptView));
  },
);

router.post(
  "/assessments/:assessmentId/attempts",
  async (req: Request, res: Response) => {
    const ownerId = studygraphOwnerId(res);
    const assessmentId = studygraphPathParam(req, "assessmentId");
    if (!validStudygraphId(assessmentId)) {
      res.status(400).json({ error: "Invalid assessment id." });
      return;
    }
    const input = SubmitAssessmentAttemptBody.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Assessment answers are invalid." });
      return;
    }
    const assessment = await findOwnedAssessment(assessmentId, ownerId);
    if (!assessment) {
      res.status(404).json({ error: "Assessment not found." });
      return;
    }
    const answerById = new Map<string, number | null>();
    for (const answer of input.data.answers) {
      if (answerById.has(answer.questionId)) {
        res.status(400).json({ error: "Each question can be answered only once." });
        return;
      }
      answerById.set(answer.questionId, answer.selectedOption);
    }
    const questionIds = new Set(assessment.questions.map((question) => question.id));
    if (
      [...answerById.keys()].some((questionId) => !questionIds.has(questionId)) ||
      assessment.questions.some((question) => !answerById.has(question.id))
    ) {
      res.status(400).json({ error: "Submit one answer for every question." });
      return;
    }
    for (const question of assessment.questions) {
      const selected = answerById.get(question.id);
      if (
        selected !== null &&
        selected !== undefined &&
        (!Number.isInteger(selected) ||
          selected < 0 ||
          selected >= question.options.length)
      ) {
        res.status(400).json({ error: "An answer option is out of range." });
        return;
      }
    }

    const answers: StoredAssessmentAnswer[] = assessment.questions.map((question) => ({
      questionId: question.id,
      selectedOption: answerById.get(question.id) ?? null,
    }));
    const feedback: AssessmentQuestionFeedback[] = assessment.questions.map(
      (question) => {
        const selectedOption = answerById.get(question.id) ?? null;
        return {
          questionId: question.id,
          selectedOption,
          correctOption: question.correctOption,
          isCorrect: selectedOption === question.correctOption,
          explanation: question.explanation,
          citations: question.citations,
        };
      },
    );
    const score = feedback.filter((item) => item.isCorrect).length;
    const now = new Date();
    const deltaByConcept = new Map<string, number>();
    feedback.forEach((item, index) => {
      const question = assessment.questions[index];
      for (const conceptId of question.conceptIds) {
        deltaByConcept.set(
          conceptId,
          (deltaByConcept.get(conceptId) ?? 0) + (item.isCorrect ? 1 : -1),
        );
      }
    });

    const saved = await db.transaction(async (tx) => {
      const [attempt] = await tx
        .insert(assessmentAttemptsTable)
        .values({
          assessmentId,
          ownerId,
          answers,
          feedback,
          score,
          total: assessment.questions.length,
        })
        .returning();
      for (const [conceptId, delta] of deltaByConcept) {
        const [existing] = await tx
          .select({ confidence: conceptProgressTable.confidence })
          .from(conceptProgressTable)
          .where(
            and(
              eq(conceptProgressTable.ownerId, ownerId),
              eq(conceptProgressTable.conceptId, conceptId),
            ),
          )
          .limit(1);
        const confidence = Math.max(
          0,
          Math.min(5, (existing?.confidence ?? 0) + delta),
        );
        const mastery = confidence >= 4 ? "mastered" : confidence > 0 ? "learning" : "new";
        const intervalDays = [1, 1, 2, 4, 7, 14][confidence];
        await tx
          .insert(conceptProgressTable)
          .values({
            ownerId,
            conceptId,
            confidence,
            mastery,
            lastReviewedAt: now,
            nextReviewAt: new Date(now.getTime() + intervalDays * 86_400_000),
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              conceptProgressTable.ownerId,
              conceptProgressTable.conceptId,
            ],
            set: {
              confidence,
              mastery,
              lastReviewedAt: now,
              nextReviewAt: new Date(now.getTime() + intervalDays * 86_400_000),
              updatedAt: now,
            },
          });
      }
      return attempt;
    });
    res.status(201).json(attemptView(saved));
  },
);

export default router;
