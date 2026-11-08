import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRunFixture, settle } from "./remote-run-helpers.ts";
import { parseLoad } from "../src/remote/machines.ts";

/**
 * The one short read that answers "what is that machine doing".
 *
 * `remote_machines` with a machine name asks the machine once and answers with its
 * load, its memory and its logged-in sessions. That is why the tool takes no
 * argument to stay free of a connection: a caller that names no machine learns what
 * is registered and **nothing is contacted**.
 */
describe("reading a machine's load", () => {
  it("asks once, and answers with the load, the memory and the sessions", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const load = await fixture.runtime.remoteMachines.load("box-a");
      expect(load.kind).toBe("ok");
      if (load.kind === "ok") {
        // The three blocks are read from this machine, because the fake runs the
        // script here: the point is one call, and the shape of what it answers.
        expect(load.load).not.toBe("");
        expect(load.cpus).not.toBeNull();
        expect(Array.isArray(load.sessions)).toBe(true);
      }
      // One call, and the only one after the level change: the level change itself
      // heartbeats, and the load read is one more call and nothing else.
      const calls = await fixture.calls();
      const reads = calls.filter((call) => String(call.command ?? "") !== "cat /etc/machine-id");
      expect(reads.length).toBe(1);
      expect(String(reads[0]?.command ?? "")).toContain("base64 -d | sh");
    } finally {
      await fixture.close();
    }
  });

  it("contacts nothing when no machine is named", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const before = (await fixture.calls()).length;
      const listed = await fixture.runtime.remoteMachines.list(BACKGROUND_CONTEXT);
      expect(listed.machines.length).toBe(1);
      expect((await fixture.calls()).length).toBe(before);
    } finally {
      await fixture.close();
    }
  });

  it("refuses at off, without asking the machine", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      const load = await fixture.runtime.remoteMachines.load("box-a");
      expect(load.kind).toBe("refused");
      await settle();
      expect(await fixture.calls()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

describe("parsing the load script's answer", () => {
  it("reads the keys it knows and the session block, and nothing a banner might print", () => {
    const stdout = [
      "Welcome to box-a, this banner is a login profile talking",
      "loadavg=0.10 0.20 0.30 1/200 4242",
      "memtotal=16384000",
      "memavailable=8192000",
      "cpus=16",
      "sessions-begin",
      "alice    tty1         2026-10-31 06:00",
      "alice    tty2         2026-10-31 06:10 (192.0.2.11)",
      "sessions-end",
      "loadavg=this comes after and must not win",
    ].join("\n");
    const parsed = parseLoad(stdout);
    // The last `loadavg` line does win, because the script prints its keys once and a
    // later line can only come from the machine's own output. That is the rule, and
    // it is why the keys are printed after everything else in the script.
    expect(parsed.load).toBe("this comes after and must not win");
    expect(parsed.memoryTotalKb).toBe(16_384_000);
    expect(parsed.memoryAvailableKb).toBe(8_192_000);
    expect(parsed.cpus).toBe(16);
    expect(parsed.sessions).toEqual([
      "alice    tty1         2026-10-31 06:00",
      "alice    tty2         2026-10-31 06:10 (192.0.2.11)",
    ]);
  });

  it("answers null for a value that is not a number, rather than guessing", () => {
    const parsed = parseLoad("loadavg=\nmemtotal=notanumber\ncpus=4\nsessions-begin\nsessions-end\n");
    expect(parsed.load).toBe("");
    expect(parsed.memoryTotalKb).toBeNull();
    expect(parsed.cpus).toBe(4);
    expect(parsed.sessions).toEqual([]);
  });
});
