import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateStudyConversationBody,
  SendConversationMessageBody,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  conversationMessagesTable,
  conversationsTable,
  type StudyCitation,
} from "@workspace/db/schema";
import { logger } from "../lib/logger";
import {
  modelConfig,
  openai,
  withRetry,
} from "../lib/ingestion/ai";
import {
  findOwnedConversation,
  findOwnedCourse,
  studygraphPathParam,
  studygraphOwnerId,
  validStudygraphId,
} from "../lib/studygraph/ownership";
import {
  citationFor,
  retrieveRelevantUnits,
  type GroundedUnit,
} from "../lib/studygraph/retrieval";

const router: IRouter = Router();

function messageDto(message: typeof conversationMessagesTable.$inferSelect) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    citations: message.citations,
    createdAt: message.createdAt,
  };
}

function parseTutorResult(value: string): {
  answerable: boolean;
  answer: string;
  citationUnitIds: string[];
} | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.answerable !== "boolean" ||
      typeof record.answer !== "string" ||
      !Array.isArray(record.citationUnitIds)
    ) {
      return null;
    }
    return {
      answerable: record.answerable,
      answer: record.answer.trim(),
      citationUnitIds: record.citationUnitIds.filter(
        (item): item is string => typeof item === "string",
      ),
    };
  } catch {
    return null;
  }
}

async function saveTurn(
  conversationId: string,
  ownerId: string,
  currentTitle: string,
  userContent: string,
  assistantContent: string,
  citations: StudyCitation[],
) {
  return db.transaction(async (tx) => {
    const [userMessage] = await tx
      .insert(conversationMessagesTable)
      .values({ conversationId, role: "user", content: userContent, citations: [] })
      .returning();
    const [assistantMessage] = await tx
      .insert(conversationMessagesTable)
      .values({
        conversationId,
        role: "assistant",
        content: assistantContent,
        citations,
      })
      .returning();
    await tx
      .update(conversationsTable)
      .set({
        updatedAt: new Date(),
        title:
          currentTitle === "New study session" && userContent.length > 2
            ? userContent.split(/\r?\n/, 1)[0].slice(0, 76)
            : currentTitle,
      })
      .where(
        and(
          eq(conversationsTable.id, conversationId),
          eq(conversationsTable.ownerId, ownerId),
        ),
      );
    return { userMessage, assistantMessage };
  });
}

function contextFor(units: GroundedUnit[]): string {
  return units
    .map((unit) => {
      const sourceLocation = JSON.stringify(unit.locator);
      return [
        `UNIT_ID: ${unit.id}`,
        `SOURCE: ${unit.sourceTitle} (${unit.sourceType})`,
        `LOCATOR: ${sourceLocation}`,
        `TEXT: ${unit.text.slice(0, 5_000)}`,
        unit.figureCaption ? `CAPTION: ${unit.figureCaption.slice(0, 1_000)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n---\n\n");
}

router.get(
  "/courses/:courseId/conversations",
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
    const conversations = await db
      .select()
      .from(conversationsTable)
      .where(
        and(
          eq(conversationsTable.courseId, courseId),
          eq(conversationsTable.ownerId, ownerId),
        ),
      )
      .orderBy(desc(conversationsTable.updatedAt))
      .limit(40);
    const counts =
      conversations.length > 0
        ? await db
            .select({
              conversationId: conversationMessagesTable.conversationId,
              messageCount: sql<number>`count(*)::int`,
            })
            .from(conversationMessagesTable)
            .where(
              inArray(
                conversationMessagesTable.conversationId,
                conversations.map((item) => item.id),
              ),
            )
            .groupBy(conversationMessagesTable.conversationId)
        : [];
    const countById = new Map(
      counts.map((item) => [item.conversationId, Number(item.messageCount)]),
    );
    res.json(
      conversations.map((item) => ({
        id: item.id,
        courseId: item.courseId,
        title: item.title,
        messageCount: countById.get(item.id) ?? 0,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    );
  },
);

router.post(
  "/courses/:courseId/conversations",
  async (req: Request, res: Response) => {
    const ownerId = studygraphOwnerId(res);
    const courseId = studygraphPathParam(req, "courseId");
    if (!validStudygraphId(courseId)) {
      res.status(400).json({ error: "Invalid course id." });
      return;
    }
    const input = CreateStudyConversationBody.safeParse(req.body ?? {});
    if (!input.success) {
      res.status(400).json({ error: "Conversation details are invalid." });
      return;
    }
    const course = await findOwnedCourse(courseId, ownerId);
    if (!course) {
      res.status(404).json({ error: "Course not found." });
      return;
    }
    const [conversation] = await db
      .insert(conversationsTable)
      .values({
        courseId,
        ownerId,
        title: input.data.title?.trim() || "New study session",
      })
      .returning();
    res.status(201).json({
      id: conversation.id,
      courseId: conversation.courseId,
      title: conversation.title,
      messageCount: 0,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    });
  },
);

router.get(
  "/conversations/:conversationId/messages",
  async (req: Request, res: Response) => {
    const ownerId = studygraphOwnerId(res);
    const conversationId = studygraphPathParam(req, "conversationId");
    if (!validStudygraphId(conversationId)) {
      res.status(400).json({ error: "Invalid conversation id." });
      return;
    }
    const conversation = await findOwnedConversation(conversationId, ownerId);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }
    const messages = await db
      .select()
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.conversationId, conversationId))
      .orderBy(desc(conversationMessagesTable.createdAt))
      .limit(120);
    res.json(messages.reverse().map(messageDto));
  },
);

router.post(
  "/conversations/:conversationId/messages",
  async (req: Request, res: Response) => {
    const ownerId = studygraphOwnerId(res);
    const conversationId = studygraphPathParam(req, "conversationId");
    if (!validStudygraphId(conversationId)) {
      res.status(400).json({ error: "Invalid conversation id." });
      return;
    }
    const input = SendConversationMessageBody.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Enter a question between 2 and 6,000 characters." });
      return;
    }
    const conversation = await findOwnedConversation(conversationId, ownerId);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    let units: GroundedUnit[];
    try {
      units = await retrieveRelevantUnits(
        conversation.courseId,
        ownerId,
        input.data.content,
      );
    } catch (error) {
      logger.error({ error, conversationId }, "Tutor retrieval failed");
      res.status(503).json({
        error: "StudyGraph could not search course material. Try again in a moment.",
      });
      return;
    }

    const history = await db
      .select({
        role: conversationMessagesTable.role,
        content: conversationMessagesTable.content,
      })
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.conversationId, conversationId))
      .orderBy(desc(conversationMessagesTable.createdAt))
      .limit(12);

    if (units.length === 0) {
      const saved = await saveTurn(
        conversationId,
        ownerId,
        conversation.title,
        input.data.content.trim(),
        "I couldn't find enough relevant evidence in this course's ready sources to answer that yet. Try a more specific question, or add and process material that covers this topic.",
        [],
      );
      res.json({
        userMessage: messageDto(saved.userMessage),
        assistantMessage: messageDto(saved.assistantMessage),
        supportStatus: "insufficient_context",
      });
      return;
    }

    try {
      const response = await withRetry(() =>
        openai().chat.completions.create({
          model: modelConfig.tutor,
          max_completion_tokens: 1_200,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: [
                "You are StudyGraph, a careful course tutor.",
                "Answer only from the supplied course units. Do not use outside facts or invent missing details.",
                "If the supplied units do not support a reliable answer, set answerable to false and explain the gap briefly.",
                "When answerable, cite every substantive claim by listing the exact supporting unit IDs in citationUnitIds.",
                "Return only JSON with this shape: {\"answerable\":boolean,\"answer\":string,\"citationUnitIds\":string[]}.",
                "Keep the answer clear, helpful, and appropriate for a student.",
                `COURSE MATERIAL:\n${contextFor(units)}`,
              ].join("\n\n"),
            },
            ...history.reverse().map((item) => ({
              role: item.role,
              content: item.content,
            })),
            { role: "user" as const, content: input.data.content.trim() },
          ],
        }),
      );
      const raw = response.choices[0]?.message?.content;
      const parsed = raw ? parseTutorResult(raw) : null;
      if (!parsed) throw new Error("Tutor returned an invalid structured answer.");

      const unitById = new Map(units.map((unit) => [unit.id, unit]));
      const citations = parsed.citationUnitIds
        .map((id) => unitById.get(id))
        .filter((unit): unit is GroundedUnit => Boolean(unit))
        .slice(0, 5)
        .map(citationFor);
      const supported = parsed.answerable && parsed.answer.length > 0 && citations.length > 0;
      const assistantContent = supported
        ? parsed.answer
        : "I couldn't find enough evidence in the available course material to answer that reliably. Try asking about a point covered in one of the listed sources.";
      const saved = await saveTurn(
        conversationId,
        ownerId,
        conversation.title,
        input.data.content.trim(),
        assistantContent,
        supported ? citations : [],
      );
      res.json({
        userMessage: messageDto(saved.userMessage),
        assistantMessage: messageDto(saved.assistantMessage),
        supportStatus: supported ? "supported" : "insufficient_context",
      });
    } catch (error) {
      logger.error({ error, conversationId }, "Tutor response failed");
      res.status(503).json({
        error: "StudyGraph couldn't complete that answer. Your question was not saved; please try again.",
      });
    }
  },
);

export default router;
