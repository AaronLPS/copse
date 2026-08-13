import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rulesetPayload } from '../src/protection.mjs';
import { commandProtect } from '../src/commands/protect.mjs';

test('ruleset protects base and release branches and requires copse verify', () => {
  const payload = rulesetPayload({ baseBranch: 'devel', releaseBranch: 'main' });
  assert.deepEqual(payload.conditions.ref_name.include, ['refs/heads/devel', 'refs/heads/main']);
  assert.ok(payload.rules.some((rule) => rule.type === 'pull_request'));
  assert.ok(payload.rules.some((rule) => rule.type === 'required_status_checks'));
  assert.ok(payload.rules.some((rule) => rule.type === 'non_fast_forward'));
  assert.ok(payload.rules.some((rule) => rule.type === 'deletion'));
});

test('protect updates the existing named ruleset instead of creating a duplicate', () => {
  const calls = [];
  const responses = [
    { ok: true, status: 0, stdout: 'org/repo\n', stderr: '' },
    { ok: true, status: 0, stdout: '[{"id":42,"name":"copse protected branches"}]', stderr: '' },
    { ok: true, status: 0, stdout: '{}', stderr: '' },
  ];
  commandProtect({ config: { baseBranch: 'main', releaseBranch: null }, apply: true, run(command, args, options) { calls.push({ command, args, options }); return responses.shift(); } });
  assert.deepEqual(calls[2].args.slice(0, 4), ['api', '--method', 'PUT', 'repos/org/repo/rulesets/42']);
});
