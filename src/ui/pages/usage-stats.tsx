/**
 * The model speed page's entry module.
 *
 * The shell (`src/web/usage-stats.html`) draws the header; this module takes the
 * body, the theme button and the notice over in place, then reads
 * `GET /api/usage/stats` once. Later reads follow the reader's picks.
 */
import type { VNode } from "preact";
import { mountAt } from "../mount.ts";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { Toast } from "../components/toast.tsx";
import { Stats } from "../usage-stats/stats.tsx";
import { loadStats } from "../state/usage-stats.ts";

function take(selector: string, vnode: VNode): void {
  const element = document.querySelector(selector);
  if (element === null) return;
  mountAt(element, vnode);
}

take("#theme-toggle", <ThemeToggle />);
take("#stats-toast", <Toast id="stats-toast" />);
take("#stats-root", <Stats />);

void loadStats();
