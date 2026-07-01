import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Canonical Veoable skill description, loaded from SKILL.md at the
 * package root. This is the source of truth for per-client adapters
 * (Claude Code, Cursor, Continue, ChatGPT, ...) — each one embeds or
 * references this content. Mid-session, the `describe_skill` MCP tool
 * returns this string so agents can self-orient without restarting.
 *
 * Loaded lazily on first access so importing this package doesn't pay
 * file I/O until the content is actually needed.
 */

const SKILL_MD_FILENAME = 'SKILL.md';

let cachedMarkdown: string | null = null;
let cachedDescription: string | null = null;

/**
 * Returns the SKILL.md content. The first call reads from disk; subsequent
 * calls return the cached string.
 */
export function getSkillMarkdown(): string {
  if (cachedMarkdown !== null) return cachedMarkdown;
  const here = fileURLToPath(import.meta.url);
  // tsup outputs a flat dist/index.js, so SKILL.md sits one directory up.
  const skillPath = path.resolve(path.dirname(here), '..', SKILL_MD_FILENAME);
  cachedMarkdown = readFileSync(skillPath, 'utf-8');
  return cachedMarkdown;
}

/**
 * Returns the one-line skill description extracted from SKILL.md's YAML
 * frontmatter. This is what shows up in skill marketplaces and per-client
 * discovery listings (Claude Code skill description, Cursor rule header).
 *
 * Parsed from the markdown at load time rather than duplicated as a
 * constant — editing the frontmatter automatically updates everything
 * downstream, no drift between sources of truth.
 */
export function getSkillDescription(): string {
  if (cachedDescription !== null) return cachedDescription;
  const md = getSkillMarkdown();
  const frontmatter = md.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) {
    throw new Error('SKILL.md is missing YAML frontmatter');
  }
  const descLine = frontmatter[1].match(/^description:\s*(.+)$/m);
  if (!descLine) {
    throw new Error('SKILL.md frontmatter is missing the description field');
  }
  cachedDescription = descLine[1].trim();
  return cachedDescription;
}

/** Skill identifier — used as the name in per-client adapter configs. */
export const SKILL_NAME = 'veoable';
