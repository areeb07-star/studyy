import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  sourcesTable,
  type StudyCitation,
  type SourceLocator,
  unitsTable,
} from "@workspace/db/schema";
import {
  cachedAI,
  modelConfig,
  openai,
  sha256,
  withRetry,
} from "../ingestion/ai";

export type GroundedUnit = {
  id: string;
  sourceId: string;
  text: string;
  figureCaption: string | null;
  locator: SourceLocator;
  sourceTitle: string;
  sourceType: "pdf" | "pptx" | "video";
  similarity: number;
};

export async function retrieveRelevantUnits(
  courseId: string,
  ownerId: string,
  question: string,
): Promise<GroundedUnit[]> {
  const normalizedQuestion = question.trim().replace(/\s+/g, " ");
  const embedding = await cachedAI<number[]>(
    `studygraph:query:${modelConfig.embedding}:${sha256(normalizedQuestion.toLowerCase())}`,
    modelConfig.embedding,
    async () => {
      const response = await withRetry(() =>
        openai().embeddings.create({
          model: modelConfig.embedding,
          input: normalizedQuestion,
          dimensions: 1536,
        }),
      );
      const vector = response.data[0]?.embedding;
      if (!vector || vector.length !== 1536) {
        throw new Error(
          `The configured embedding model must return 1,536 dimensions; received ${vector?.length ?? 0}.`,
        );
      }
      return vector;
    },
  );

  const vectorLiteral = sql`${JSON.stringify(embedding)}::vector`;
  const distance = sql<number>`${unitsTable.embedding} <=> ${vectorLiteral}`;
  const baseFilters = [
    eq(sourcesTable.courseId, courseId),
    eq(sourcesTable.ownerId, ownerId),
    eq(sourcesTable.status, "ready"),
    sql`${unitsTable.embedding} IS NOT NULL`,
  ];

  const vectorMatches = await db
    .select({
      id: unitsTable.id,
      sourceId: unitsTable.sourceId,
      text: unitsTable.text,
      figureCaption: unitsTable.figureCaption,
      locator: unitsTable.locator,
      sourceTitle: sourcesTable.title,
      sourceType: sourcesTable.sourceType,
      distance,
    })
    .from(unitsTable)
    .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
    .where(and(...baseFilters))
    .orderBy(distance)
    .limit(14);

  const lexicalRank = sql<number>`ts_rank(
    to_tsvector('simple', ${unitsTable.text}),
    websearch_to_tsquery('simple', ${normalizedQuestion})
  )`;
  const lexicalMatches = await db
    .select({
      id: unitsTable.id,
      sourceId: unitsTable.sourceId,
      text: unitsTable.text,
      figureCaption: unitsTable.figureCaption,
      locator: unitsTable.locator,
      sourceTitle: sourcesTable.title,
      sourceType: sourcesTable.sourceType,
      rank: lexicalRank,
    })
    .from(unitsTable)
    .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
    .where(
      and(
        eq(sourcesTable.courseId, courseId),
        eq(sourcesTable.ownerId, ownerId),
        eq(sourcesTable.status, "ready"),
        sql`to_tsvector('simple', ${unitsTable.text}) @@ websearch_to_tsquery('simple', ${normalizedQuestion})`,
      ),
    )
    .orderBy(desc(lexicalRank))
    .limit(10);

  const candidates = new Map<
    string,
    GroundedUnit & { rankScore: number; lexicalHit: boolean }
  >();
  vectorMatches.forEach((row, index) => {
    const similarity = Math.max(0, Math.min(1, 1 - Number(row.distance)));
    if (similarity < 0.2) return;
    candidates.set(row.id, {
      ...row,
      similarity,
      rankScore: 1 / (60 + index) + similarity / 500,
      lexicalHit: false,
    });
  });
  lexicalMatches.forEach((row, index) => {
    const existing = candidates.get(row.id);
    const bonus = 1 / (60 + index);
    if (existing) {
      existing.rankScore += bonus;
      existing.lexicalHit = true;
    } else if (Number(row.rank) > 0) {
      candidates.set(row.id, {
        ...row,
        similarity: 0,
        rankScore: bonus,
        lexicalHit: true,
      });
    }
  });

  return [...candidates.values()]
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 8)
    .map(({ rankScore: _rankScore, lexicalHit: _lexicalHit, ...unit }) => unit);
}

export function citationFor(unit: GroundedUnit): StudyCitation {
  const excerpt = (unit.figureCaption || unit.text).trim();
  return {
    unitId: unit.id,
    sourceId: unit.sourceId,
    sourceTitle: unit.sourceTitle,
    sourceType: unit.sourceType,
    locator: unit.locator,
    excerpt:
      excerpt.length > 720 ? `${excerpt.slice(0, 717).trimEnd()}…` : excerpt,
  };
}
