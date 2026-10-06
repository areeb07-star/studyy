# StudyGraph

StudyGraph turns a student's course materials into an organized, source-linked study library.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server on the configured `PORT` (the workspace default is port 5000).
- `pnpm --filter @workspace/studygraph run dev` — StudyGraph web app.
- `pnpm -w run typecheck:libs` — typecheck shared libraries.
- `pnpm --filter @workspace/api-server run typecheck` — typecheck the API.
- `pnpm --filter @workspace/studygraph run typecheck` — typecheck the web app.
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod validators.
- `pnpm --filter @workspace/db run push` — apply development database schema changes.

Required platform configuration: PostgreSQL, Clerk authentication, and a private App Storage bucket. Configure `OPENAI_API_KEY` through Replit Secrets. The model environment variables and defaults are documented in `README.md`.

## Stack

- pnpm workspaces, Node.js, TypeScript, React, Vite, Wouter, TanStack Query
- API: Express 5 with Clerk authentication
- DB: PostgreSQL, Drizzle ORM, pgvector, PostgreSQL full-text search
- Source storage: private Replit App Storage; database rows retain paths and queryable metadata, not file bytes
- Extraction: PyMuPDF and python-pptx through `uv`, LibreOffice for slide rendering, FFmpeg for video audio/frames, and yt-dlp for YouTube downloads
- AI: direct OpenAI API using the secret-backed SDK client

## Where things live

- `lib/api-spec/openapi.yaml` — source of truth for REST contracts.
- `lib/api-client-react` and `lib/api-zod` — generated hooks, request types, and validators; do not edit generated files directly.
- `lib/db/src/schema/studygraph.ts` — course, source, ingestion job, unit, topic, concept, prerequisite, and AI-cache schema.
- `artifacts/api-server/src/routes/studygraph.ts` — authenticated course/source APIs.
- `artifacts/api-server/src/lib/ingestion/` — document extraction, multimodal processing, embeddings, and topic/concept indexing.
- `artifacts/studygraph/src/` — StudyGraph screens, interactions, and visual system.

## Architecture decisions

- Keep public APIs, identity, upload authorization, job status, and PostgreSQL state in the existing Express/Drizzle workspace. Run Python only as an extraction process; do not add a parallel FastAPI service.
- Store originals and rendered page/slide/frame images in private App Storage. Store source paths, locators, extracted text, captions, embeddings, and progress in PostgreSQL.
- Every unit must remain traceable to a PDF page, PPTX slide, or video time range. AI captions and course structure use only extracted source material.
- Ingestion is a persisted background job. If an extractor or configured provider fails, expose the error and mark the source failed; never generate a substitute transcript or pretend the file is ready.
- **Phase gate:** deliver Phase 1 only, then stop. Do not start later phases until the user explicitly says “proceed.”

## Product

Phase 1 provides account-protected course libraries, persistent PDF/PPTX/video/YouTube source ingestion, per-source progress, rendered source images, source-linked text units, embeddings, and a topic/concept/prerequisite structure. Grounded tutoring, assessments, user study records, and exports are later phases.

## User preferences

- Preserve source attribution and factual grounding.
- Make unavailable AI providers or extractors fail visibly instead of filling gaps with fabricated content.
- Keep model names configurable through environment variables; keep credentials only in Replit Secrets.
- Work one phase at a time and wait for “proceed” before continuing.

## Gotchas

- After editing the OpenAPI contract, run codegen before using its generated API types.
- Keep the pgvector extension enabled before pushing the StudyGraph schema.
- The vector index is fixed to 1,536 dimensions; select an embedding model that supports that size.
- Video ingestion currently accepts files up to 500 MB and two hours; document rendering caps a source at 500 pages/slides.
