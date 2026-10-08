import { and, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { conversationsTable, coursesTable } from "@workspace/db/schema";

export const STUDYGRAPH_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function studygraphOwnerId(res: Response): string {
  return res.locals.userId as string;
}

export function validStudygraphId(id: string): boolean {
  return STUDYGRAPH_UUID.test(id);
}

export function studygraphPathParam(
  req: Pick<Request, "params">,
  name: string,
): string {
  const value = req.params[name];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export async function findOwnedCourse(courseId: string, ownerId: string) {
  const [course] = await db
    .select()
    .from(coursesTable)
    .where(and(eq(coursesTable.id, courseId), eq(coursesTable.ownerId, ownerId)))
    .limit(1);
  return course;
}

export async function findOwnedConversation(
  conversationId: string,
  ownerId: string,
) {
  const [conversation] = await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, conversationId),
        eq(conversationsTable.ownerId, ownerId),
      ),
    )
    .limit(1);
  return conversation;
}
