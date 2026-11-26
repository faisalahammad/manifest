import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@solidjs/testing-library';

vi.mock('@solidjs/router', () => ({
  A: (props: Record<string, unknown>) => {
    const { href, class: className, children, ...rest } = props;
    return (
      <a href={href as string} class={className as string} {...rest}>
        {children}
      </a>
    );
  },
}));

vi.mock('@solidjs/meta', () => ({
  Title: (props: Record<string, unknown>) => <title>{props.children}</title>,
  Meta: () => null,
}));

import Help from '../../src/pages/Help';

describe('Help', () => {
  it('shows Help & Support heading', () => {
    render(() => <Help />);
    expect(screen.getByText('Help & Support')).toBeDefined();
  });

  it('shows the Support section', () => {
    render(() => <Help />);
    expect(screen.getByText('Support')).toBeDefined();
  });

  it('has Contact link', () => {
    render(() => <Help />);
    const links = screen.getAllByRole('link');
    const contactLink = links.find((l) => l.textContent?.includes('Contact'));
    expect(contactLink).toBeDefined();
  });

  it('Contact link opens GitHub issues', () => {
    render(() => <Help />);
    const links = screen.getAllByRole('link');
    const contactLink = links.find((l) => l.textContent?.includes('Contact'));
    expect(contactLink?.getAttribute('href')).toBe(
      'https://github.com/faisalahammad/tiergate/issues',
    );
  });

  it('renders Title metadata', () => {
    const { container } = render(() => <Help />);
    const title = container.querySelector('title');
    expect(title?.textContent).toContain('Help & Support - TierGate');
  });

  it('renders breadcrumb prompt text', () => {
    render(() => <Help />);
    expect(screen.getByText(/Questions or issues\? Open an issue on GitHub/)).toBeDefined();
  });

  it('has no booking link or email address', () => {
    const { container } = render(() => <Help />);
    expect(container.innerHTML).not.toContain('calendly.com');
    expect(container.textContent).not.toContain('@manifest.build');
  });
});
