/**
 * The five lines the header shows only when they have something to say: a staged
 * core restart, a failed config reload, an unknown mount point, a root model with
 * no credential, and a provider that refused a request for usage.
 *
 * Each is a button in the shell already, hidden by a class, and each says one
 * sentence with the rest in its tooltip. A banner that shows for a healthy page
 * cries wolf on every load, so every one of them starts hidden and is shown from
 * the state that earns it.
 */
import { at, mount } from "../../mount.ts";
import { configError, restartReady, restartRequired, rootProviderEntry, usageHold } from "../../state/run.ts";
import { showError } from "../../state/toast.ts";
import { timezone } from "../../mount.ts";
import type { UsageHoldView } from "../../../shared/wire/conversation.ts";

/**
 * The handler a press on the credential banner runs.
 *
 * The model login panel is another part's to draw, and the banner's whole job is to
 * open it, so the panel registers here what the press does. Without a panel the
 * press does nothing, which is what a page without one can honestly do.
 */
let credentialPress: (() => void) | null = null;

/** Register what a press on the credential banner does. Returns the way to drop it. */
export function onCredentialPress(handler: () => void): () => void {
  credentialPress = handler;
  return () => {
    if (credentialPress === handler) credentialPress = null;
  };
}

/**
 * One banner for the core-change restart the operator is being asked for.
 *
 * A restart is two facts, not one. `restartRequired` says a committed core change
 * is not what this process booted from; `restartReady` says the batch is closed and
 * its gate passed. Showing only the first is how an operator restarts mid-batch and
 * boots half a change.
 */
export function RestartBanner() {
  const required = restartRequired.value;
  const ready = restartReady.value;
  const text = required
    ? ready
      ? "Restart ready — run user-tools/update-and-restart"
      : "Core change staged — restart not ready yet"
    : "";
  const title = required
    ? ready
      ? "The gate passed: typecheck, tests, and a secret scan of the change."
      : "Committed core work is not what this process booted from. The agent has not declared the batch ready to apply, so a restart now could boot a half-written change."
    : "";
  return (
    <button id="restart-banner" class={`banner${required ? "" : " hidden"}`} type="button" title={title}>
      {text}
    </button>
  );
}

/**
 * The config on disk failed to load, so the running config is the last one that did.
 * The first reason is inline and the whole list is one press away: a failed reload
 * that only reaches the daemon log is a silent failure.
 */
export function ConfigBanner() {
  const issues = (configError.value?.issues ?? []).map(String);
  const first = issues[0] ?? "invalid configuration";
  const text = `Config reload failed — ${first.length > 60 ? `${first.slice(0, 59)}…` : first}`;
  return (
    <button
      id="config-banner"
      class={`banner banner-error${issues.length > 0 ? "" : " hidden"}`}
      type="button"
      title={issues.join("\n")}
      onClick={() => {
        if (issues.length > 0) showError(`Config reload failed — ${issues.join(" · ")}`);
      }}
    >
      {issues.length > 0 ? text : ""}
    </button>
  );
}

/**
 * No mount stamp and no path that names this page: every URL this page builds would
 * be a guess. The page says that, instead of reporting it as a connection that is
 * offline, which is the failure a bare 404 at the proxy used to look like.
 */
export function MountBanner() {
  const known = mount().known;
  return (
    <button
      id="mount-banner"
      class={`banner banner-error${known ? " hidden" : ""}`}
      type="button"
      title={
        known
          ? ""
          : "This page carried no mount stamp and its path does not name a known page, so the server that served it cannot be determined."
      }
    >
      {known ? "" : "Mount point unknown — reload this page from the server"}
    </button>
  );
}

/**
 * The root model's provider has no credential.
 *
 * It is read from the login routes and from nowhere else on purpose: a fresh install
 * answers 503 from the two chat GET routes, and the operator who needs this line is
 * looking at exactly that daemon.
 */
export function CredentialBanner() {
  const entry = rootProviderEntry.value;
  const missing = entry !== undefined && entry.configured !== true;
  return (
    <button
      id="credential-banner"
      class={`banner${missing ? "" : " hidden"}`}
      type="button"
      onClick={() => credentialPress?.()}
    >
      {missing ? `No credential for ${entry.id} — sign in` : ""}
    </button>
  );
}

/** One moment as the header writes it: `YYYY-MM-DD HH:mm` in the harness zone. */
export function holdStamp(at: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone === "" ? "UTC" : zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(at));
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const hour = value("hour") === "24" ? "00" : value("hour");
  return `${value("year")}-${value("month")}-${value("day")} ${hour}:${value("minute")}`;
}

/** The number of conversations one line names, in words. */
export function heldCount(count: number): string {
  return count === 1 ? "1 conversation" : `${count} conversations`;
}

/**
 * The sentence one held provider's line says.
 *
 * It names the provider, how many conversations wait for it, and what happens
 * next: the reset time when the provider states one, and the moment of the next
 * short check request otherwise. A provider whose usage this server cannot read
 * says so, because "no quota shown" and "the quota is full" are different facts.
 */
export function holdText(entry: UsageHoldView, zone: string): string {
  const resumed =
    entry.resetsAt !== undefined
      ? `resets ${holdStamp(entry.resetsAt, zone)}`
      : entry.nextProbeAt !== undefined
        ? `next check ${holdStamp(entry.nextProbeAt, zone)}`
        : "checking";
  const last =
    entry.lastProbeResult === "rate_limited"
      ? " · still refused"
      : entry.lastProbeResult === "failed"
        ? ` · check failed${entry.lastProbeReason === undefined ? "" : `: ${entry.lastProbeReason}`}`
        : "";
  const unreadable = entry.readable ? "" : " · usage not readable, checked with a short request";
  return `${entry.provider} usage limit — ${heldCount(entry.conversations)} held, ${resumed}${last}${unreadable}`;
}

/**
 * A provider refused model requests for usage, so the conversations that ran on it
 * wait for it.
 *
 * The line names the provider and how many conversations wait, and pressing it
 * opens the usage page, where the account's own numbers are. Two providers held at
 * once are two lines in one button, one per provider: one of them recovering says
 * nothing about the other.
 */
export function UsageBanner() {
  const held = usageHold.value;
  const zone = timezone();
  const text = held.map((entry) => holdText(entry, zone)).join("\n");
  return (
    <button
      id="usage-banner"
      class={`banner banner-error${held.length > 0 ? "" : " hidden"}`}
      type="button"
      title={held.length > 0 ? `${text}\nOpen the usage page` : ""}
      onClick={() => {
        if (held.length > 0 && mount().known) window.location.assign(at("/usage"));
      }}
    >
      {held.length > 0 ? text : ""}
    </button>
  );
}
