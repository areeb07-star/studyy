# StudyGraph

StudyGraph turns course files and lectures into a searchable, source-linked study library. This build implements **Phase 1: ingestion and source organization**. Later tutoring, assessments, learning records, and export workflows are intentionally out of scope until the user says “proceed.”

## Phase 1

- Sign in with Clerk and create private course libraries.
- Upload PDF, PPTX, and common video files directly to private App Storage through short-lived signed URLs.
- Add YouTube videos by URL.
- Persist source records, job status, progress, failures, extracted units, and the topic/concept graph in PostgreSQL.
- Extract document text and speaker notes; render PDF pages and PPTX slides; sample and caption meaningful visuals.
- Extract video audio, transcribe with source timestamps, and attach sampled visual frames to time-linked units.
- Store multilingual-capable text embeddings in pgvector and cache AI results by model and SHA-256 source content.
- Merge duplicate course concepts by normalized labels and attach prerequisite edges only when supported by the source units.

## Runtime and services

The workspace already supplies an Express/TypeScript API, PostgreSQL/Drizzle, Clerk, and App Storage. StudyGraph extends that runtime instead of creating a second API service. Python is used only for PDF/PPTX extraction and slide rendering; the Express worker coordinates ingestion and persists its status. Video media processing uses FFmpeg and yt-dlp.

Required Replit setup:

- PostgreSQL database with the `vector` extension enabled.
- Clerk authentication configured in the Replit Auth pane.
- Private App Storage bucket with `PRIVATE_OBJECT_DIR` and `PUBLIC_OBJECT_SEARCH_PATHS` configured by the storage integration.
- `OPENAI_API_KEY` stored in Replit Secrets; never place its value in code, logs, or documentation.

## Model configuration

Model names are read from environment variables and can be changed without editing source:

| Variable | Default | Purpose |
| --- | --- | --- |
| `STUDYGRAPH_STRUCTURE_MODEL` | `gpt-4.1-mini` | Source-grounded topics, concepts, and prerequisite candidates |
| `STUDYGRAPH_VISION_MODEL` | `gpt-4.1-mini` | Captions for rendered document and video frames |
| `STUDYGRAPH_EMBEDDING_MODEL` | `text-embedding-3-small` | Unit embeddings |
| `STUDYGRAPH_TRANSCRIPTION_MODEL` | `whisper-1` | Timestamped video transcription |

The vector index is fixed at 1,536 dimensions to match the default embedding model. Use a configured model that can return 1,536 dimensions. Changing dimensions requires a schema migration, re-embedding existing units, and rebuilding the index.

## Development

```bash
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/studygraph run dev
```

Use the existing workflows in the workspace to run both services. After changing the API contract, run:

```bash
pnpm --filter @workspace/api-spec run codegen
pnpm -w run typecheck:libs
```

After changing the Drizzle schema, apply it to the development database with:

```bash
pnpm --filter @workspace/db run push
```

Then run API and web typechecks/builds before considering a change complete. Never push development schema changes into production without a separately reviewed production migration.

## Data handling and failure behavior

Uploaded originals and derived page/slide/frame images stay in private App Storage. PostgreSQL stores object paths and searchable metadata, not binary file contents. Private source downloads require both a signed-in user and a matching object owner ACL.

Ingestion status is persisted per source/job, so a page reload does not lose progress. An unsupported file, unavailable extractor, failed download, invalid model, missing provider configuration, or unsuccessful transcription is reported as a failed job with an error; StudyGraph does not fabricate transcript, captions, or study data to hide a failure.

Current Phase 1 limits: documents up to 500 pages/slides; uploaded videos up to 500 MB and two hours; sampled video frames are spaced 90 seconds apart. YouTube downloads may also fail when a video is restricted, unavailable, or not downloadable without credentials.

## Main project files

- API contract: `lib/api-spec/openapi.yaml`
- Generated React hooks / validators: `lib/api-client-react`, `lib/api-zod`
- PostgreSQL schema: `lib/db/src/schema/studygraph.ts`
- API routes and storage/auth: `artifacts/api-server/src/routes/`
- Ingestion worker and extractor: `artifacts/api-server/src/lib/ingestion/`
- Web app: `artifacts/studygraph/src/`
