import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  extractManifestErrorCode,
  formatManifestError,
  MANIFEST_ERRORS,
  MANIFEST_ERRORS_DOCS_BASE,
  ManifestErrorCode,
} from '../error-codes';

describe('MANIFEST_ERRORS registry', () => {
  it('exposes the public docs base URL', () => {
    expect(MANIFEST_ERRORS_DOCS_BASE).toBe(
      'https://github.com/faisalahammad/tiergate/blob/main/docs/errors.md',
    );
    expect(formatManifestError('M100')).toContain(
      'https://github.com/faisalahammad/tiergate/blob/main/docs/errors.md#m100',
    );
  });

  it('every code has a non-empty title and template', () => {
    for (const [code, entry] of Object.entries(MANIFEST_ERRORS)) {
      expect(entry.title).toBeTruthy();
      expect(entry.template).toBeTruthy();
      expect(code).toMatch(/^M\d{3}$/);
    }
  });

  it('documents every code in docs/errors.md', () => {
    const docs = readFileSync(resolve(__dirname, '../../../../../../docs/errors.md'), 'utf8');
    for (const code of Object.keys(MANIFEST_ERRORS)) {
      expect(docs).toMatch(new RegExp(`^## ${code}$`, 'm'));
    }
  });

  it('every code is unique', () => {
    const codes = Object.keys(MANIFEST_ERRORS);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('TierGate prefix', () => {
  it('writes the TierGate prefix', () => {
    expect(formatManifestError('M300')).toMatch(/^\[🦚 TierGate M300\]/);
  });

  it('still reads rows stored with the Manifest prefix', () => {
    expect(extractManifestErrorCode('[🦚 Manifest M100] x')).toBe('M100');
    expect(extractManifestErrorCode('[🦚 TierGate M100] x')).toBe('M100');
  });
});

describe('formatManifestError', () => {
  it('wraps a static template with the peacock prefix and docs URL', () => {
    const out = formatManifestError('M001');
    expect(out).toContain('[🦚 TierGate M001]');
    expect(out).toContain('Missing the Authorization header');
    expect(out).toContain(
      'https://github.com/faisalahammad/tiergate/blob/main/docs/errors.md#m001',
    );
  });

  it('interpolates {var} placeholders from the vars object', () => {
    const out = formatManifestError('M100', {
      provider: 'anthropic',
      dashboardUrl: 'https://dash.example/x',
    });
    expect(out).toContain('No anthropic API key yet');
    expect(out).toContain('https://dash.example/x');
    expect(out).not.toContain('{provider}');
    expect(out).not.toContain('{dashboardUrl}');
  });

  it('leaves placeholders untouched when a var is missing', () => {
    const out = formatManifestError('M100', { provider: 'openai' });
    expect(out).toContain('No openai API key yet');
    expect(out).toContain('{dashboardUrl}');
  });

  it('renders M101 as a missing default model, not missing providers (#2942)', () => {
    const out = formatManifestError('M101', { dashboardUrl: 'https://dash.example/routing' });
    expect(out).toContain('[🦚 TierGate M101]');
    expect(out).toContain('This harness has no model to route to yet. Pick a default model here');
    expect(out).toContain('https://dash.example/routing');
  });

  it('renders M102 for unusable subscription credentials', () => {
    const out = formatManifestError('M102', {
      provider: 'openai',
      dashboardUrl: 'https://dash.example/routing',
    });
    expect(out).toContain('[🦚 TierGate M102]');
    expect(out).toContain('openai subscription credentials could not be refreshed');
    expect(out).toContain('https://dash.example/routing');
  });

  it('appends the docs URL exactly once', () => {
    const out = formatManifestError('M500');
    const matches = out.match(/\/docs\/errors\.md#m500/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('produces a stable output for every registered code', () => {
    for (const code of Object.keys(MANIFEST_ERRORS) as ManifestErrorCode[]) {
      const out = formatManifestError(code);
      expect(out.startsWith(`[🦚 TierGate ${code}]`)).toBe(true);
      expect(out.endsWith(`See ${MANIFEST_ERRORS_DOCS_BASE}#${code.toLowerCase()}`)).toBe(true);
    }
  });
});

describe('extractManifestErrorCode', () => {
  it('returns null for empty or non-Manifest text', () => {
    expect(extractManifestErrorCode(null)).toBeNull();
    expect(extractManifestErrorCode(undefined)).toBeNull();
    expect(extractManifestErrorCode('')).toBeNull();
    expect(extractManifestErrorCode('upstream 500')).toBeNull();
    expect(extractManifestErrorCode('[TierGate M999] unknown')).toBeNull();
    // A provider body that echoes the code text without the peacock must NOT
    // be mistaken for a Manifest error (guards against provider-error mislabeling).
    expect(extractManifestErrorCode('[TierGate M100] echoed by an upstream')).toBeNull();
    expect(extractManifestErrorCode('provider said: TierGate M102 somewhere')).toBeNull();
  });

  it('extracts the code from a formatted peacock message', () => {
    expect(extractManifestErrorCode(formatManifestError('M102', { provider: 'openai' }))).toBe(
      'M102',
    );
    expect(
      extractManifestErrorCode('[🦚 TierGate M100] No openai API key yet. Add one here: https://x'),
    ).toBe('M100');
  });

  it('finds the code when nested inside a JSON error body', () => {
    const body = JSON.stringify({
      error: {
        message: formatManifestError('M102', {
          provider: 'openai',
          dashboardUrl: 'https://dash/routing',
        }),
      },
    });
    expect(extractManifestErrorCode(body)).toBe('M102');
  });

  it('round-trips every registered code', () => {
    for (const code of Object.keys(MANIFEST_ERRORS) as ManifestErrorCode[]) {
      expect(extractManifestErrorCode(formatManifestError(code))).toBe(code);
    }
  });
});
