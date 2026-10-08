import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export type SourceLocator =
  | { type: "page"; page: number; imagePath?: string }
  | { type: "slide"; slide: number; imagePath?: string }
  | { type: "video"; start_sec: number; end_sec: number; imagePath?: string };

export type StudyCitation = {
  unitId: string;
  sourceId: string;
  sourceTitle: string;
  sourceType: "pdf" | "pptx" | "video";
  locator: SourceLocator;
  excerpt: string;
};

export type StoredAssessmentQuestion = {
  id: string;
  prompt: string;
  options: string[];
  correctOption: number;
  explanation: string;
  citations: StudyCitation[];
  conceptIds: string[];
};

export type StoredAssessmentAnswer = {
  questionId: string;
  selectedOption: number | null;
};

export type AssessmentQuestionFeedback = {
  questionId: string;
  selectedOption: number | null;
  correctOption: number;
  isCorrect: boolean;
  explanation: string;
  citations: StudyCitation[];
};

const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(1536)",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) =>
    value
      .slice(1, -1)
      .split(",")
      .filter(Boolean)
      .map(Number),
});

export const sourceTypeEnum = pgEnum("studygraph_source_type", [
  "pdf",
  "pptx",
  "video",
]);

export const ingestionStatusEnum = pgEnum("studygraph_ingestion_status", [
  "queued",
  "processing",
  "ready",
  "failed",
]);

export const conceptMasteryEnum = pgEnum("studygraph_concept_mastery", [
  "new",
  "learning",
  "mastered",
]);

export const assessmentDifficultyEnum = pgEnum("studygraph_assessment_difficulty", [
  "easy",
  "medium",
  "hard",
]);

export const conversationRoleEnum = pgEnum("studygraph_conversation_role", [
  "user",
  "assistant",
]);

export const coursesTable = pgTable(
  "studygraph_courses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("studygraph_courses_owner_idx").on(table.ownerId)],
);

export const sourcesTable = pgTable(
  "studygraph_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    title: text("title").notNull(),
    originalFilename: text("original_filename"),
    sourceType: sourceTypeEnum("source_type").notNull(),
    storagePath: text("storage_path"),
    sourceUrl: text("source_url"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    language: text("language").notNull().default("auto"),
    status: ingestionStatusEnum("status").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    currentStep: text("current_step"),
    error: text("error"),
    unitsCreated: integer("units_created").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("studygraph_sources_course_idx").on(table.courseId),
    index("studygraph_sources_owner_idx").on(table.ownerId),
    index("studygraph_sources_status_idx").on(table.status),
    uniqueIndex("studygraph_sources_storage_path_uq").on(table.storagePath),
  ],
);

export const ingestionJobsTable = pgTable(
  "studygraph_ingestion_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sourcesTable.id, { onDelete: "cascade" }),
    status: ingestionStatusEnum("status").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    currentStep: text("current_step"),
    unitsCreated: integer("units_created").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("studygraph_jobs_source_idx").on(table.sourceId)],
);

export const unitsTable = pgTable(
  "studygraph_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sourcesTable.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    figureCaption: text("figure_caption"),
    locator: jsonb("locator").$type<SourceLocator>().notNull(),
    language: text("language").notNull().default("auto"),
    embedding: vector("embedding"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("studygraph_units_source_idx").on(table.sourceId),
    index("studygraph_units_embedding_hnsw").using(
      "hnsw",
      sql`${table.embedding} vector_cosine_ops`,
    ),
    index("studygraph_units_text_gin").using(
      "gin",
      sql`to_tsvector('simple', ${table.text})`,
    ),
  ],
);

export const topicsTable = pgTable(
  "studygraph_topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description"),
  },
  (table) => [
    uniqueIndex("studygraph_topics_course_name_uq").on(
      table.courseId,
      table.normalizedName,
    ),
  ],
);

export const conceptsTable = pgTable(
  "studygraph_concepts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topicsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description"),
  },
  (table) => [
    uniqueIndex("studygraph_concepts_course_name_uq").on(
      table.courseId,
      table.normalizedName,
    ),
  ],
);

export const conceptEdgesTable = pgTable(
  "studygraph_concept_edges",
  {
    courseId: uuid("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    prerequisiteConceptId: uuid("prerequisite_concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    dependentConceptId: uuid("dependent_concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({
      columns: [table.prerequisiteConceptId, table.dependentConceptId],
    }),
  ],
);

export const unitConceptsTable = pgTable(
  "studygraph_unit_concepts",
  {
    unitId: uuid("unit_id")
      .notNull()
      .references(() => unitsTable.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.unitId, table.conceptId] })],
);

export const aiCacheTable = pgTable("studygraph_ai_cache", {
  cacheKey: text("cache_key").primaryKey(),
  model: text("model").notNull(),
  response: jsonb("response").$type<unknown>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const conversationsTable = pgTable(
  "studygraph_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    title: text("title").notNull().default("New study session"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("studygraph_conversations_course_idx").on(table.courseId),
    index("studygraph_conversations_owner_idx").on(table.ownerId),
  ],
);

export const conversationMessagesTable = pgTable(
  "studygraph_conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    role: conversationRoleEnum("role").notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations").$type<StudyCitation[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("studygraph_messages_conversation_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const assessmentsTable = pgTable(
  "studygraph_assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    topicId: uuid("topic_id").references(() => topicsTable.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    difficulty: assessmentDifficultyEnum("difficulty").notNull(),
    questions: jsonb("questions")
      .$type<StoredAssessmentQuestion[]>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("studygraph_assessments_course_idx").on(table.courseId),
    index("studygraph_assessments_owner_idx").on(table.ownerId),
  ],
);

export const assessmentAttemptsTable = pgTable(
  "studygraph_assessment_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assessmentId: uuid("assessment_id")
      .notNull()
      .references(() => assessmentsTable.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    answers: jsonb("answers").$type<StoredAssessmentAnswer[]>().notNull(),
    feedback: jsonb("feedback")
      .$type<AssessmentQuestionFeedback[]>()
      .notNull(),
    score: integer("score").notNull(),
    total: integer("total").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("studygraph_attempts_assessment_idx").on(
      table.assessmentId,
      table.createdAt,
    ),
    index("studygraph_attempts_owner_idx").on(table.ownerId),
  ],
);

export const conceptProgressTable = pgTable(
  "studygraph_concept_progress",
  {
    ownerId: text("owner_id").notNull(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    confidence: integer("confidence").notNull().default(0),
    mastery: conceptMasteryEnum("mastery").notNull().default("new"),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.conceptId] }),
    index("studygraph_progress_owner_review_idx").on(
      table.ownerId,
      table.nextReviewAt,
    ),
  ],
);

export const insertCourseSchema = createInsertSchema(coursesTable).omit({
  id: true,
  ownerId: true,
  createdAt: true,
});
export const insertSourceSchema = createInsertSchema(sourcesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertUnitSchema = createInsertSchema(unitsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertCourse = z.infer<typeof insertCourseSchema>;
export type Course = typeof coursesTable.$inferSelect;
export type Source = typeof sourcesTable.$inferSelect;
export type IngestionJob = typeof ingestionJobsTable.$inferSelect;
export type Unit = typeof unitsTable.$inferSelect;
