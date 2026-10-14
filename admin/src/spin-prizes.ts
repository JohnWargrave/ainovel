// The prize table editor inside each spin-table form on the Settings page. Rendered as plain rows so
// main.ts keeps owning the form and its submit; this module only adds/removes rows, keeps the odds and
// average payout live as the operator types, and reads the rows back into the PUT body. The server
// runs the same checks a spin does on save (SPIN_PRIZES_INVALID), so the browser checks here are only
// there to catch typos before the round trip.
import type {
  SpinConfigAdmin,
  SpinPrizeAdmin,
  SpinPrizeInput,
  SpinPrizeTier,
  SpinPrizeType,
} from './api.js';
import { escapeHtml } from './format.js';

// Mirrors SPIN_PRIZES_MAX on the server: the app draws one wheel segment per prize.
const MAX_PRIZES = 12;
const TIERS: SpinPrizeTier[] = ['low', 'mid', 'high', 'jackpot'];
// Mirrors BOOST_VALUE in boost.service.ts. The server also caps minutes at 1440.
const BOOST_PATTERN = '([2-9]|10)x([1-9][0-9]{0,3})';
const COIN_PATTERN = '[0-9]+';

// Unsaved rows per spin table. Every save, failed or not, re-renders the whole Settings page from
// state, so without this a refused table (say, an average payout over the limit) would snap back to
// the stored rows and throw away the operator's edits. Dropped on a successful save or a fresh load.
const drafts = new Map<string, SpinPrizeAdmin[]>();

export function clearPrizeDrafts(configId?: string): void {
  if (configId === undefined) drafts.clear();
  else drafts.delete(configId);
}

const BLANK_PRIZE: SpinPrizeAdmin = {
  slot: 0,
  type: 'coin',
  value: 0,
  weight: 1,
  tier: 'low',
  label: null,
};

function typeOptions(selected: string): string {
  const options: Array<{ value: SpinPrizeType; label: string; disabled?: boolean }> = [
    { value: 'coin', label: 'Coin' },
    { value: 'boost', label: 'Boost' },
    // A spin that lands on a voucher fails with SPIN_PRIZE_UNSUPPORTED, so the server refuses to save
    // one. Listed so a stored voucher row still shows what it is.
    { value: 'voucher', label: 'Voucher (not available yet)', disabled: true },
  ];
  return options
    .map(
      (option) =>
        `<option value="${option.value}" ${option.value === selected ? 'selected' : ''} ${option.disabled ? 'disabled' : ''}>${option.label}</option>`,
    )
    .join('');
}

// What the server writes when a prize is saved without a label (validatePrizeTable), plus the
// thousands-separated form the seeded tables use. A stored label matching one of these was never
// typed by anyone, so the editor shows it as blank: otherwise it would stick when the value changes
// and the wheel would read "10 coin" over a 20 coin prize.
function autoLabels(type: string, value: number | string): string[] {
  if (type === 'coin') {
    return [`${String(value)} coin`, `${Number(value).toLocaleString('en-US')} coin`];
  }
  if (type === 'boost') return [`×${String(value).split('x')[0]} boost`];
  return [String(value)];
}

function prizeRow(prize: SpinPrizeAdmin): string {
  const label =
    prize.label && !autoLabels(prize.type, prize.value).includes(prize.label) ? prize.label : '';
  return `<tr data-prize-row>
      <td class="prize-slot" data-prize-slot>${prize.slot}</td>
      <td><select data-field="type" aria-label="Prize type">${typeOptions(prize.type)}</select></td>
      <td><input data-field="value" type="text" value="${escapeHtml(prize.value)}" required aria-label="Prize value" /></td>
      <td><input data-field="weight" type="number" min="1" max="1000000" step="1" value="${prize.weight}" required aria-label="Odds weight" /></td>
      <td class="prize-chance" data-prize-chance></td>
      <td><select data-field="tier" aria-label="Tier">${TIERS.map((tier) => `<option value="${tier}" ${tier === prize.tier ? 'selected' : ''}>${tier}</option>`).join('')}</select></td>
      <td><input data-field="label" type="text" maxlength="40" value="${escapeHtml(label)}" placeholder="Auto" aria-label="Label" /></td>
      <td><button type="button" class="secondary danger" data-remove-prize aria-label="Remove prize">×</button></td>
    </tr>`;
}

export function renderPrizeEditor(config: SpinConfigAdmin): string {
  const band =
    config.ev_min === null
      ? `at most ${config.ev_max}`
      : `between ${config.ev_min} and ${config.ev_max}`;
  const prizes = drafts.get(config.id) ?? config.prizes;
  return `<div class="prize-editor" data-prize-editor data-config-id="${escapeHtml(config.id)}" data-ev-min="${config.ev_min ?? ''}" data-ev-max="${config.ev_max}">
      <table class="compact-table prize-table">
        <thead><tr><th>Slot</th><th>Type</th><th>Value</th><th>Weight</th><th>Chance</th><th>Tier</th><th>Label</th><th></th></tr></thead>
        <tbody>${prizes.map(prizeRow).join('')}</tbody>
      </table>
      <div class="prize-editor-footer">
        <button type="button" class="secondary" data-add-prize>Add prize</button>
        <span class="muted" data-prize-ev></span>
        ${drafts.has(config.id) ? '<span class="pill">Unsaved changes</span>' : ''}
      </div>
      <p class="muted">Coin: a whole amount. Boost: multiplier x minutes, e.g. 2x60 is ×2 for an hour. Chance is weight over the sum of all weights. Average payout must be ${band} coin per spin.</p>
    </div>`;
}

function field<T extends HTMLInputElement | HTMLSelectElement>(row: Element, name: string): T {
  return row.querySelector<T>(`[data-field="${name}"]`)!;
}

// Keeps slots, per-row value rules, chances and the average payout in step with the rows.
function refresh(editor: HTMLElement): void {
  const rows = [...editor.querySelectorAll<HTMLTableRowElement>('[data-prize-row]')];
  const weights = rows.map((row) => Number(field(row, 'weight').value) || 0);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let ev = 0;
  rows.forEach((row, index) => {
    row.querySelector('[data-prize-slot]')!.textContent = String(index + 1);
    const typeSelect = field<HTMLSelectElement>(row, 'type');
    const type = typeSelect.value;
    const value = field<HTMLInputElement>(row, 'value');
    typeSelect.setCustomValidity(
      type === 'voucher' ? 'Vouchers cannot be won from a spin yet. Pick coin or boost.' : '',
    );
    value.pattern = type === 'boost' ? BOOST_PATTERN : COIN_PATTERN;
    value.title = type === 'boost' ? 'Multiplier x minutes, e.g. 2x60' : 'A whole coin amount';
    value.placeholder = type === 'boost' ? '2x60' : '100';
    const chance = total > 0 ? (weights[index]! / total) * 100 : 0;
    row.querySelector('[data-prize-chance]')!.textContent =
      `${chance.toFixed(chance < 1 ? 2 : 1)}%`;
    field<HTMLInputElement>(row, 'label').placeholder = value.value
      ? (autoLabels(type, value.value.trim())[0] ?? 'Auto')
      : 'Auto';
    if (type === 'coin' && total > 0) ev += ((Number(value.value) || 0) * weights[index]!) / total;
  });

  const min = editor.dataset['evMin'] ? Number(editor.dataset['evMin']) : null;
  const max = Number(editor.dataset['evMax']);
  const outOfBand = ev > max || (min !== null && ev < min);
  const evLabel = editor.querySelector<HTMLElement>('[data-prize-ev]')!;
  evLabel.textContent = `Average payout ${ev.toFixed(1)} coin per spin${outOfBand ? ' — outside the allowed band, the save will be refused' : ''}`;
  evLabel.classList.toggle('prize-ev-invalid', outOfBand);

  editor.querySelector<HTMLButtonElement>('[data-add-prize]')!.disabled = rows.length >= MAX_PRIZES;
  rows.forEach((row) => {
    row.querySelector<HTMLButtonElement>('[data-remove-prize]')!.disabled = rows.length <= 1;
  });
}

export function wirePrizeEditor(form: HTMLFormElement): void {
  const editor = form.querySelector<HTMLElement>('[data-prize-editor]');
  if (!editor) return;
  const configId = editor.dataset['configId']!;
  const markDirty = (): void => {
    drafts.set(configId, readRows(editor));
    refresh(editor);
  };
  editor.addEventListener('input', markDirty);
  editor.addEventListener('change', markDirty);
  editor.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-add-prize]')) {
      editor.querySelector('tbody')!.insertAdjacentHTML('beforeend', prizeRow(BLANK_PRIZE));
      markDirty();
      return;
    }
    const remove = target.closest('[data-remove-prize]');
    if (remove) {
      remove.closest('[data-prize-row]')?.remove();
      markDirty();
    }
  });
  refresh(editor);
}

// The rows exactly as typed, so a re-render can put them back.
function readRows(editor: HTMLElement): SpinPrizeAdmin[] {
  return [...editor.querySelectorAll('[data-prize-row]')].map((row, index) => ({
    slot: index + 1,
    type: field<HTMLSelectElement>(row, 'type').value,
    value: field<HTMLInputElement>(row, 'value').value.trim(),
    weight: Number(field<HTMLInputElement>(row, 'weight').value),
    tier: field<HTMLSelectElement>(row, 'tier').value,
    label: field<HTMLInputElement>(row, 'label').value.trim() || null,
  }));
}

// The rows as a PUT body, or undefined when the operator never touched them, so a cap-only save
// does not resubmit (and re-validate) a stored table.
export function readPrizes(configId: string): SpinPrizeInput[] | undefined {
  return drafts.get(configId)?.map((row) => {
    const type = row.type as SpinPrizeInput['type'];
    return {
      slot: row.slot,
      type,
      value: type === 'coin' ? Number(row.value) : String(row.value),
      weight: row.weight,
      tier: row.tier as SpinPrizeTier,
      ...(row.label ? { label: row.label } : {}),
    };
  });
}
