import type { Component } from 'solid-js';
import { Title, Meta } from '@solidjs/meta';

const Help: Component = () => {
  return (
    <div class="container--sm">
      <Title>Help & Support - TierGate</Title>
      <Meta name="description" content="Get help with TierGate." />
      <div class="page-header">
        <div>
          <h1>Help & Support</h1>
          <span class="breadcrumb">Questions or issues? Open an issue on GitHub</span>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card__row">
          <div class="settings-card__label">
            <span class="settings-card__label-title">Support</span>
            <span class="settings-card__label-desc">Open an issue on GitHub.</span>
          </div>
          <div class="settings-card__control">
            <a
              href="https://github.com/faisalahammad/tiergate/issues"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn--outline btn--sm"
              style="text-decoration: none;"
            >
              Contact
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                style="margin-left: 4px;"
                aria-hidden="true"
              >
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Help;
