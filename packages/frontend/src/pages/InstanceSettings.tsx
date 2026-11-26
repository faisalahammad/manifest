import { createResource, createSignal, For, Show, type Component } from 'solid-js';
import { Title } from '@solidjs/meta';
import { LOG_RETENTION_DAY_OPTIONS } from 'manifest-shared';
import {
  getInstanceSettings,
  updateInstanceSettings,
  type InstanceSettings as Settings,
} from '../services/api/admin.js';
import { toast } from '../services/toast-store.js';

const FOREVER = 'forever';

function retentionLabel(days: number | null): string {
  if (days === null) return 'Keep forever';
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * Instance-wide settings of a self-hosted install. Only the super admin (the
 * first user who signed up) can load them; the backend refuses everyone else.
 */
const InstanceSettings: Component = () => {
  const [settings, { mutate }] = createResource(getInstanceSettings);
  const [saving, setSaving] = createSignal(false);

  const ready = () => !settings.loading && !settings.error && settings() !== undefined;
  const busy = () => saving() || !ready();

  const save = async (patch: Partial<Settings>, message: string) => {
    setSaving(true);
    try {
      mutate(await updateInstanceSettings(patch));
      toast.success(message);
    } catch {
      // fetchMutate already shows the backend error.
    } finally {
      setSaving(false);
    }
  };

  // The switch is disabled while busy, so no click arrives mid-save.
  const toggleSignup = () => {
    const next = !settings()!.signupEnabled;
    void save({ signupEnabled: next }, next ? 'Sign-up turned on' : 'Sign-up turned off');
  };

  const changeRetention = (select: HTMLSelectElement) => {
    const current = settings()!.logRetentionDays;
    const next = select.value === FOREVER ? null : Number(select.value);
    const shorter = next !== null && (current === null || next < current);
    if (
      shorter &&
      !confirm(
        `Requests older than ${retentionLabel(next)} will be deleted in the next nightly cleanup. This cannot be undone. Continue?`,
      )
    ) {
      select.value = current === null ? FOREVER : String(current);
      return;
    }
    void save(
      { logRetentionDays: next },
      `Log retention set to ${retentionLabel(next).toLowerCase()}`,
    );
  };

  return (
    <div class="container--sm">
      <Title>Instance settings - TierGate</Title>
      <div class="page-header">
        <div>
          <h1 class="page-header__title">Instance settings</h1>
          <p class="page-header__subtitle">
            Settings for this whole TierGate install. Only the super admin can see this page.
          </p>
        </div>
      </div>

      <Show when={settings.error}>
        <div class="panel">
          <div class="panel__title">Not available</div>
          <p class="integration-panel__desc" style="margin-bottom: 0;">
            Only the super admin of a self-hosted TierGate install can manage instance settings. The
            super admin is the first person who signed up.
          </p>
        </div>
      </Show>

      <Show when={!settings.error}>
        <h2 class="settings-section__title">Sign-up</h2>
        <div class="settings-card">
          <div class="settings-card__row">
            <div class="settings-card__label">
              <span class="settings-card__label-title">Allow new sign-ups</span>
              <span class="settings-card__label-desc">
                When off, nobody new can create an account, with email or with a Google, GitHub or
                Discord login. People who already have an account can still sign in.
              </span>
            </div>
            <div class="settings-card__control settings-card__control--end">
              <button
                type="button"
                role="switch"
                aria-checked={ready() && settings()!.signupEnabled}
                aria-label="Allow new sign-ups"
                class="settings-switch"
                classList={{ 'settings-switch--on': ready() && settings()!.signupEnabled }}
                disabled={busy()}
                onClick={toggleSignup}
              >
                <span class="settings-switch__track">
                  <span class="settings-switch__thumb" />
                </span>
              </button>
            </div>
          </div>
        </div>

        <h2 class="settings-section__title">Log retention</h2>
        <div class="settings-card">
          <div class="settings-card__row">
            <div class="settings-card__label">
              <label class="settings-card__label-title" for="log-retention-select">
                Keep requests for
              </label>
              <span class="settings-card__label-desc">
                Requests, their provider attempts and their logs older than this are deleted every
                night at 3 AM server time. Deleted requests cannot be recovered, and charts only
                show the days that are kept.
              </span>
            </div>
            <div class="settings-card__control settings-card__control--end">
              <select
                id="log-retention-select"
                class="select"
                value={
                  ready() && settings()!.logRetentionDays !== null
                    ? String(settings()!.logRetentionDays)
                    : FOREVER
                }
                disabled={busy()}
                onChange={(e) => changeRetention(e.currentTarget)}
              >
                <option value={FOREVER}>{retentionLabel(null)}</option>
                <For each={LOG_RETENTION_DAY_OPTIONS}>
                  {(days) => <option value={String(days)}>{retentionLabel(days)}</option>}
                </For>
              </select>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default InstanceSettings;
