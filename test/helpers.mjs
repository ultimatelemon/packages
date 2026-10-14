// Minimal, dependency-free helpers for asserting on the structure of this
// repo's GitHub Actions YAML files.
//
// This is deliberately NOT a general YAML parser. These workflow files use
// a small, consistent subset of YAML (block mappings, block sequences and
// flow scalars like "{}"). A tiny, purpose-built reader for that subset is
// more robust here than depending on a full YAML library, and needs no
// `npm install` to run: these files run with Node's built-in test runner,
// via `npm run test` or directly with `node --test test/`.
//
// This file intentionally mirrors the equivalent helper in
// ultimatelemon/shared-actions/test/helpers.mjs, which is the only existing
// precedent for testing workflow YAML in this organization. It is kept as a
// local, repo-scoped copy rather than a cross-repo import so this repo's
// tests do not depend on shared-actions being checked out alongside it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');

export function repoPath(relPath) {
  return path.join(REPO_ROOT, relPath);
}

export function readRepoFile(relPath) {
  return fs.readFileSync(repoPath(relPath), 'utf8');
}

export function lines(text) {
  return text.split(/\r?\n/);
}

function indentOf(line) {
  const m = /^( *)/.exec(line);
  return m[1].length;
}

function isBlankOrComment(line) {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** Indentation of the first non-blank, non-comment line, or 0 if there is none. */
function baseIndentOf(allLines) {
  for (const l of allLines) {
    if (!isBlankOrComment(l)) return indentOf(l);
  }
  return 0;
}

/**
 * Finds the line that declares `${keyName}:` as a *direct child* of the
 * given lines, i.e. at the same indentation as the first non-blank line in
 * `allLines`. Not "the first line matching /keyName:/ anywhere" — a
 * workflow can legitimately contain the same key name at two depths (e.g.
 * a top-level `permissions:` versus a job's own `permissions:`).
 */
export function findKeyIndex(
  allLines,
  keyName,
  { from = 0, to = allLines.length } = {}
) {
  const indent = baseIndentOf(allLines.slice(from, to));
  const re = new RegExp(`^ {${indent}}${escapeRegExp(keyName)}:(.*)$`);
  for (let i = from; i < to; i++) {
    if (re.test(allLines[i])) return i;
  }
  return -1;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Given the index of a "key:" line, returns the lines that make up its
 * nested block: every following blank/comment line, or any line indented
 * strictly more than the key line, stopping at the first shallower-or-equal
 * non-blank/non-comment line (a sibling key) or EOF.
 */
export function blockAfter(allLines, keyIndex) {
  const parentIndent = indentOf(allLines[keyIndex]);
  const block = [];
  let end = keyIndex + 1;
  for (; end < allLines.length; end++) {
    const line = allLines[end];
    if (isBlankOrComment(line)) {
      block.push(line);
      continue;
    }
    if (indentOf(line) <= parentIndent) break;
    block.push(line);
  }
  return {
    lines: block,
    text: block.join('\n'),
    endIndex: end,
    indent: parentIndent
  };
}

function inlineValueOf(line, keyName) {
  const re = new RegExp(`^\\s*${escapeRegExp(keyName)}:(.*)$`);
  const m = re.exec(line);
  if (!m) return undefined;
  return m[1].trim();
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Finds `keyName:` within `text` (the first direct-child match) and returns
 * its scalar value as a plain string (inline value on the same line, or a
 * joined nested block). Returns `undefined` if the key is not found.
 */
export function getValue(text, keyName) {
  const allLines = lines(text);
  const idx = findKeyIndex(allLines, keyName);
  if (idx === -1) return undefined;
  const inline = inlineValueOf(allLines[idx], keyName);
  if (inline) {
    return stripQuotes(inline);
  }
  const { lines: blockLines } = blockAfter(allLines, idx);
  const nonEmpty = blockLines.filter((l) => l.trim() !== '');
  if (nonEmpty.length === 0) return '';
  return nonEmpty.map((l) => l.trim()).join(' ');
}

/**
 * Returns the raw nested block text for `keyName` (its children), without
 * collapsing it to a scalar. Returns `null` if the key is not found, or if
 * the key has only an inline (flow) value such as `permissions: {}` (use
 * `getValue` for that case instead).
 */
export function getBlock(text, keyName) {
  const allLines = lines(text);
  const idx = findKeyIndex(allLines, keyName);
  if (idx === -1) return null;
  const inline = inlineValueOf(allLines[idx], keyName);
  if (inline) return null;
  return blockAfter(allLines, idx).text;
}

/**
 * Slices out a named top-level job from a workflow's "jobs:" mapping: the
 * block indented under "  <jobName>:", up to (not including) the next
 * sibling job at the same indentation, or EOF. Returns `null` if either
 * "jobs:" or the job itself is missing.
 */
export function getJobBlock(workflowText, jobName) {
  const jobsBlock = getBlock(workflowText, 'jobs');
  if (jobsBlock === null) return null;
  const jobLines = lines(jobsBlock);
  const idx = findKeyIndex(jobLines, jobName);
  if (idx === -1) return null;
  return blockAfter(jobLines, idx).text;
}

/** Index (0-based) of the line matching a direct top-level "keyName:", or -1. */
export function topLevelKeyLineIndex(allLines, keyName) {
  return findKeyIndex(allLines, keyName, { from: 0, to: allLines.length });
}
