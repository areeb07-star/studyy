---
name: pgvector HNSW dimensions
description: The pgvector HNSW index requires a vector column with a declared dimension.
---

**Rule:** Declare a fixed dimension on pgvector columns that are indexed with HNSW, and keep the embedding request dimension consistent with the column.

**Why:** Drizzle schema push failed when the custom vector type had no dimension; pgvector rejected HNSW index creation because it could not build an index for an unbounded vector.

**How to apply:** When changing the embedding model or vector size, update the column, index, provider request, and re-embedding plan together.
