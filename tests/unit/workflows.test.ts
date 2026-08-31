import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('repository workflows', () => {
  it('deploys Pages from the validated CI build', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

    expect(existsSync(resolve(root, '.github/workflows/pages.yml'))).toBe(
      false,
    );
    expect(ci).toContain('actions/upload-pages-artifact@');
    expect(ci).toContain('deploy-pages:');
    expect(ci).toContain('needs: [quality, browser, contract-parity]');
    expect(ci).toContain('group: pages');
    expect(ci).toContain('VITE_PUBLISHER_REF: ${{ github.sha }}');
  });
});
