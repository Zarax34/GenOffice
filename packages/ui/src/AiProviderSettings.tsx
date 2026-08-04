import { useState } from 'react'
import type {
  AiProviderConfig,
  AiProviderId,
  AiProviderMeta,
  AiSettings,
} from '@genoffice/ai-provider'
import { AI_PROVIDERS } from '@genoffice/ai-provider'

export interface AiProviderSettingsProps {
  /** Current AI settings (provider + per-provider config). */
  settings: AiSettings
  /** Called with the fully merged settings whenever the user edits a field. */
  onChange: (settings: AiSettings) => void
  /** Optional hint shown under the Genspark tab (e.g. "sign in required" text). */
  gensparkHint?: string
}

/**
 * Shared, provider-agnostic AI settings editor. Renders one tab per known
 * provider (see @genoffice/ai-provider AI_PROVIDERS metadata) and lets the
 * user pick a provider and configure its API key, model, and base URL (for
 * the OpenAI-compatible "custom" provider). Pure controlled component: it has
 * no I/O of its own — the parent owns persistence (e.g. via ai:set-settings).
 */
export function AiProviderSettings({
  settings,
  onChange,
  gensparkHint,
}: AiProviderSettingsProps) {
  const selected = settings.provider

  const selectProvider = (id: AiProviderId) => {
    if (id === selected) return
    onChange({ ...settings, provider: id })
  }

  const updateConfig = (id: AiProviderId, patch: Partial<AiProviderConfig>) => {
    const providers = {
      ...settings.providers,
      [id]: { ...settings.providers[id], ...patch },
    }
    onChange({ ...settings, providers })
  }

  return (
    <div className="ai-settings">
      <div className="provider-tabs" role="tablist" aria-label="AI provider">
        {AI_PROVIDERS.map((meta) => (
          <button
            key={meta.id}
            type="button"
            role="tab"
            aria-selected={selected === meta.id}
            className={`provider-tab${selected === meta.id ? ' provider-tab-active' : ''}`}
            onClick={() => selectProvider(meta.id)}
          >
            {meta.label}
          </button>
        ))}
      </div>

      {AI_PROVIDERS.filter((m) => m.id === selected).map((meta) => (
        <ProviderFields
          key={meta.id}
          meta={meta}
          config={settings.providers[meta.id]}
          gensparkHint={gensparkHint}
          onChange={(patch) => updateConfig(meta.id, patch)}
        />
      ))}
    </div>
  )
}

function ProviderFields({
  meta,
  config,
  gensparkHint,
  onChange,
}: {
  meta: AiProviderMeta
  config?: AiProviderConfig
  gensparkHint?: string | undefined
  onChange: (patch: Partial<AiProviderConfig>) => void
}) {
  const apiKey = config?.apiKey ?? ''
  const model = config?.model ?? ''
  const baseUrl = config?.baseUrl ?? ''

  return (
    <div className="ai-settings-fields">
      {meta.id === 'genspark' ? (
        <p className="ai-settings-note">
          {gensparkHint ?? 'Sign in to Genspark — no API key is required.'}
        </p>
      ) : (
        <label className="ai-settings-field">
          <span>API Key</span>
          <input
            type="password"
            value={apiKey}
            placeholder={meta.keyPlaceholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onChange({ apiKey: e.target.value })}
          />
        </label>
      )}

      {meta.models.length > 0 ? (
        <label className="ai-settings-field">
          <span>Model</span>
          <select value={model} onChange={(e) => onChange({ model: e.target.value })}>
            {!meta.models.includes(model) ? (
              <option value={model}>{model || 'Select a model'}</option>
            ) : null}
            {meta.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="ai-settings-field">
          <span>Model</span>
          <input
            value={model}
            placeholder="Model name (OpenAI-compatible)"
            spellCheck={false}
            onChange={(e) => onChange({ model: e.target.value })}
          />
        </label>
      )}

      {meta.needsBaseUrl ? (
        <label className="ai-settings-field">
          <span>Base URL</span>
          <input
            value={baseUrl}
            placeholder="https://api.openai.com/v1"
            spellCheck={false}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
          />
        </label>
      ) : null}
    </div>
  )
}

export default AiProviderSettings
