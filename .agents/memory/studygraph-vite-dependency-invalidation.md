---
name: StudyGraph Vite dependency invalidation
description: A stale Vite optimized dependency can preserve an old React version after package versions have been aligned.
---

**Rule:** After changing React dependency versions, verify the optimized browser bundle reflects the same versions as package resolution; package metadata alone is not enough.

**Why:** Node resolved React and ReactDOM at 19.1.4 while Vite's optimized browser bundle still embedded ReactDOM 19.1.0, which kept the preview in a runtime-error overlay after a workflow restart.

**How to apply:** If a React version mismatch persists after dependencies align, inspect the optimized Vite bundle for stale versions and invalidate the artifact's generated cache before restarting.
