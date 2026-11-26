import type { Component } from 'solid-js';
import { Title, Meta } from '@solidjs/meta';
import CodeBlock from '../../components/CodeBlock.jsx';
import { installOrigin } from '../../services/install-endpoints.js';

const DOCS_URL = 'https://github.com/faisalahammad/tiergate/blob/main/packages/cli/README.md';
const PACKAGE = 'mnfst-gateway-cli';

/**
 * The CLI has to be told which host to talk to, and this dashboard is the only
 * place that knows it. The published CLI defaults to `app.manifest.build`, so
 * only that host may omit the flag.
 */
export function loginCommand(origin: string): string {
  return origin === 'https://app.manifest.build' ? 'mnfst login' : `mnfst login --url ${origin}`;
}

const EXAMPLE = `mnfst agent create --name coding-assistant --platform openclaw
mnfst provider connect xai --auth-type api_key --credential-env XAI_API_KEY
mnfst agent configure coding-assistant --models grok-4.5,grok-4 --provider xai
mnfst routing test coding-assistant`;

const Cli: Component = () => {
  const login = () => loginCommand(installOrigin());

  return (
    <div class="container--lg">
      <Title>CLI - TierGate</Title>
      <Meta
        name="description"
        content="Install the mnfst CLI and manage harnesses, providers, routing and request logs from the terminal."
      />
      <div class="page-header">
        <div>
          <h1 class="page-header__title">CLI</h1>
          <p class="page-header__subtitle">
            Everything the dashboard does, from a terminal, a script, or a coding agent
          </p>
        </div>
      </div>

      <div class="integration-grid">
        <div class="panel">
          <div class="panel__title">1. Install</div>
          <p class="integration-panel__desc">
            The package is <code>mnfst-gateway-cli</code>, but the command you type is{' '}
            <code>mnfst</code>. Its version tracks the TierGate release it ships with.
          </p>
          <CodeBlock code={`npm install -g ${PACKAGE}`} language="bash" />
        </div>

        <div class="panel">
          <div class="panel__title">2. Sign in</div>
          <p class="integration-panel__desc">
            This opens your browser, you approve, and the CLI stores a token for this host. The
            token never travels through the URL.
          </p>
          <CodeBlock code={login()} language="bash" />
        </div>
      </div>

      <div class="panel" style="margin-top: var(--gap-lg);">
        <div class="integration-panel__header">
          <div class="panel__title">3. Drive it</div>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn--outline btn--sm"
            style="text-decoration: none;"
          >
            All commands
          </a>
        </div>
        <p class="integration-panel__desc">
          Create a harness, connect a provider, set a route, and prove it works with one real
          request.
        </p>
        <CodeBlock code={EXAMPLE} language="bash" />
        <p class="integration-panel__desc" style="margin-top: var(--gap-md); margin-bottom: 0;">
          To use TierGate tools in Vibe Code, follow the <a href="/integrations/mcp">MCP setup</a>.
        </p>
      </div>
    </div>
  );
};

export default Cli;
