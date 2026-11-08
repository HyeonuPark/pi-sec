import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export interface JanitorOptions {
  /** Only clean tmp when systemd gave the daemon a verified private tmp. */
  readonly privateTmp: boolean;
  /** Directories to clean. Defaults to `/tmp` and `/var/tmp`. */
  readonly tmpDirs?: readonly string[];
  readonly maxAgeHours: number;
  readonly maxBytes: number;
  readonly eagerThresholdBytes: number;
  readonly cacheDir?: string;
  readonly now?: () => number;
  readonly logger?: {
    /** The per-root cleanup summary. Optional: a caller may supply only `warn`. */
    info?(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface JanitorReport {
  readonly scannedBytes: number;
  readonly bytesFreed: number;
  readonly deleted: string[];
  readonly skipped: boolean;
}

interface FileEntry {
  readonly path: string;
  readonly size: number;
  /**
   * The moment the file counts as made: the later of its mtime and its ctime.
   *
   * The mtime is what a copy can keep from its source, so `tar -x`, `cp -p` and
   * `rsync -a` write a file whose mtime says it is days old. The ctime is when
   * the kernel last changed the inode, and a copy or an unpack writes a new
   * file, so the later of the two is the moment this file began to exist here.
   * A file whose mtime alone is old therefore stays for the full age from its
   * copy, and a file whose two times are both old is still deleted.
   *
   * A rename or a permission change moves the ctime as well, so such a file
   * stays longer than the age. Cleanup then runs late, never early.
   */
  readonly madeMs: number;
}

/** How many paths a summary keeps, and the longest a path may appear. */
const SUMMARY_SAMPLE_LIMIT = 10;
const SUMMARY_PATH_LIMIT = 200;

/** The symbolic links one cleanup root holds, which the walk refused to follow. */
interface LinkTally {
  count: number;
  readonly sample: string[];
}

/** What one cleanup root produced, for one summary line. */
interface RootSummary {
  readonly root: string;
  deleted: number;
  bytes: number;
  readonly linksSkipped: number;
  readonly sample: string[];
  readonly linkSample: string[];
}

/** Keep one path for a summary, bounded in count and in length. */
function rememberPath(sample: string[], path: string): void {
  if (sample.length >= SUMMARY_SAMPLE_LIMIT) return;
  sample.push(path.length <= SUMMARY_PATH_LIMIT ? path : `${path.slice(0, SUMMARY_PATH_LIMIT - 1)}…`);
}

/**
 * Collect the files under one cleanup root.
 *
 * A symbolic link is never followed: the walk stops at it and the link itself is
 * the only candidate. A link is not a file of this root, so a link that points
 * outside the root can no longer put a file of another tree on the list, and
 * cleanup cannot delete a file the root does not contain. Every link the walk
 * refused to follow is counted in `links`, with a bounded sample of its paths.
 */
async function collectFiles(dir: string, out: FileEntry[], links: LinkTally, depth = 0): Promise<void> {
  if (depth > 4) return;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        links.count += 1;
        rememberPath(links.sample, path);
        out.push({ path, size: info.size, madeMs: Math.max(info.mtimeMs, info.ctimeMs) });
      } else if (info.isDirectory()) {
        await collectFiles(path, out, links, depth + 1);
      } else if (info.isFile()) {
        out.push({ path, size: info.size, madeMs: Math.max(info.mtimeMs, info.ctimeMs) });
      }
    } catch {
      /* vanished */
    }
  }
}

/**
 * Eager cleanup of the private tmp, cache, and (via callers) rotated logs.
 * Never leaves the verified tmp roots; without a private tmp it skips tmp
 * cleanup entirely rather than deleting arbitrary system files.
 */
export class Janitor {
  private readonly options: JanitorOptions;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(options: JanitorOptions) {
    this.options = options;
  }

  start(intervalMs = 60 * 60 * 1000): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.run().catch((error) => this.options.logger?.warn("janitor run failed", { error }));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  async run(): Promise<JanitorReport> {
    if (this.running) return { scannedBytes: 0, bytesFreed: 0, deleted: [], skipped: true };
    this.running = true;
    try {
      const deleted: string[] = [];
      let scannedBytes = 0;
      let bytesFreed = 0;
      const now = (this.options.now ?? Date.now)();
      const maxAgeMs = this.options.maxAgeHours * 60 * 60 * 1000;

      if (this.options.privateTmp) {
        const roots = this.options.tmpDirs ?? ["/tmp", "/var/tmp"];
        const files: FileEntry[] = [];
        const perRoot: RootSummary[] = [];
        const rootOf = new Map<FileEntry, RootSummary>();
        for (const root of roots) {
          const links: LinkTally = { count: 0, sample: [] };
          const found: FileEntry[] = [];
          await collectFiles(root, found, links);
          scannedBytes += found.reduce((sum, file) => sum + file.size, 0);
          const summary: RootSummary = {
            root,
            deleted: 0,
            bytes: 0,
            linksSkipped: links.count,
            sample: [],
            linkSample: [...links.sample],
          };
          perRoot.push(summary);
          for (const file of found) {
            files.push(file);
            rootOf.set(file, summary);
          }
        }

        const victims = new Set<FileEntry>();
        for (const file of files) {
          const age = now - file.madeMs;
          if (age > maxAgeMs || file.size > this.options.eagerThresholdBytes) victims.add(file);
        }
        const survivors = files.filter((file) => !victims.has(file));
        let total = survivors.reduce((sum, file) => sum + file.size, 0);
        for (const file of [...survivors].sort((a, b) => a.madeMs - b.madeMs)) {
          if (total <= this.options.maxBytes) break;
          victims.add(file);
          total -= file.size;
        }
        for (const file of victims) {
          try {
            await rm(file.path, { force: true, recursive: true });
            deleted.push(file.path);
            bytesFreed += file.size;
            const summary = rootOf.get(file);
            if (summary !== undefined) {
              summary.deleted += 1;
              summary.bytes += file.size;
              rememberPath(summary.sample, file.path);
            }
          } catch (error) {
            this.options.logger?.warn("janitor could not delete", { path: file.path, error });
          }
        }
        for (const summary of perRoot) this.logSummary(summary);
      }

      if (this.options.cacheDir !== undefined && this.options.maxAgeHours > 0) {
        const links: LinkTally = { count: 0, sample: [] };
        const cached: FileEntry[] = [];
        await collectFiles(this.options.cacheDir, cached, links);
        const summary: RootSummary = {
          root: this.options.cacheDir,
          deleted: 0,
          bytes: 0,
          linksSkipped: links.count,
          sample: [],
          linkSample: [...links.sample],
        };
        for (const file of cached) {
          if (now - file.madeMs > maxAgeMs) {
            try {
              await rm(file.path, { force: true, recursive: true });
              deleted.push(file.path);
              bytesFreed += file.size;
              summary.deleted += 1;
              summary.bytes += file.size;
              rememberPath(summary.sample, file.path);
            } catch {
              /* ignore */
            }
          }
        }
        this.logSummary(summary);
      }

      return { scannedBytes, bytesFreed, deleted, skipped: false };
    } finally {
      this.running = false;
    }
  }

  /**
   * One line per cleanup root, and only when the pass did something. A quiet
   * pass logs nothing, so the record stays small and a line means an event.
   */
  private logSummary(summary: RootSummary): void {
    if (summary.deleted === 0 && summary.linksSkipped === 0) return;
    this.options.logger?.info?.("janitor cleanup summary", {
      root: summary.root,
      deleted: summary.deleted,
      bytes: summary.bytes,
      linksSkipped: summary.linksSkipped,
      sample: summary.sample,
      linkSample: summary.linkSample,
    });
  }
}

/** Whether the daemon was given a private tmp by systemd. */
export function hasPrivateTmp(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_SEC_PRIVATE_TMP === "1";
}
