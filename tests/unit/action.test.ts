import { execFileSync } from 'node:child_process';
import {
  existsSync,
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

describe('bundled publishing action', () => {
  it('packages a published stable release and emits catalog assets', () => {
    temporary = mkdtempSync(join(tmpdir(), 'vanahub-action-'));
    mkdirSync(join(temporary, '.vanahub'));
    writeFileSync(join(temporary, 'sample.lua'), 'return true\n');
    writeFileSync(
      join(temporary, '.vanahub', 'package.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'sample',
        name: 'Sample',
        description: 'Sample addon',
        author: 'Author',
        sourcePath: '.',
        declaredCapabilities: [],
      }),
    );
    writeFileSync(
      join(temporary, '.vanahub.json'),
      JSON.stringify({
        schemaVersion: 1,
        packages: { sample: { maintainers: ['author'] } },
      }),
    );
    const eventPath = join(temporary, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({
        release: {
          tag_name: 'v1.2.3',
          body: 'Release notes',
          draft: false,
          prerelease: false,
        },
      }),
    );
    execFileSync('node', ['dist-action/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GITHUB_WORKSPACE: temporary,
        GITHUB_REPOSITORY: 'author/sample',
        GITHUB_EVENT_PATH: eventPath,
      },
      stdio: 'inherit',
    });
    const output = join(temporary, '.vanahub-output');
    expect(existsSync(join(output, 'sample-1.2.3.zip'))).toBe(true);
    expect(existsSync(join(output, 'validation-report.json'))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(output, 'vanahub-manifest.json'), 'utf8'),
    );
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.downloadUrl).toContain(
      '/releases/download/v1.2.3/sample-1.2.3.zip',
    );
  });
});
