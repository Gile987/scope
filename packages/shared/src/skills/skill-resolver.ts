// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Skill Resolver — fetches skill content from GitHub and creates skill revisions.
 *
 * Resolution flow:
 * 1. Discover the skill directory in the GitHub repo using the Trees API
 * 2. Get the latest commit touching the skill directory
 * 3. Download skill directory files (SKILL.md + supporting files)
 * 4. Archive as tar.gz and upload to blob storage
 * 5. Parse SKILL.md and validate per Agent Skills spec
 * 6. Create or retrieve SkillRevisionDocument via the store
 */

import { parseSkillMd } from './skill-parser.js';
import { validateSkillFrontmatter } from './skill-validator.js';
import { buildSkillRevisionRef } from './skill-revision-id.js';
import { SkillRevisionStore } from './skill-revision-store.js';
import type { SkillRevisionDocument } from '../types/skill.js';

/** Options for the skill resolver */
export interface SkillResolverOptions {
  /** GitHub API base URL (default: https://api.github.com) */
  githubApiUrl?: string;
  /** GitHub token for authentication (optional, increases rate limits) */
  githubToken?: string;
}

/** A file entry discovered in a skill directory */
interface SkillFileEntry {
  path: string;       // Path relative to skill directory (e.g. "SKILL.md", "scripts/extract.py")
  content: string;    // File content (text)
}

/**
 * Well-known directories to search for skills in a GitHub repo,
 * per the skills.sh CLI discovery order.
 */
const SKILL_SEARCH_DIRS = [
  'skills',
  '.agents/skills',
  '.github/skills',
  '.claude/skills',
  '.copilot/skills',
  '.roo/skills',
  '.cursor/skills',
  '', // root-level skill directories
];

/**
 * Encode a file path for use in GitHub Contents API URLs.
 * Encodes each segment individually (handling special chars like spaces, #)
 * while keeping literal slashes so the API can parse the path correctly.
 *
 * Using plain encodeURIComponent on the full path would turn
 * "skills/azure-ai/SKILL.md" into "skills%2Fazure-ai%2FSKILL.md",
 * which GitHub returns 404 for.
 */
export function encodeGitHubPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Resolves a skill from a GitHub repository and creates/retrieves a SkillRevisionDocument.
 */
export class SkillResolver {
  private readonly githubApiUrl: string;
  private readonly headers: Record<string, string>;

  constructor(options?: SkillResolverOptions) {
    this.githubApiUrl = options?.githubApiUrl?.replace(/\/+$/, '') ?? 'https://api.github.com';
    this.headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'scope-mt-skill-resolver',
    };
    if (options?.githubToken) {
      this.headers['Authorization'] = `Bearer ${options.githubToken}`;
    }
  }

  /**
   * Resolve a skill from a GitHub repo, returning an existing or newly created SkillRevisionDocument.
   *
   * @param source - GitHub repo (e.g. "vercel-labs/agent-skills")
   * @param skillName - Skill name (e.g. "vercel-react-best-practices")
   * @param store - SkillRevisionStore for persistence
   * @param uploadArchive - Function to upload a tar.gz archive and return its URL
   * @returns The SkillRevisionDocument for this skill at its latest commit
   */
  async resolve(
    source: string,
    skillName: string,
    store: SkillRevisionStore,
    uploadArchive: (name: string, data: Buffer) => Promise<string>
  ): Promise<SkillRevisionDocument> {
    // 1. Discover the skill directory path in the repo
    const skillPath = await this.discoverSkillPath(source, skillName);
    if (!skillPath) {
      throw new Error(`Skill "${skillName}" not found in repository "${source}". Searched well-known directories.`);
    }

    // 2. Get the latest commit touching the skill directory
    const commitInfo = await this.getLatestCommit(source, skillPath);

    // 3. Check if we already have this revision
    const ref = buildSkillRevisionRef(source, skillName, commitInfo.sha);
    const existing = await store.getByRef(ref);
    if (existing) {
      return existing;
    }

    // 4. Download skill directory files
    const files = await this.downloadSkillFiles(source, skillPath, commitInfo.sha);

    // 5. Find and parse SKILL.md
    const skillMdFile = files.find(f => f.path === 'SKILL.md');
    if (!skillMdFile) {
      throw new Error(`SKILL.md not found in ${source}/${skillPath} at commit ${commitInfo.sha}`);
    }

    const parsed = parseSkillMd(skillMdFile.content);

    // 6. Validate per spec (use actual directory name from discovered path)
    const dirName = skillPath.split('/').pop()!;
    const validation = validateSkillFrontmatter(parsed.frontmatter, dirName);
    if (!validation.valid) {
      const errorMessages = validation.errors.map(e => `${e.field}: ${e.message}`).join('; ');
      throw new Error(`Invalid SKILL.md in ${source}/${skillPath}: ${errorMessages}`);
    }
    const validationWarnings = validation.warnings.map(w => `${w.field}: ${w.message}`);

    // 7. Create tar.gz archive and upload
    const archiveData = await this.createArchive(skillName, files);
    const archiveUrl = await uploadArchive(`skill-revisions/${skillName}-${commitInfo.sha.slice(0, 8)}.tar.gz`, archiveData);

    // 8. Store the revision
    const now = new Date();
    return store.findOrCreate({
      ref,
      source,
      skillName,
      skillPath,
      commitHash: commitInfo.sha,
      commitTimestamp: commitInfo.date,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      license: parsed.frontmatter.license,
      compatibility: parsed.frontmatter.compatibility,
      allowedTools: parsed.frontmatter.allowedTools,
      metadata: parsed.frontmatter.metadata,
      content: skillMdFile.content,
      archiveUrl,
      ...(validationWarnings.length > 0 ? { validationWarnings } : {}),
      resolvedAt: now,
    });
  }

  /**
   * Discover where the skill directory lives in the repo.
   * First searches by directory name, then falls back to scanning SKILL.md
   * frontmatter `name` fields in well-known parent directories.
   */
  async discoverSkillPath(source: string, skillName: string): Promise<string | null> {
    // Primary: try each well-known directory by name
    for (const searchDir of SKILL_SEARCH_DIRS) {
      const candidatePath = searchDir ? `${searchDir}/${skillName}` : skillName;
      const skillMdPath = `${candidatePath}/SKILL.md`;

      try {
        const url = `${this.githubApiUrl}/repos/${source}/contents/${encodeGitHubPath(skillMdPath)}`;
        const res = await fetch(url, { headers: this.headers });
        if (res.ok) {
          return candidatePath;
        }
      } catch {
        // Continue searching
      }
    }

    // Fallback: scan well-known parent directories for a SKILL.md whose
    // frontmatter `name` matches the requested skillName.
    return this.discoverByFrontmatterName(source, skillName);
  }

  /**
   * Fallback discovery: list subdirectories in well-known skill parent dirs
   * and check each SKILL.md frontmatter for a matching `name` field.
   */
  private async discoverByFrontmatterName(source: string, skillName: string): Promise<string | null> {
    for (const searchDir of SKILL_SEARCH_DIRS) {
      if (!searchDir) continue; // Skip root-level — too broad to scan

      try {
        const url = `${this.githubApiUrl}/repos/${source}/contents/${encodeGitHubPath(searchDir)}`;
        const res = await fetch(url, { headers: this.headers });
        if (!res.ok) continue;

        const entries = (await res.json()) as Array<{ name: string; type: string }>;
        const dirs = entries.filter((e) => e.type === 'dir');

        for (const dir of dirs) {
          const candidatePath = `${searchDir}/${dir.name}`;
          const skillMdUrl = `${this.githubApiUrl}/repos/${source}/contents/${encodeGitHubPath(`${candidatePath}/SKILL.md`)}`;
          try {
            const mdRes = await fetch(skillMdUrl, { headers: this.headers });
            if (!mdRes.ok) continue;

            const data = (await mdRes.json()) as { content?: string; encoding?: string };
            if (!data.content || data.encoding !== 'base64') continue;

            const raw = Buffer.from(data.content, 'base64').toString('utf-8');
            const parsed = parseSkillMd(raw);
            if (parsed.frontmatter.name === skillName) {
              return candidatePath;
            }
          } catch {
            // Skip this subdirectory
          }
        }
      } catch {
        // Skip this search dir
      }
    }

    return null;
  }

  /**
   * Get the latest commit touching the skill directory.
   */
  private async getLatestCommit(
    source: string,
    skillPath: string
  ): Promise<{ sha: string; date: Date }> {
    const url = `${this.githubApiUrl}/repos/${source}/commits?path=${encodeURIComponent(skillPath)}&per_page=1`;
    const res = await fetch(url, { headers: this.headers });

    if (!res.ok) {
      throw new Error(`Failed to get commits for ${source}/${skillPath}: ${res.status} ${res.statusText}`);
    }

    const commits = await res.json() as Array<{
      sha: string;
      commit: { committer: { date: string } };
    }>;

    if (commits.length === 0) {
      throw new Error(`No commits found for path ${skillPath} in ${source}`);
    }

    return {
      sha: commits[0].sha,
      date: new Date(commits[0].commit.committer.date),
    };
  }

  /**
   * Download all files in the skill directory at a specific commit.
   * Returns paths relative to the skill directory root.
   */
  private async downloadSkillFiles(
    source: string,
    skillPath: string,
    commitSha: string
  ): Promise<SkillFileEntry[]> {
    // Get the directory listing at the specific commit
    const url = `${this.githubApiUrl}/repos/${source}/contents/${encodeGitHubPath(skillPath)}?ref=${commitSha}`;
    const res = await fetch(url, { headers: this.headers });

    if (!res.ok) {
      throw new Error(`Failed to list ${source}/${skillPath} at ${commitSha}: ${res.status} ${res.statusText}`);
    }

    const entries = await res.json() as Array<{
      name: string;
      path: string;
      type: 'file' | 'dir';
      download_url: string | null;
    }>;

    const files: SkillFileEntry[] = [];

    for (const entry of entries) {
      if (entry.type === 'file' && entry.download_url) {
        const fileRes = await fetch(entry.download_url, { headers: this.headers });
        if (fileRes.ok) {
          const content = await fileRes.text();
          // Path relative to skill directory
          const relativePath = entry.path.startsWith(skillPath + '/')
            ? entry.path.slice(skillPath.length + 1)
            : entry.name;
          files.push({ path: relativePath, content });
        }
      } else if (entry.type === 'dir') {
        // Recurse into subdirectories (scripts/, references/, assets/)
        const subFiles = await this.downloadSkillFiles(source, entry.path, commitSha);
        for (const subFile of subFiles) {
          const relativePath = entry.path.startsWith(skillPath + '/')
            ? `${entry.path.slice(skillPath.length + 1)}/${subFile.path}`
            : `${entry.name}/${subFile.path}`;
          files.push({ path: relativePath, content: subFile.content });
        }
      }
    }

    return files;
  }

  /**
   * Create a tar.gz archive from skill files.
   */
  private async createArchive(skillName: string, files: SkillFileEntry[]): Promise<Buffer> {
    // Dynamic import of tar (already a dependency of shared package)
    const tar = await import('tar');
    const { writeFileSync, mkdirSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { randomUUID } = await import('crypto');

    // Create a temp directory with the skill files
    const tempBase = join(tmpdir(), `skill-archive-${randomUUID()}`);
    const tempDir = join(tempBase, skillName);
    mkdirSync(tempDir, { recursive: true });

    try {
      // Write files to temp directory
      for (const file of files) {
        const filePath = join(tempDir, file.path);
        const fileDir = join(filePath, '..');
        mkdirSync(fileDir, { recursive: true });
        writeFileSync(filePath, file.content, 'utf-8');
      }

      // Create tar.gz
      const archivePath = join(tempBase, `${skillName}.tar.gz`);
      await tar.create(
        {
          gzip: true,
          file: archivePath,
          cwd: tempBase,
        },
        [skillName]
      );

      const { readFileSync } = await import('fs');
      return readFileSync(archivePath);
    } finally {
      // Clean up temp directory
      rmSync(tempBase, { recursive: true, force: true });
    }
  }
}
