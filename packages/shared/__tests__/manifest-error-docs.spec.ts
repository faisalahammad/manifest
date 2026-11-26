import { MANIFEST_ERRORS_DOCS_BASE, manifestErrorDocsUrl } from '../src/manifest-error-docs';

describe('manifest error docs', () => {
  it('points at the public error documentation', () => {
    expect(MANIFEST_ERRORS_DOCS_BASE).toBe(
      'https://github.com/faisalahammad/tiergate/blob/main/docs/errors.md',
    );
  });

  it('deep links a code to its own page', () => {
    expect(manifestErrorDocsUrl('M100')).toBe(
      'https://github.com/faisalahammad/tiergate/blob/main/docs/errors.md#m100',
    );
    expect(manifestErrorDocsUrl('M300')).toBe(
      'https://github.com/faisalahammad/tiergate/blob/main/docs/errors.md#m300',
    );
  });
});
