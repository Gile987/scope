// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { writeFileSync, readFileSync, readdirSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { stringify as toYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_URL = process.env.API_URL || 'http://api:80';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/app/config/criteria';
const SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_MS || '10000', 10);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ApiCriterion {
  id: string;
  prompt: string;
  dependsOn?: string[];
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

interface CriterionYaml {
  id: string;
  prompt: string;
  depends_on: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch active criteria from the REST API, filtering out deleted ones. */
async function fetchCriteria(): Promise<CriterionYaml[]> {
  const url = `${API_URL}/api/v1/criteria`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} returned ${res.status}: ${await res.text()}`);
  }
  const data: ApiCriterion[] = await res.json() as ApiCriterion[];

  return data
    .filter(c => !c.deletedAt)
    .map(c => ({
      id: c.id,
      prompt: c.prompt,
      depends_on: c.dependsOn ?? [],
    }));
}

/** Build the expected filename for a criterion. */
function criterionFilename(id: string): string {
  return `${id}.yaml`;
}

/** Read an existing YAML file and return its text content, or null. */
function readExisting(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sync logic
// ---------------------------------------------------------------------------

async function sync(): Promise<void> {
  const criteria = await fetchCriteria();

  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`[criteria-syncer] Created output directory: ${OUTPUT_DIR}`);
  }

  const expectedFiles = new Set<string>();

  // Write / update YAML files
  let written = 0;
  let unchanged = 0;

  for (const criterion of criteria) {
    const filename = criterionFilename(criterion.id);
    expectedFiles.add(filename);
    const filePath = join(OUTPUT_DIR, filename);
    const yamlContent = toYaml(criterion, { lineWidth: 0 });

    const existing = readExisting(filePath);
    if (existing === yamlContent) {
      unchanged++;
      continue;
    }

    writeFileSync(filePath, yamlContent, 'utf-8');
    written++;
    console.log(`[criteria-syncer] Wrote ${filename}${existing === null ? ' (new)' : ' (updated)'}`);
  }

  // Remove stale files
  let removed = 0;
  const existingFiles = readdirSync(OUTPUT_DIR).filter(
    f => f.endsWith('.yaml') || f.endsWith('.yml'),
  );

  for (const file of existingFiles) {
    if (!expectedFiles.has(file)) {
      unlinkSync(join(OUTPUT_DIR, file));
      removed++;
      console.log(`[criteria-syncer] Removed stale file: ${file}`);
    }
  }

  console.log(
    `[criteria-syncer] Sync complete — ${criteria.length} criteria: ${written} written, ${unchanged} unchanged, ${removed} removed`,
  );
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let running = true;
let timer: ReturnType<typeof setTimeout> | null = null;

async function run(): Promise<void> {
  console.log(`[criteria-syncer] Starting — API_URL=${API_URL}, OUTPUT_DIR=${OUTPUT_DIR}, interval=${SYNC_INTERVAL_MS}ms`);

  // Initial sync (retry until API is ready)
  while (running) {
    try {
      await sync();
      break;
    } catch (err) {
      console.warn(`[criteria-syncer] Initial sync failed, retrying in 3s:`, (err as Error).message);
      await new Promise(r => { timer = setTimeout(r, 3000); });
    }
  }

  // Periodic sync
  while (running) {
    await new Promise(r => { timer = setTimeout(r, SYNC_INTERVAL_MS); });
    if (!running) break;
    try {
      await sync();
    } catch (err) {
      console.error(`[criteria-syncer] Sync error:`, (err as Error).message);
    }
  }

  console.log('[criteria-syncer] Stopped');
}

// Graceful shutdown
function shutdown(): void {
  console.log('[criteria-syncer] Shutting down…');
  running = false;
  if (timer) clearTimeout(timer);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

run().catch(err => {
  console.error('[criteria-syncer] Fatal error:', err);
  process.exit(1);
});
