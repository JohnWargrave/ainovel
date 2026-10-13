// Formatting helpers shared by main.ts and the novels page.
import { ApiError } from './api.js';

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected error';
}

export function money(value: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
}

export function integer(value: string | number): string {
  return new Intl.NumberFormat().format(Number(value));
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function localDateTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function isoDateTime(value: FormDataEntryValue | null): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return new Date(raw).toISOString();
}

export function splitValues(value: FormDataEntryValue | null): string[] {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
