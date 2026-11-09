// An example runtime extension that draws a web page: the host's uptime, load and
// memory. It is read-only, uses no secrets, and reads `node:os` and `process` only.
//
// Copy this directory to `~/.pi/sec/extensions/host-status/`. The page answers at
// `/ext/host-status/` as soon as the daemon loads it.
import os from "node:os";

export const name = "host-status";

export function create() {
  return { name: "host-status" };
}

/** The values the page and its api show. */
function status() {
  return {
    hostUptimeSeconds: Math.round(os.uptime()),
    load: os.loadavg().map((value) => Math.round(value * 100) / 100),
    freeMemoryBytes: os.freemem(),
    totalMemoryBytes: os.totalmem(),
    daemonUptimeSeconds: Math.round(process.uptime()),
  };
}

const escapeHtml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** One table row. The script updates the cell with the same `data-field`. */
const row = (label, field, value) =>
  `<tr><th scope="row">${escapeHtml(label)}</th><td data-field="${field}">${escapeHtml(value)}</td></tr>`;

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export const pages = {
  entries: [{ page: "", label: "Host status", menu: true, script: "app.js", style: "app.css" }],

  render() {
    const now = status();
    return {
      title: "Host status",
      html:
        `<main class="host-status">` +
        `<h1>Host status</h1>` +
        `<table>` +
        row("Host uptime (s)", "hostUptimeSeconds", now.hostUptimeSeconds) +
        row("Load (1, 5, 15 min)", "load", now.load.join(", ")) +
        row("Free memory", "freeMemoryBytes", gib(now.freeMemoryBytes)) +
        row("Total memory", "totalMemoryBytes", gib(now.totalMemoryBytes)) +
        row("Daemon uptime (s)", "daemonUptimeSeconds", now.daemonUptimeSeconds) +
        `</table>` +
        `<button id="refresh" type="button">Refresh</button>` +
        `</main>`,
    };
  },

  api({ method, path }) {
    if (method === "GET" && path === "status") return { json: status() };
    return { status: 404, json: { error: "not found" } };
  },
};
