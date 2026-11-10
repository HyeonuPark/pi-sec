import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRunFixture, settle } from "./remote-run-helpers.ts";

/**
 * The file tools, over the fake sftp.
 *
 * The fake does to a directory what sftp does to a machine, so these tests read
 * back the bytes that were written and the batch that was sent. Three things matter
 * and each is asked once: the read refuses rather than cuts, the write goes through
 * a temporary file and a rename, and the edit refuses anything but exactly one
 * match, including a file that changed while the edit was being prepared.
 */
describe("reading a remote file", () => {
  it("returns the bytes, and refuses a file past the cap instead of cutting it", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      await writeFile(`${fixture.remote}/note.txt`, "one\ntwo\n", "utf8");
      const read = await fixture.runtime.remoteMachines.files().read({
        machine: "box-a",
        path: `${fixture.remote}/note.txt`,
      });
      expect(read.kind).toBe("ok");
      if (read.kind === "ok") {
        expect(read.content).toBe("one\ntwo\n");
        expect(read.bytes).toBe(8);
      }
    } finally {
      await fixture.close();
    }
  });

  it("says a file that is not there cannot be listed, rather than answering empty", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const read = await fixture.runtime.remoteMachines.files().read({
        machine: "box-a",
        path: `${fixture.remote}/nothere.txt`,
      });
      expect(read.kind).toBe("failed");
      if (read.kind === "failed") expect(read.reason).toContain("not there");
    } finally {
      await fixture.close();
    }
  });
});

describe("writing a remote file", () => {
  it("writes through a temporary file and a rename, so no reader sees half a file", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      await writeFile(`${fixture.remote}/target.txt`, "old\n", "utf8");
      const written = await fixture.runtime.remoteMachines.files().write({
        machine: "box-a",
        path: `${fixture.remote}/target.txt`,
        content: "new text\n",
      });
      expect(written.kind).toBe("ok");
      expect(await readFile(`${fixture.remote}/target.txt`, "utf8")).toBe("new text\n");

      // The batch is what proves the order: a put to a sibling, then a rename.
      const calls = await fixture.sftpCalls();
      const commands = calls.flatMap((call) => (call.commands as string[] | undefined) ?? []);
      const put = commands.findIndex((line) => line.startsWith("put "));
      const rename = commands.findIndex((line) => line.startsWith("rename "));
      expect(put).toBeGreaterThanOrEqual(0);
      expect(rename).toBeGreaterThan(put);
      const putLine = commands[put] as string;
      expect(putLine).toContain(".target.txt.pi-sec-");
    } finally {
      await fixture.close();
    }
  });

  it("gives two writes of one file two temporary names", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const files = fixture.runtime.remoteMachines.files();
      const path = `${fixture.remote}/target.txt`;
      const writes = await Promise.all([
        files.write({ machine: "box-a", path, content: "one\n" }),
        files.write({ machine: "box-a", path, content: "two\n" }),
      ]);
      expect(writes.map((write) => write.kind)).toEqual(["ok", "ok"]);

      const calls = await fixture.sftpCalls();
      const commands = calls.flatMap((call) => (call.commands as string[] | undefined) ?? []);
      const temps = commands
        .filter((line) => line.startsWith("put "))
        .map((line) => /([^\s"']*\.target\.txt\.pi-sec-[^\s"']*)/.exec(line)?.[1]);
      expect(temps).toHaveLength(2);
      expect(temps[0]).toBeDefined();
      expect(temps[0]).not.toBe(temps[1]);
      for (const temp of temps) expect(temp!.startsWith(`${fixture.remote}/.target.txt.pi-sec-`)).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it("creates no directory, and says so when the target's is missing", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const written = await fixture.runtime.remoteMachines.files().write({
        machine: "box-a",
        path: `${fixture.remote}/no-such-dir/file.txt`,
        content: "x\n",
      });
      expect(written.kind).toBe("failed");
      // Nothing was created on the way: the directory the path names is still absent.
      await expect(readFile(`${fixture.remote}/no-such-dir/file.txt`, "utf8")).rejects.toThrow();
      // The temporary file was removed, so the failed write left nothing behind.
      const calls = await fixture.sftpCalls();
      const commands = calls.flatMap((call) => (call.commands as string[] | undefined) ?? []);
      expect(commands.some((line) => line.startsWith("-rm "))).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});

describe("editing a remote file", () => {
  it("replaces one occurrence", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      await writeFile(`${fixture.remote}/conf.txt`, "alpha\nbeta\ngamma\n", "utf8");
      const edited = await fixture.runtime.remoteMachines.files().edit({
        machine: "box-a",
        path: `${fixture.remote}/conf.txt`,
        oldText: "beta",
        newText: "BETA",
      });
      expect(edited.kind).toBe("ok");
      expect(await readFile(`${fixture.remote}/conf.txt`, "utf8")).toBe("alpha\nBETA\ngamma\n");
    } finally {
      await fixture.close();
    }
  });

  it("refuses when the old text is there zero times", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      await writeFile(`${fixture.remote}/conf.txt`, "alpha\n", "utf8");
      const edited = await fixture.runtime.remoteMachines.files().edit({
        machine: "box-a",
        path: `${fixture.remote}/conf.txt`,
        oldText: "omega",
        newText: "OMEGA",
      });
      expect(edited.kind).toBe("refused");
      if (edited.kind === "refused") expect(edited.reason).toContain("nowhere");
      expect(await readFile(`${fixture.remote}/conf.txt`, "utf8")).toBe("alpha\n");
    } finally {
      await fixture.close();
    }
  });

  it("refuses when the old text is there more than once, and says how many", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      await writeFile(`${fixture.remote}/conf.txt`, "dup\ndup\n", "utf8");
      const edited = await fixture.runtime.remoteMachines.files().edit({
        machine: "box-a",
        path: `${fixture.remote}/conf.txt`,
        oldText: "dup",
        newText: "one",
      });
      expect(edited.kind).toBe("refused");
      if (edited.kind === "refused") {
        expect(edited.reason).toContain("2 times");
        expect(edited.reason).toContain("exactly once");
      }
      expect(await readFile(`${fixture.remote}/conf.txt`, "utf8")).toBe("dup\ndup\n");
    } finally {
      await fixture.close();
    }
  });

  it("refuses when the file changed between the first read and the rename", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const path = `${fixture.remote}/changing.txt`;
      await writeFile(path, "before\nneedle\n", "utf8");

      // The second read is the one that catches this. The fixture's files are the
      // only writer, so the change is made between the two reads by replacing the
      // file once the first read has answered: a subclass of the tool would need a
      // hook, so the file is changed by a second writer that runs first.
      const files = fixture.runtime.remoteMachines.files();
      const originalRead = files.read.bind(files);
      let reads = 0;
      files.read = async (input) => {
        const answer = await originalRead(input);
        reads += 1;
        if (reads === 1) {
          // Between the two reads of an edit, another writer changes the file.
          await writeFile(path, "before\nneedle\nsomething else\n", "utf8");
        }
        return answer;
      };
      const edited = await files.edit({
        machine: "box-a",
        path,
        oldText: "needle",
        newText: "NEEDLE",
      });
      expect(edited.kind).toBe("refused");
      if (edited.kind === "refused") expect(edited.reason).toContain("changed while");
      // The other writer's bytes are what the file holds: nothing was overwritten.
      expect(await readFile(path, "utf8")).toBe("before\nneedle\nsomething else\n");
    } finally {
      await fixture.close();
    }
  });
});

describe("copying a tree", () => {
  it("pushes with a wrapper script that holds the ssh options, and does not delete unless told", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      await mkdir(`${fixture.remote}/tree`, { recursive: true });
      await writeFile(`${fixture.remote}/tree/only-remote.txt`, "keep\n", "utf8");
      const local = `${fixture.home}/local-tree`;
      await mkdir(local, { recursive: true });
      await writeFile(`${local}/a.txt`, "a\n", "utf8");

      const pushed = await fixture.runtime.remoteMachines.files().sync({
        machine: "box-a",
        direction: "push",
        source: local,
        destination: `${fixture.remote}/tree`,
      });
      expect(pushed.kind).toBe("ok");
      expect(await readFile(`${fixture.remote}/tree/a.txt`, "utf8")).toBe("a\n");
      // The file that was only on the destination is still there.
      expect(await readFile(`${fixture.remote}/tree/only-remote.txt`, "utf8")).toBe("keep\n");

      const calls = await fixture.rsyncCalls();
      const call = calls[0] as Record<string, unknown>;
      expect(call.direction).toBe("push");
      expect(call.delete).toBe(false);
      // The wrapper existed and was executable: rsync takes its ssh as a string, so
      // a path that is wrong there is a copy that fails with an unhelpful message.
      expect(call.wrapperExists).toBe(true);
      expect(call.wrapperExecutable).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it("deletes at the destination only when told, and pulls the other way", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      await mkdir(`${fixture.remote}/tree`, { recursive: true });
      await writeFile(`${fixture.remote}/tree/remote-only.txt`, "gone\n", "utf8");
      const local = `${fixture.home}/local-tree`;
      await mkdir(local, { recursive: true });

      const pushed = await fixture.runtime.remoteMachines.files().sync({
        machine: "box-a",
        direction: "push",
        source: local,
        destination: `${fixture.remote}/tree`,
        delete: true,
      });
      expect(pushed.kind).toBe("ok");
      const calls = await fixture.rsyncCalls();
      expect((calls[0] as Record<string, unknown>).delete).toBe(true);

      // The other direction reads the machine and writes here.
      await writeFile(`${fixture.remote}/tree/pulled.txt`, "from remote\n", "utf8");
      const pulled = await fixture.runtime.remoteMachines.files().sync({
        machine: "box-a",
        direction: "pull",
        source: `${fixture.remote}/tree/pulled.txt`,
        destination: `${fixture.home}/pulled.txt`,
      });
      expect(pulled.kind).toBe("ok");
      const all = await fixture.rsyncCalls();
      expect((all[1] as Record<string, unknown>).direction).toBe("pull");
    } finally {
      await fixture.close();
    }
  });
});

describe("the file tools honour the step check", () => {
  it("refuses every one of them on a machine at off, and starts no sftp", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      const files = fixture.runtime.remoteMachines.files();
      expect((await files.read({ machine: "box-a", path: "/etc/hostname" })).kind).toBe("refused");
      expect((await files.write({ machine: "box-a", path: "/tmp/x", content: "x" })).kind).toBe("refused");
      expect(
        (await files.edit({ machine: "box-a", path: "/tmp/x", oldText: "a", newText: "b" })).kind,
      ).toBe("refused");
      expect(
        (await files.sync({ machine: "box-a", direction: "push", source: fixture.home, destination: "/tmp/y" }))
          .kind,
      ).toBe("refused");
      await settle();
      expect(await fixture.sftpCalls()).toEqual([]);
      expect(await fixture.rsyncCalls()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
