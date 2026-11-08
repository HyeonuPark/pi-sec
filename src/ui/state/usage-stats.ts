/**
 * The stats page's state: what the reader picked and the answer for that pick.
 *
 * The first read sends no provider and no model, so the server picks the pair
 * with the most calls. Every later read sends the pick. A provider change drops
 * the model, so the server picks that provider's busiest model.
 */
import { signal } from "@preact/signals";
import { request } from "../api/request.ts";
import type { UsageStatsAnswer, UsageStatsRange } from "../../shared/wire/usage-stats.ts";
import { reasonOf } from "./usage.ts";
import { showError } from "./toast.ts";

export type Percentile = "p50" | "p90";

/** The newest answer, or null before the first one arrives. */
export const answer = signal<UsageStatsAnswer | null>(null);
/** The line above the graphs: what the page is doing, or null. */
export const status = signal<string | null>("Reading model speed…");
export const range = signal<UsageStatsRange>("7d");
export const percentile = signal<Percentile>("p50");

let provider: string | null = null;
let model: string | null = null;
/** Counts reads, so an old answer never replaces a newer one. */
let serial = 0;

export async function loadStats(): Promise<void> {
  const mine = ++serial;
  const params = new URLSearchParams({ range: range.value });
  if (provider !== null) params.set("provider", provider);
  if (model !== null) params.set("model", model);
  try {
    const next = await request<UsageStatsAnswer>(`/api/usage/stats?${params.toString()}`);
    if (mine !== serial) return;
    provider = next.provider;
    model = next.model;
    answer.value = next;
    status.value = null;
  } catch (error) {
    if (mine !== serial) return;
    status.value = `Could not read model speed (${reasonOf(error)}).`;
    showError(status.value);
  }
}

export function pickProvider(value: string): void {
  provider = value;
  model = null;
  void loadStats();
}

export function pickModel(value: string): void {
  model = value;
  void loadStats();
}

export function pickRange(value: UsageStatsRange): void {
  range.value = value;
  void loadStats();
}
