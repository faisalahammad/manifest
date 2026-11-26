import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@solidjs/testing-library';

vi.mock('@solidjs/meta', () => ({
  Title: (props: { children?: unknown }) => <title>{String(props.children ?? '')}</title>,
  Meta: () => null,
}));

import Cli, { loginCommand } from '../../src/pages/integrations/Cli';

describe('loginCommand', () => {
  it('pins the host of any other install', () => {
    expect(loginCommand('https://llm.acme.internal')).toBe(
      'mnfst login --url https://llm.acme.internal',
    );
  });

  it('omits the flag only on the host the published CLI defaults to', () => {
    expect(loginCommand('https://app.manifest.build')).toBe('mnfst login');
  });
});

describe('CLI page', () => {
  it('shows the npm install for the published package', () => {
    const { container } = render(() => <Cli />);
    expect(container.textContent).toContain('npm install -g mnfst-gateway-cli');
  });

  it('always names this host in the login command', async () => {
    const { container } = render(() => <Cli />);
    await waitFor(() =>
      expect(container.textContent).toContain(`mnfst login --url ${window.location.origin}`),
    );
  });

  it('links to the command reference', () => {
    const { container } = render(() => <Cli />);
    const link = container.querySelector(
      'a[href="https://github.com/faisalahammad/tiergate/blob/main/packages/cli/README.md"]',
    );
    expect(link).not.toBeNull();
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('links Vibe Code users to MCP setup', () => {
    const { getByRole } = render(() => <Cli />);
    expect(getByRole('link', { name: 'MCP setup' }).getAttribute('href')).toBe('/integrations/mcp');
  });
});
