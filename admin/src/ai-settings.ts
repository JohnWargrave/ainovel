// The DeepSeek settings panel at the top of AI Studio: API key, host, models with their prices and
// the default model per feature. Superadmins edit it; editors see a one-line summary. Also the
// model helpers (labels, cost) the rest of AI Studio uses.
import {
  checkAiKey,
  getAiSettings,
  saveAiSettings,
  type AiKeyCheck,
  type AiModel,
  type AiSettings,
} from './novel-gen-api.js';
import { escapeHtml } from './format.js';

export interface AiSettingsHost {
  run<T>(action: () => Promise<T>, after?: (value: T) => void | Promise<void>): Promise<void>;
  rerender(): void;
  setError(message: string): void;
  isSuperadmin(): boolean;
}

interface Draft {
  apiKey: string;
  baseUrl: string;
  novelModel: string;
  coverModel: string;
  models: AiModel[];
}

interface State {
  settings: AiSettings | null;
  draft: Draft | null;
  dirty: boolean;
  check: AiKeyCheck | null;
  open: boolean;
}

const PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';

const st: State = { settings: null, draft: null, dirty: false, check: null, open: false };
let h: AiSettingsHost | null = null;

function toDraft(settings: AiSettings): Draft {
  return {
    apiKey: '',
    baseUrl: settings.base_url === DEFAULT_BASE_URL ? '' : settings.base_url,
    novelModel: settings.novel_model,
    coverModel: settings.cover_model,
    models: structuredClone(settings.models),
  };
}

function apply(settings: AiSettings): void {
  st.settings = settings;
  st.draft = toDraft(settings);
  st.dirty = false;
}

export async function loadAiSettingsPanel(host: AiSettingsHost): Promise<void> {
  h = host;
  apply(await getAiSettings());
  // Nothing works without a key: show the panel open until there is one.
  st.open = !st.settings?.has_key || Boolean(st.settings?.key_unreadable);
  st.check = null;
}

export function currentAiSettings(): AiSettings | null {
  return st.settings;
}

// ---- Model helpers for AI Studio ----

export function usd(value: number): string {
  if (value === 0) return '$0';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function modelName(model: AiModel): string {
  return model.label ? `${model.label} (${model.id})` : model.id;
}

export function modelOptions(selected: string): string {
  const models = st.settings?.models ?? [];
  const list = models.some((model) => model.id === selected)
    ? models
    : [{ id: selected, label: '', input_cache_hit: 0, input_cache_miss: 0, output: 0 }, ...models];
  return list
    .map(
      (model) =>
        `<option value="${escapeHtml(model.id)}" ${model.id === selected ? 'selected' : ''}>${escapeHtml(modelName(model))} · in ${escapeHtml(usd(model.input_cache_miss))} / out ${escapeHtml(usd(model.output))} per 1M</option>`,
    )
    .join('');
}

// A rough price for writing chapters: the prompt (bible, outline, end of the previous chapter) is
// about 4k tokens, and prose runs about 1.8 tokens a word in Vietnamese. Cache hits make it cheaper.
export function estimateChaptersUsd(
  modelId: string,
  chapters: number,
  words: number,
): number | null {
  const model = st.settings?.models.find((entry) => entry.id === modelId);
  if (!model || chapters <= 0) return null;
  const perChapter = (4000 * model.input_cache_miss + words * 1.8 * model.output) / 1_000_000;
  return perChapter * chapters;
}

// ---- Panel ----

function keySourceText(settings: AiSettings): string {
  if (settings.key_unreadable && settings.key_source !== 'env') {
    return '<span class="cover-ai-error">The saved key can\'t be decrypted on this server (the encryption key changed): enter it again</span>';
  }
  if (settings.key_source === 'cms') {
    return `Saved in the CMS${settings.key_hint ? ` (…${escapeHtml(settings.key_hint)})` : ''}`;
  }
  if (settings.key_source === 'env') {
    return `From the server environment${settings.key_hint ? ` (…${escapeHtml(settings.key_hint)})` : ''}`;
  }
  return '<span class="cover-ai-error">Not set: AI Studio and AI covers are off</span>';
}

export function aiSettingsPanel(): string {
  const settings = st.settings;
  const draft = st.draft;
  if (!settings || !draft) return '';
  if (!h?.isSuperadmin()) {
    return `<article class="panel ai-settings-summary">
      <strong>DeepSeek</strong>
      <span class="muted">${settings.has_key ? 'API key configured' : '<span class="cover-ai-error">No API key: ask a superadmin to add one</span>'} · default model ${escapeHtml(settings.novel_model)}</span>
    </article>`;
  }
  const check = st.check;
  const known = new Set(draft.models.map((model) => model.id));
  const missing = check?.ok ? check.models.filter((id) => !known.has(id)) : [];
  const select = (name: string, value: string): string =>
    `<select data-ai-default="${name}">${draft.models
      .map(
        (model) =>
          `<option value="${escapeHtml(model.id)}" ${model.id === value ? 'selected' : ''}>${escapeHtml(modelName(model))}</option>`,
      )
      .join('')}</select>`;
  return `
    <details class="panel ai-settings" id="aiSettings" ${st.open ? 'open' : ''}>
      <summary><span class="ai-settings-title">DeepSeek settings</span><span class="muted">${keySourceText(settings)} · novels: ${escapeHtml(settings.novel_model)}</span></summary>
      <div class="form-grid">
        <label>API key
          <input id="aiApiKey" type="password" autocomplete="new-password" spellcheck="false" value="${escapeHtml(draft.apiKey)}" placeholder="${settings.key_source === 'cms' ? 'Saved; type a new key to replace it' : 'sk-…'}" />
          <small>${keySourceText(settings)}. Stored encrypted; never shown again after saving.</small>
        </label>
        <label>API base URL
          <input id="aiBaseUrl" value="${escapeHtml(draft.baseUrl)}" placeholder="${DEFAULT_BASE_URL}" />
          <small>Leave empty for DeepSeek. HTTPS only.</small>
        </label>
        <div class="form-actions field-wide">
          <button type="button" class="secondary" id="aiCheckKey">Check key</button>
          ${settings.key_source === 'cms' ? '<button type="button" class="secondary danger" id="aiRemoveKey">Remove saved key</button>' : ''}
          ${
            check
              ? check.ok
                ? `<span class="ai-check-ok">✓ Key works${check.balance && check.balance.length > 0 ? ` · balance ${check.balance.map((b) => `${escapeHtml(b.total_balance)} ${escapeHtml(b.currency)}`).join(', ')}` : ''} · ${String(check.models.length)} models available</span>`
                : `<span class="cover-ai-error">${escapeHtml(check.error ?? 'The key did not work')}</span>`
              : ''
          }
        </div>
      </div>

      <h4>Models and prices <small class="muted">USD per 1M tokens · <a href="${PRICING_URL}" target="_blank" rel="noopener noreferrer">DeepSeek pricing</a></small></h4>
      <div class="table-wrap">
        <table class="ai-models">
          <thead><tr><th>Model id</th><th>Label</th><th>Input, cache hit</th><th>Input, cache miss</th><th>Output</th><th></th></tr></thead>
          <tbody>${draft.models
            .map((model, index) => {
              const key = String(index);
              const inUse = model.id === draft.novelModel || model.id === draft.coverModel;
              const price = (field: 'input_cache_hit' | 'input_cache_miss' | 'output'): string =>
                `<td><input class="ai-price" data-ai-model="${key}:${field}" type="number" min="0" step="0.001" value="${String(model[field])}" aria-label="${escapeHtml(model.id)} ${field}" /></td>`;
              return `<tr>
                <td><input data-ai-model="${key}:id" value="${escapeHtml(model.id)}" maxlength="100" aria-label="Model id" /></td>
                <td><input data-ai-model="${key}:label" value="${escapeHtml(model.label)}" maxlength="100" aria-label="Label" /></td>
                ${price('input_cache_hit')}${price('input_cache_miss')}${price('output')}
                <td><button type="button" class="secondary danger" data-ai-model-remove="${key}" ${inUse ? 'disabled title="A default model can\'t be removed"' : 'title="Remove"'}>✕</button></td>
              </tr>`;
            })
            .join('')}</tbody>
        </table>
      </div>
      <div class="form-actions">
        <button type="button" class="secondary" id="aiAddModel">+ Add model</button>
        ${missing.map((id) => `<button type="button" class="secondary" data-ai-add-model="${escapeHtml(id)}">+ ${escapeHtml(id)}</button>`).join('')}
        ${missing.length > 0 ? '<small class="muted">From your DeepSeek account; enter their prices after adding.</small>' : ''}
      </div>
      <p class="muted">Prices only feed the cost shown in AI Studio; DeepSeek bills by its own price list, so copy it from the pricing page.</p>

      <div class="form-grid">
        <label>Default model for AI novels${select('novel', draft.novelModel)}<small>Each novel can pick another one.</small></label>
        <label>Model for AI cover prompts${select('cover', draft.coverModel)}</label>
      </div>
      <div class="form-actions">
        <button type="button" id="aiSave" ${st.dirty ? '' : 'disabled'}>Save settings</button>
        <span class="muted" id="aiDirty">${st.dirty ? 'Unsaved changes' : ''}</span>
      </div>
    </details>`;
}

function markDirty(): void {
  st.dirty = true;
  const save = document.querySelector<HTMLButtonElement>('#aiSave');
  if (save) save.disabled = false;
  const label = document.querySelector<HTMLElement>('#aiDirty');
  if (label) label.textContent = 'Unsaved changes';
}

export function wireAiSettingsPanel(): void {
  const draft = st.draft;
  if (!draft || !h?.isSuperadmin()) return;
  document.querySelector<HTMLDetailsElement>('#aiSettings')?.addEventListener('toggle', (event) => {
    st.open = (event.currentTarget as HTMLDetailsElement).open;
  });
  document.querySelector<HTMLInputElement>('#aiApiKey')?.addEventListener('input', (event) => {
    draft.apiKey = (event.currentTarget as HTMLInputElement).value;
    markDirty();
  });
  document.querySelector<HTMLInputElement>('#aiBaseUrl')?.addEventListener('input', (event) => {
    draft.baseUrl = (event.currentTarget as HTMLInputElement).value;
    markDirty();
  });
  document.querySelectorAll<HTMLInputElement>('[data-ai-model]').forEach((input) => {
    input.addEventListener('input', () => {
      const [index, field] = (input.dataset['aiModel'] ?? '').split(':');
      const model = draft.models[Number(index)];
      if (!model || !field) return;
      if (field === 'id' || field === 'label') {
        const previous = model.id;
        model[field] = input.value.trim();
        // Renaming a default model keeps it the default.
        if (field === 'id' && draft.novelModel === previous) draft.novelModel = model.id;
        if (field === 'id' && draft.coverModel === previous) draft.coverModel = model.id;
      } else {
        const value = Number(input.value);
        model[field as 'input_cache_hit' | 'input_cache_miss' | 'output'] =
          Number.isFinite(value) && value >= 0 ? value : 0;
      }
      markDirty();
    });
  });
  document.querySelectorAll<HTMLSelectElement>('[data-ai-default]').forEach((select) => {
    select.addEventListener('change', () => {
      if (select.dataset['aiDefault'] === 'novel') draft.novelModel = select.value;
      else draft.coverModel = select.value;
      st.dirty = true;
      h?.rerender();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-ai-model-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      draft.models.splice(Number(button.dataset['aiModelRemove']), 1);
      st.dirty = true;
      h?.rerender();
    });
  });
  document.querySelector('#aiAddModel')?.addEventListener('click', () => {
    draft.models.push({ id: '', label: '', input_cache_hit: 0, input_cache_miss: 0, output: 0 });
    st.dirty = true;
    h?.rerender();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-ai-add-model]').forEach((button) => {
    button.addEventListener('click', () => {
      draft.models.push({
        id: button.dataset['aiAddModel'] ?? '',
        label: '',
        input_cache_hit: 0,
        input_cache_miss: 0,
        output: 0,
      });
      st.dirty = true;
      h?.rerender();
    });
  });
  document.querySelector('#aiCheckKey')?.addEventListener('click', () => {
    void h?.run(
      () =>
        checkAiKey({
          ...(draft.apiKey.trim() ? { api_key: draft.apiKey.trim() } : {}),
          ...(draft.baseUrl.trim() ? { base_url: draft.baseUrl.trim() } : {}),
        }),
      (check) => {
        st.check = check;
      },
    );
  });
  document.querySelector('#aiRemoveKey')?.addEventListener('click', () => {
    if (
      !window.confirm(
        'Remove the saved DeepSeek key? The server environment key applies again, if there is one.',
      )
    ) {
      return;
    }
    void h?.run(
      () => saveAiSettings({ api_key: null }),
      (settings) => {
        apply(settings);
        st.check = null;
      },
    );
  });
  document.querySelector('#aiSave')?.addEventListener('click', () => {
    const models = draft.models.filter((model) => model.id !== '');
    if (new Set(models.map((model) => model.id)).size !== models.length) {
      h?.setError('Each model id can be listed once.');
      return;
    }
    void h?.run(
      () =>
        saveAiSettings({
          ...(draft.apiKey.trim() ? { api_key: draft.apiKey.trim() } : {}),
          base_url: draft.baseUrl.trim() || null,
          novel_model: draft.novelModel,
          cover_model: draft.coverModel,
          models,
        }),
      (settings) => {
        apply(settings);
      },
    );
  });
}
