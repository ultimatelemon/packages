// Structural tests for .github/workflows/code-quality.yml against card
// INF-44.
//
// INF-44 requires this thin wrapper around the reusable
// ultimatelemon/shared-actions node-quality workflow to:
//   1. declare a top-level `permissions: {}` block, right after `on:` (with
//      a blank line before and after it), before `concurrency:`, with no
//      comment attached;
//   2. give the `quality` job its own `permissions: { contents: read }`,
//      as a sibling of its `uses:` line;
//   3. leave the `uses:` line, the `on:` block and the `concurrency:` block
//      byte-for-byte unchanged.
//
// These are structural/data tests on the YAML text itself (no workflow
// runner is available in this environment) and are written from the
// acceptance criteria, not from today's implementation.
//
// Run with: node --test test/code-quality-workflow.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readRepoFile,
  lines,
  getBlock,
  getValue,
  getJobBlock,
  topLevelKeyLineIndex
} from './helpers.mjs';

const WORKFLOW_PATH = '.github/workflows/code-quality.yml';
const workflow = readRepoFile(WORKFLOW_PATH);
const allLines = lines(workflow);

describe('code-quality.yml: top-level permissions block (AC1)', () => {
  test('declares a top-level "permissions: {}" (empty object, no scopes)', () => {
    const idx = topLevelKeyLineIndex(allLines, 'permissions');
    assert.notEqual(idx, -1, 'expected a top-level "permissions:" key');
    assert.equal(
      allLines[idx].trim(),
      'permissions: {}',
      'expected the top-level permissions block to be exactly "permissions: {}"'
    );
  });

  test('is a single top-level occurrence (no duplicate top-level permissions keys)', () => {
    const topLevelPermissionsLines = allLines.filter((l) =>
      /^permissions:/.test(l)
    );
    assert.equal(
      topLevelPermissionsLines.length,
      1,
      `expected exactly one top-level "permissions:" line, found: ${JSON.stringify(topLevelPermissionsLines)}`
    );
  });

  test('has a blank line immediately before and after it', () => {
    const idx = topLevelKeyLineIndex(allLines, 'permissions');
    assert.notEqual(idx, -1, 'expected a top-level "permissions:" key');
    assert.equal(
      allLines[idx - 1]?.trim(),
      '',
      'expected a blank line directly before the permissions block'
    );
    assert.equal(
      allLines[idx + 1]?.trim(),
      '',
      'expected a blank line directly after the permissions block'
    );
  });

  test('is not accompanied by any comment', () => {
    const idx = topLevelKeyLineIndex(allLines, 'permissions');
    assert.notEqual(idx, -1, 'expected a top-level "permissions:" key');
    assert.ok(
      !allLines[idx].includes('#'),
      'the permissions line itself must not carry a trailing comment'
    );
    assert.ok(
      !allLines[idx - 1]?.trim().startsWith('#'),
      'the line before permissions must not be a comment'
    );
    assert.ok(
      !allLines[idx + 1]?.trim().startsWith('#'),
      'the line after permissions must not be a comment'
    );
  });

  test('sits after the "on:" block and before "concurrency:"', () => {
    const permIdx = topLevelKeyLineIndex(allLines, 'permissions');
    const onIdx = topLevelKeyLineIndex(allLines, 'on');
    const concurrencyIdx = topLevelKeyLineIndex(allLines, 'concurrency');
    assert.notEqual(permIdx, -1, 'expected a top-level "permissions:" key');
    assert.notEqual(onIdx, -1, 'expected a top-level "on:" key');
    assert.notEqual(
      concurrencyIdx,
      -1,
      'expected a top-level "concurrency:" key'
    );
    assert.ok(permIdx > onIdx, 'permissions must come after the on: block');
    assert.ok(
      permIdx < concurrencyIdx,
      'permissions must come before the concurrency: block'
    );
  });
});

describe('code-quality.yml: "quality" job permissions (AC2)', () => {
  const job = getJobBlock(workflow, 'quality');

  test('job block exists', () => {
    assert.ok(job, 'expected a top-level "quality" job');
  });

  test('declares permissions as a sibling of "uses:", scoped to contents: read only', () => {
    assert.ok(job, 'job missing');
    const permissions = getBlock(job, 'permissions');
    assert.ok(permissions, 'expected a "permissions:" key on the quality job');
    assert.equal(getValue(permissions, 'contents'), 'read');

    // Only one scope: no other keys besides "contents" inside the block.
    const nonEmptyLines = lines(permissions).filter((l) => l.trim() !== '');
    assert.equal(
      nonEmptyLines.length,
      1,
      `expected exactly one scope (contents: read) under the job's permissions, got: ${JSON.stringify(nonEmptyLines)}`
    );
  });

  test('does not grant any scope other than contents:read', () => {
    assert.ok(job, 'job missing');
    const permissions = getBlock(job, 'permissions');
    assert.ok(permissions, 'expected a "permissions:" key on the quality job');
    assert.doesNotMatch(
      permissions,
      /write|actions:|packages:|issues:|pull-requests:|id-token:|checks:|deployments:|statuses:/,
      'the job must not be granted any scope beyond contents: read'
    );
  });
});

describe('code-quality.yml: unchanged parts (AC3)', () => {
  const job = getJobBlock(workflow, 'quality');

  test('the "uses:" reference to node-quality.yml@v1 is unchanged', () => {
    assert.ok(job, 'job missing');
    assert.equal(
      getValue(job, 'uses'),
      'ultimatelemon/shared-actions/.github/workflows/node-quality.yml@v1'
    );
  });

  test('the "on:" block (triggers) is unchanged', () => {
    const onBlock = getBlock(workflow, 'on');
    assert.ok(onBlock, 'expected an "on:" block');
    const pushBlock = getBlock(onBlock, 'push');
    assert.ok(pushBlock, 'expected on.push');
    assert.equal(getValue(pushBlock, 'branches'), '[main]');

    // pull_request has no filters: present as a bare key with an empty body.
    const prLines = lines(onBlock);
    const prIdx = prLines.findIndex((l) => /^\s*pull_request:\s*$/.test(l));
    assert.notEqual(
      prIdx,
      -1,
      'expected a bare "pull_request:" trigger with no filters'
    );
  });

  test('the "concurrency:" block is unchanged', () => {
    const concurrencyBlock = getBlock(workflow, 'concurrency');
    assert.ok(concurrencyBlock, 'expected a "concurrency:" block');
    assert.equal(
      getValue(concurrencyBlock, 'group'),
      'code-quality-${{ github.ref }}'
    );
    assert.equal(getValue(concurrencyBlock, 'cancel-in-progress'), 'true');
  });
});

describe('code-quality.yml: edge cases', () => {
  test('the workflow still parses as exactly one "quality" job under jobs:', () => {
    const jobsBlock = getBlock(workflow, 'jobs');
    assert.ok(jobsBlock, 'expected a "jobs:" block');
    const jobLines = lines(jobsBlock).filter((l) => /^ {2}\S.*:\s*$/.test(l));
    assert.deepEqual(
      jobLines.map((l) => l.trim()),
      ['quality:'],
      'expected exactly one job named "quality"'
    );
  });

  test('the file does not define permissions anywhere outside the top level and the quality job', () => {
    const permissionsLineIndexes = allLines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /^\s*permissions:/.test(l))
      .map(({ i }) => i);
    // Expect exactly two: one top-level, one inside jobs.quality.
    assert.equal(
      permissionsLineIndexes.length,
      2,
      `expected exactly two "permissions:" occurrences (top-level + quality job), found ${permissionsLineIndexes.length}`
    );
  });
});
