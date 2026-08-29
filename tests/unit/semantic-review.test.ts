import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let temporary = '';
afterEach(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  temporary = '';
});

function fixture(risk: 'elevated' | 'critical') {
  temporary = mkdtempSync(join(tmpdir(), 'vanahub-semantic-review-'));
  const source = join(temporary, 'addon');
  const output = join(temporary, 'output');
  mkdirSync(source);
  const lua = "os.execute('calc')\n";
  writeFileSync(join(source, 'sample.lua'), lua);
  const fakeSemgrep = join(temporary, 'semgrep');
  writeFileSync(
    fakeSemgrep,
    `#!/usr/bin/env python3
import json,sys
output=sys.argv[sys.argv.index('--json-output')+1]
source=sys.argv[-1]
json.dump({'results':[{'check_id':'vanahub.lua.process-execution','path':source+'/sample.lua','start':{'line':1},'extra':{'message':'process execution','metadata':{'capability':'process-execution','vanahub_risk':'${risk}'}}}], 'errors':[{'path':source+'/sample.lua','message':'partial parse','spans':[{'start':{'line':1}}]}]},open(output,'w'))
`,
  );
  chmodSync(fakeSemgrep, 0o755);
  return { source, output, lua, fakeSemgrep };
}

function run(
  values: ReturnType<typeof fixture>,
  baseline = '',
): { stderr: string; status: number } {
  try {
    execFileSync(
      'python3',
      [
        'review/review_gate.py',
        '--semgrep',
        values.fakeSemgrep,
        '--rules',
        'review/rules/vanahub-lua.yml',
        '--source',
        values.source,
        '--package-id',
        'sample',
        '--baseline',
        baseline,
        '--output-directory',
        values.output,
      ],
      { cwd: process.cwd(), stdio: 'pipe' },
    );
    return { stderr: '', status: 0 };
  } catch (error) {
    const result = error as { status?: number; stderr?: Buffer };
    return { stderr: String(result.stderr || ''), status: result.status || 1 };
  }
}

describe('semantic review gate', () => {
  it('emits a candidate and accepts an exact reviewed-file hash', () => {
    const values = fixture('elevated');
    expect(run(values).status).toBe(1);
    const candidate = JSON.parse(
      readFileSync(
        join(values.output, 'semantic-review-candidate.json'),
        'utf8',
      ),
    );
    expect(candidate.files).toEqual({
      'sample.lua': createHash('sha256').update(values.lua).digest('hex'),
    });
    expect(candidate.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'semgrep.parse-error' }),
    );
    const baseline = join(temporary, 'baseline.json');
    writeFileSync(baseline, JSON.stringify(candidate));
    expect(run(values, baseline).status).toBe(0);
  });

  it('never accepts a critical finding from a baseline', () => {
    const values = fixture('critical');
    const baseline = join(temporary, 'baseline.json');
    writeFileSync(
      baseline,
      JSON.stringify({
        schemaVersion: 1,
        packageId: 'sample',
        reviewedCommit: 'a'.repeat(40),
        files: {
          'sample.lua': createHash('sha256').update(values.lua).digest('hex'),
        },
      }),
    );
    expect(run(values, baseline).status).toBe(1);
  });
});
