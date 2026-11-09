/**
 * Prompt text and the tool descriptions built from it, and two tools that
 * answer from a file they are given.
 *
 * Merged from the small files named by the describe blocks below, so one child
 * process loads the application's module graph once for all of them instead of
 * once per file. Every test, hook and helper is the one its own file carried.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { collapseSystemMessages } from "@earendil-works/pi-ai/utils/transcript";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { renderConventions } from "../src/extensions/conventions.ts";
import { CONVENTIONS_TEXT } from "../src/extensions/conventions-text.ts";
import { BUNDLED_EXTENSIONS } from "../src/extensions/index.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { mkdtempSync } from "node:fs";
import { createCodingExtension } from "../src/extensions/coding.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { buildPaths } from "../src/runtime/paths.ts";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ToolRegistration, ToolExecutionResult } from "@earendil-works/pi-durable";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { createExpiryCheckTool } from "../src/extensions/expiry-check/index.ts";
import { DEFAULT_WARN_DAYS, ExpiryRegistryError, dayInZone, evaluateExpiry, parseRegistry, todayInZone, type ExpiryEntry } from "../src/extensions/expiry-check/evaluate.ts";

describe("conventions.test.ts", () => {
  /**
   * The `conventions` section is a constant plus two paths.
   *
   * The canonical text holds `{jobsDir}` and `{piSecHome}`; the render fills them
   * from the config and the paths, so an install with a different home says its
   * own directories instead of another instance's. These tests pin the two
   * sources, the shape of what they fill, and that the text carries no leftover
   * from the instance the text was written on: no absolute account path, no
   * Korean beyond the one example sentence that quotes a word not to use, and no
   * tool name that a bundled extension does not register.
   */

  /** A config whose job directory is `jobDir`, over the built-in defaults. */
  function configWith(jobDir: string): Config {
    const config = defaultConfig();
    config.agent.jobDir = jobDir;
    return config;
  }

  /** The leading system message of a request, with every section collapsed into it. */
  function head(messages: Parameters<typeof collapseSystemMessages>[0]["messages"]): string {
    const collapsed = collapseSystemMessages({ messages }).messages;
    const first = collapsed[0];
    return first !== undefined && first.role === "system" ? getSystemMessageText(first) : "";
  }

  /**
   * What counts as a tool name in the conventions text.
   *
   * A backticked identifier in lower snake case is a tool name (`finish_work`),
   * and so is one written with a trailing `_*` for the family its siblings share
   * (`restart_cascade_*`). Every other backticked value in the text is a status, a
   * setting, a path, or a placeholder. The cost of the rule is a false positive:
   * a backticked `snake_case` word that is not a tool fails this test. That is the
   * intended cost, because the text may name only tools an install can call.
   */
  const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
  const TOOL_FAMILY = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)_\*$/;

  /** Every backticked value in the canonical text, in the order they appear. */
  function backticked(): string[] {
    return [...CONVENTIONS_TEXT.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
  }

  describe("conventions section", () => {
    let harness: TestHarness | undefined;
    let scratch: string | undefined;

    afterEach(async () => {
      await harness?.close();
      harness = undefined;
      if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
      scratch = undefined;
    });

    it("fills both placeholders with absolute paths from the config and the paths", () => {
      const rendered = renderConventions(
        configWith("/srv/jobs"),
        { home: "/srv/pi-sec-home" },
        "/srv/account",
      );

      expect(rendered).toContain("A job keeps its working files under `/srv/jobs/<slug>/`");
      expect(rendered).toContain("Harness control state stays in `/srv/pi-sec-home/state/`");
      expect(rendered).not.toContain("{jobsDir}");
      expect(rendered).not.toContain("{piSecHome}");
      expect(rendered.startsWith("[pi-sec · common conventions]\n\nThese rules apply to every agent")).toBe(true);
    });

    it("expands a `~` job directory against the run account's home", async () => {
      scratch = await mkdtemp(join(tmpdir(), "pi-sec-conventions-"));
      const rendered = renderConventions(defaultConfig(), { home: "/srv/pi-sec-home" }, scratch);

      // The default is `~/job`, and `~` is the account home a caller names.
      expect(rendered).toContain(`A job keeps its working files under \`${join(scratch, "job")}/<slug>/\``);
    });

    it("takes a relative job directory as the process working directory resolves it", () => {
      const rendered = renderConventions(configWith("var/jobs"), { home: "/srv/pi-sec-home" }, "/srv/account");

      expect(rendered).toContain(`A job keeps its working files under \`${join(process.cwd(), "var", "jobs")}/<slug>/\``);
    });

    it("falls back to the default job directory when the value is empty", () => {
      const rendered = renderConventions(configWith(""), { home: "/srv/pi-sec-home" }, "/srv/account");

      expect(rendered).toContain("A job keeps its working files under `/srv/account/job/<slug>/`");
    });

    it("changes only as far as the two values change", () => {
      const one = renderConventions(configWith("/srv/one"), { home: "/srv/home-one" }, "/srv/account");
      const two = renderConventions(configWith("/srv/two"), { home: "/srv/home-two" }, "/srv/account");

      expect(one.replaceAll("/srv/one", "X").replaceAll("/srv/home-one", "Y")).toBe(
        two.replaceAll("/srv/two", "X").replaceAll("/srv/home-two", "Y"),
      );
    });

    it("carries no account path, and Korean only in the one sentence that quotes a word not to use", () => {
      const rendered = renderConventions(configWith("/srv/jobs"), { home: "/srv/pi-sec-home" }, "/srv/account");

      // No account path is written into the constant: a home baked into the text
      // would point every install at one machine, and the two the text does name
      // come from the config and the paths.
      expect(CONVENTIONS_TEXT).not.toMatch(/\/home\//);
      expect(rendered).not.toMatch(/\/home\//);
      // A fresh install may run a model that does not read Korean, so the text is
      // English. The one exception is an example: the internal word a report must
      // not use is itself Korean, so the
      // sentence that bans it quotes the word and gives the phrase to write
      // instead. Pinning the whole line holds the exception to that one place: any
      // other Korean is still a failure.
      const korean = rendered.split("\n").filter((line) => /[\uAC00-\uD7A3]/.test(line));
      expect(korean).toEqual([
        "- Do not use an internal label that the user never saw, such as the letter of a sub-job, a nickname for a " +
          "harness mechanism, or the word 착륙 for a commit to `main`. Name the thing by what it does, for example " +
          "`main` 에 커밋합니다.",
      ]);
    });

    it("pins the three sentences a lesson added about labels, identifiers and undocumented values", () => {
      // Each of these answers a correction that the text did not cover, so a later
      // edit must not drop one quietly. The label sentence is pinned whole by the
      // Korean test above; its phrases are checked here with the other two.
      expect(CONVENTIONS_TEXT).toContain("or the word 착륙 for a commit to `main`");
      expect(CONVENTIONS_TEXT).toContain("for example `main` 에 커밋합니다.");
      // An identifier sent in the same batch as the
      // call that creates or prints it is invented, because its result has not
      // arrived. The wider wording covers a hash that `git rev-parse` prints, which
      // no call creates.
      expect(CONVENTIONS_TEXT).toContain(
        "Wait for that output: an identifier that you send in the same tool batch as the call that creates or prints it is invented.",
      );
      // A value an undocumented endpoint returned is a
      // claim, and the report that relays it names the source and any contradiction.
      expect(CONVENTIONS_TEXT).toContain(
        "- Treat a value from an undocumented external endpoint as a claim, not a fact. When you pass it on, name its source and any evidence that contradicts it.",
      );
    });

    it("pins the sentence that a js script counts as one batch, and the widened hook rule", () => {
      // Two corrections that the text did not answer before, so a later edit must
      // not drop either one quietly.
      // A whole `js` script is one batch, so an id that
      // a call inside it creates or prints has to come from that call's return value.
      expect(CONVENTIONS_TEXT).toContain(
        "A `js` script counts as one batch. If a call in the script creates or prints an identifier, take it from the value that the call returned. The same identifier typed into the script as text is invented.",
      );
      // A hook is bypassed by more than `--no-verify`,
      // and a test of what a hook does needs both an input it passes and one it
      // refuses.
      expect(CONVENTIONS_TEXT).toContain(
        "Never bypass a hook. `--no-verify`, a `core.hooksPath` setting, also one given with `git -c`, that makes git skip a hook that would run otherwise, and a hook file that you removed or changed all bypass one.",
      );
      expect(CONVENTIONS_TEXT).toContain(
        "This holds in a scratch copy too: to test what a hook does, give it one input that it must pass and one input that it must fail.",
      );
    });

    it("names both kinds of restart, and the restart that carries no new prompt", () => {
      // The Restarts section decides what every session believes about restarting.
      // The third item is the one a conversation whose context grew long follows, so
      // it has to name the tool call it makes and the round it does not open.
      expect(CONVENTIONS_TEXT).toContain(
        "There are two kinds of restart, a daemon restart and a session restart, and one does not replace the other.",
      );
      expect(CONVENTIONS_TEXT).toContain("- A session restart that carries no new prompt runs in no round.");
      expect(CONVENTIONS_TEXT).toContain(
        "at the next resting point between units of work, it makes its state file current and restarts its own session with `restart_session`, a reason and no round id.",
      );
      expect(CONVENTIONS_TEXT).toContain("The round ledger records the request, and the continuation says why the session started again.");
      // The second item is narrower than it was: a changed *prompt* is what runs in
      // rounds, and a daemon restart is not what gives a running session a new one.
      expect(CONVENTIONS_TEXT).toContain(
        "A session restart that carries a changed prompt runs in rounds through the `restart_cascade_*` tools.",
      );
      expect(CONVENTIONS_TEXT).toContain("A daemon restart does not give a running session a new system prompt.");
      // The sentence the third item replaced is gone: it said every session restart
      // picks up a changed prompt, which is false for one that carries none.
      expect(CONVENTIONS_TEXT).not.toContain("A session restart starts a conversation again, so that it picks up a changed prompt.");
    });

    it("keeps the heavy-use exception for read-only work", () => {
      // Read-only work starts without asking, so the one exception that still
      // needs an approved plan has to stay in the text the agent reads.
      expect(CONVENTIONS_TEXT).toContain("Read-only work still needs an approved plan if it uses resources heavily.");
    });

    it("sends the resource rules through the remote tools, and names the lock file on the other machine", () => {
      // The two sentences this release changed, in the approval section. The first
      // must not read as an allowance for a hand-built ssh call, and the second must
      // name the file a heavy run on the other machine locks.
      const rendered = renderConventions(configWith("/srv/jobs"), { home: "/srv/pi-sec-home" }, "/srv/account");
      expect(rendered).toContain(
        "These rules apply on this machine and on every remote machine you reach with the remote tools, as far as that machine's level allows.",
      );
      expect(rendered).not.toContain("on every machine that you reach with ssh");
      expect(rendered).toContain(
        "and on a remote machine use the lock file `~/.local/state/pi-sec/heavy-work.lock` in that user's home directory.",
      );
      expect(rendered).not.toContain("use a lock file in your home directory there");
      // The lock file of this machine is the same path it was, rendered from the
      // pi-sec home.
      expect(rendered).toContain("start it as `flock /srv/pi-sec-home/state/heavy-work.lock <command>`");
    });

    it("tells an agent that opens a test chat to carry the test body", () => {
      // An agent opens a focused chat for a send-path or upload-path test, so the
      // way to mark one has to be in the text the agent reads, not only in the
      // HTTP reference. Both sentences are pinned here, so a later edit to the text
      // cannot drop them quietly.
      expect(CONVENTIONS_TEXT).toContain(
        'opens its own focused chat with `POST /api/focused-chats` and the body `{"test": true}`, and sends only to it.',
      );
      expect(CONVENTIONS_TEXT).toContain(
        "Every focused chat that an agent opens for a test carries that body, so that the chats list files it under its test category.",
      );
    });

    it("names in backticks only tools that a bundled extension registers", async () => {
      // Every bundled extension is on, so a tool this test cannot see is a tool a
      // default install could not call either.
      harness = await createTestHarness({
        config: {
          agent: { extensions: { enabled: BUNDLED_EXTENSIONS.map((extension) => extension.name) } },
        } as Partial<Config>,
      });
      const registered = new Set(harness.runtime.registry.snapshot().tools().map((entry) => entry.tool.name));
      const tokens = backticked();
      const named = tokens.filter((token) => TOOL_NAME.test(token));

      // A failure here is the rule above failing to recognise a tool name, not a
      // change to the text.
      expect(named.length).toBeGreaterThan(0);
      expect(named.filter((name) => !registered.has(name))).toEqual([]);

      const missingFamilies = tokens
        .filter((token) => TOOL_FAMILY.test(token))
        .filter((token) => {
          const prefix = `${TOOL_FAMILY.exec(token)?.[1] ?? ""}_`;
          return ![...registered].some((name) => name.startsWith(prefix));
        });
      expect(missingFamilies).toEqual([]);
    });

    it("reaches a live request with the job directory its config names", async () => {
      scratch = await mkdtemp(join(tmpdir(), "pi-sec-conventions-"));
      const jobs = join(scratch, "jobs");
      harness = await createTestHarness({ config: { agent: { jobDir: jobs } } as Partial<Config> });

      const heads: string[] = [];
      harness.faux.setResponses([
        (context) => {
          heads.push(head(context.messages));
          return fauxAssistantMessage([fauxText("ok")]);
        },
      ]);
      const conversation = await resolveDefaultConversation(
        harness.runtime.harness,
        harness.config,
        harness.runtime.paths,
        BACKGROUND_CONTEXT,
      );
      const submission = await conversation.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
      expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");

      expect(heads).toHaveLength(1);
      expect(heads[0]).toContain("[pi-sec · common conventions]");
      expect(heads[0]).toContain(`\`${jobs}/<slug>/\``);
      expect(heads[0]).toContain(`Harness control state stays in \`${harness.paths.home}/state/\``);
    });

    it("keeps the GitHub rule: reads are free, a write needs the user's request and an approved report", () => {
      // Every kind of GitHub write needs an
      // explicit request from the user and an approved report, and reads are
      // unlimited. Pinning the sentences keeps a later edit from dropping them.
      expect(CONVENTIONS_TEXT).toContain("- Reading from GitHub is read-only work, so it needs no plan.");
      expect(CONVENTIONS_TEXT).toContain(
        "- A write to GitHub is any change to the state on GitHub, by any path: `git`, `gh`, a direct API request, or a browser.",
      );
      expect(CONVENTIONS_TEXT).toContain("- A write to GitHub starts only when two conditions hold together.");
      expect(CONVENTIONS_TEXT).toContain(
        "An approval of other work does not cover a GitHub write that the user did not ask for.",
      );
      expect(CONVENTIONS_TEXT).toContain("- A landing push can be covered by a standing decision.");
      expect(CONVENTIONS_TEXT).toContain("When that record exists, the two conditions above hold for every landing push, and the root pushes without asking again.");
      expect(CONVENTIONS_TEXT).toContain("- A landing push has one form: `git push origin main`");
      expect(CONVENTIONS_TEXT).toContain(
        "- This rule covers the writes that an agent makes. A program that an agent built on an approved plan can write to GitHub when the user acts in it, if that plan named the writes that the program makes. Those writes are not agent writes, and the approval of that plan covers them. If an agent itself runs such a program to write to GitHub, the rule above applies to that write.",
      );
      expect(CONVENTIONS_TEXT).toContain("- The GitHub token stays out of every output.");
      expect(CONVENTIONS_TEXT).toContain("or with a choice on an `ask_user` card that names that write.");
      expect(CONVENTIONS_TEXT).toContain("- Some rules ask for the user's request in the user's own words.");
      expect(CONVENTIONS_TEXT).toContain(
        "A choice on an `ask_user` card also counts as that request, when the text of the chosen option names the step and its target.",
      );
      expect(CONVENTIONS_TEXT).toContain("The choice is a request and not an approval. Only the approve button gives an approval.");
    });
    it("keeps a test file out of a directory that another process watches or reads", () => {
      // A probe file written into a watched directory runs the
      // service for real, so the rule that keeps it away belongs next to the copy rule.
      expect(CONVENTIONS_TEXT).toContain(
        "- A test never creates a file in a directory that another process watches or reads as input.",
      );
      expect(CONVENTIONS_TEXT).toContain("Point the test at a directory of its own under the job directory.");
    });

    it("keeps a test's directories temporary and fake, so it names no real path of the install", () => {
      // A plan wrote the memory directory into its test
      // code, and the commit hooks read a staged file and not a plan, so the rule
      // has to say that a plan's test code follows it too.
      expect(CONVENTIONS_TEXT).toContain("A test builds the directories it needs with");
    });

    it("keeps the rule that reads where a copied program finds the home before it runs it", () => {
      // An installer found the home with `getent passwd`
      // and wrote into the real one while `HOME` named a job directory.
      expect(CONVENTIONS_TEXT).toContain("Before a test runs a copy of someone else's program");
    });

    it("keeps bwrap as the isolation means for a program that `HOME` cannot hold", () => {
      // A program that ignores `HOME` still runs, inside bwrap with an empty directory
      // over the home. A temporary systemd unit is optional, because a machine can have
      // no user manager.
      expect(CONVENTIONS_TEXT).toContain("run it under `bwrap --unshare-user` with an empty directory mounted over the home");
      expect(CONVENTIONS_TEXT).toContain("Wrap it in a temporary systemd unit only where");
    });

    it("keeps the user's own record for the root and a focused chat", () => {
      // The root reads and writes it, a focused
      // chat reads it, and no other agent opens it.
      expect(CONVENTIONS_TEXT).toContain("## The user's own record");
      expect(CONVENTIONS_TEXT).toContain("Only the root conversation reads that file and writes it.");
      expect(CONVENTIONS_TEXT).toContain("Every other agent asks the root for the facts that its work needs.");
      // The approval rule says a memory file changes only on an approved plan. The user's own
      // words are the fact, so the root writes a stated fact at once and needs no plan for it.
      expect(CONVENTIONS_TEXT).toContain(
        "When the user states a fact about the user, the root writes it into that file in the same turn. That write needs no approved plan, because the user's own words are the fact.",
      );
    });
  });

  describe("the reports section and a result report", () => {
    it("names the three kinds, and Done as the approve button of a result report", () => {
      // Done is defined in one place, the common conventions, so no role file has to
      // say what a result report's approve button is called.
      expect(CONVENTIONS_TEXT).toContain("- A report has one of three kinds.");
      expect(CONVENTIONS_TEXT).toContain("A plan asks the user to approve work that has not started, and the viewer shows it with the Approve button.");
      expect(CONVENTIONS_TEXT).toContain("The viewer shows it with two buttons, Done and Feedback, from the start, and the report list shows it under Results.");
      expect(CONVENTIONS_TEXT).toContain("Do not guess the kind from the title.");
      expect(CONVENTIONS_TEXT).toContain("- Done is the approve button of a result report.");
      // The marker field the route writes is named in the rule, because that is what
      // tells a Done from an Approve in the input the root reads.
      expect(CONVENTIONS_TEXT).toContain("its first line also carries `button=done`");
      expect(CONVENTIONS_TEXT).toContain("every gate that asks for an approved report accepts it");
      // A result report ends by asking for the press that closes it.
      expect(CONVENTIONS_TEXT).toContain("End a result report with one sentence that asks the user to press Done, or to write Feedback for more in the same report.");
    });

    it("names the briefing kind, and the archive that keeps one briefing live", () => {
      // The third kind is defined beside the other two, so the rule that a briefing
      // asks for no approval stands in one place.
      expect(CONVENTIONS_TEXT).toContain("- A briefing report carries the morning briefing.");
      expect(CONVENTIONS_TEXT).toContain("It asks for no approval, so the viewer shows only Feedback, and the report list shows it at the top, under Briefing.");
      expect(CONVENTIONS_TEXT).toContain("A new briefing report moves every earlier briefing report with its inbox notices, and every inbox notice of kind `briefing`, to the archive, so only the newest briefing stays in the live store.");
      expect(CONVENTIONS_TEXT).toContain("An archived briefing still resolves by its id, but it takes no feedback and no answer.");
      // The ten items do not apply to it, and the language and style rules still do.
      expect(CONVENTIONS_TEXT).toContain("A briefing report is not a draft and asks for no approval, so these ten items do not apply to it.");
    });

    it("says what a Done with text asks for, and what Feedback on a result report asks for", () => {
      expect(CONVENTIONS_TEXT).toContain("- When Done carries text, that text is a request for follow-up work, and the approval of the result stands as it does without text.");
      expect(CONVENTIONS_TEXT).toContain("The orchestrator in charge opens a new job or sub-job for it.");
      expect(CONVENTIONS_TEXT).toContain("The job of the result report closes by the usual rule, and the follow-up work does not keep it open.");
      expect(CONVENTIONS_TEXT).toContain("- Feedback on a result report asks for more in the same report, such as a missing fact, a missing measurement, or a clearer section.");
    });

    it("sends the user to an ask_user card, not to a typed sentence, for a request in the user's own words", () => {
      expect(CONVENTIONS_TEXT).toContain(
        "Say there that the answer comes on an `ask_user` card. Do not ask the user to write a sentence for it in the chat or in feedback.",
      );
    });
  });

  describe("the orchestrator role file", () => {
    /**
     * The three sentences the delegation change wrote.
     *
     * The role file is read by a model as its instructions, so a later edit that
     * dropped one of these quietly would put the tool calls back in the
     * orchestrator's own context. They are pinned whole here, in the same file that
     * pins the conventions' shipped text.
     */
    async function orchestrator(): Promise<string> {
      return await readFile(join(import.meta.dirname, "..", "prompts", "role", "orchestrator.md"), "utf8");
    }

    it("reads the report drafts it checks, in full, and gives tool execution to a worker", async () => {
      const text = await orchestrator();
      // The first sentence names what the orchestrator reads itself. The code and
      // documents the plan touches are no longer on that list: a wide read is a
      // worker's work now. The plan arrives as the planner's working document, not
      // as a draft, because the orchestrator writes the draft itself.
      expect(text).toContain(
        "- Read the source text that your judgment needs yourself. This includes the user's original words, the planner's working document in full, and the key part of a worker's result.",
      );
      expect(text).not.toContain("the code and documents that the plan touches");
      // The delegation rule holds four kinds of tool execution, and it says what a
      // work instruction has to carry.
      expect(text).toContain("- Give tool execution to a worker as the default.");
      expect(text).toContain("A command, a measurement, a wide read of code or documents, or a search is a worker's work");
      expect(text).toContain("Write the exact command, the paths to read, and the answer you want back.");
      // And the one exception: a number the judgment rests on is measured by the
      // orchestrator itself.
      expect(text).toContain("- Run one short command yourself when the judgment turns on it.");
      expect(text).toContain("a worker's summary of a number is not the number.");
    });

    it("narrows Inspection to the one command that makes the number", async () => {
      const text = await orchestrator();
      expect(text).toContain("Re-run the one command that produces the number, and read the worker's own command output.");
      // The old sentence asked for a re-measurement with no hint of what to run, so
      // it read as "collect everything again yourself".
      expect(text).not.toContain("Measure the count again yourself.");
    });

    it("tells the orchestrator what a restart advice is, and how to act on it", async () => {
      const text = await orchestrator();
      expect(text).toContain("A long context costs more than it saves.");
      expect(text).toContain("The harness puts a restart advice on one of your inputs when your context passes the limit it is set to.");
      // The advice is a suggestion, and the tool call carries no round id, which is
      // what makes it the agent's own restart.
      expect(text).toContain("That advice is a suggestion, not a command:");
      expect(text).toContain("restart your own session with `restart_session`, a reason and no round id.");
      // Telling the parent stays: the parent is the one that decides what comes next.
      expect(text).toContain("Tell the parent agent too.");
    });

    it("asks the root to raise an ask_user card for a write that needs the user's request", async () => {
      const text = await orchestrator();
      expect(text).toContain(
        "say so in the note that sends the draft id. Give the question and the text of each option for an `ask_user` card, and name in each option the step and its target. The root raises the card.",
      );
    });

    it("asks for the target of each decision, and for the list that a run reads", async () => {
      const text = await orchestrator();
      // One block of decisions went into eight scheduled run
      // prompts with no word on which lines each decision covered, so a run re-measured
      // lines that the user had already closed.
      expect(text).toContain(
        "- When one block of decisions goes into the prompts of several scheduled runs, write which targets each decision covers.",
      );
      expect(text).toContain("A target is one item that the run checks.");
      expect(text).toContain("Tell each run to read the current list of targets when it starts.");
      expect(text).toContain("Tell it to skip a target that is already closed.");
    });

    it("keeps the record out of the orchestrator's own reading", async () => {
      const text = await orchestrator();
      expect(text).toContain(
        "The file `user-facts.md` is the one exception: only the root reads it, so ask the root for the facts that the work needs.",
      );
    });
  });

  describe("the root role file", () => {
    it("raises an ask_user card for a request that only the user can make", async () => {
      const text = await readFile(join(import.meta.dirname, "..", "prompts", "role", "root-agent.md"), "utf8");
      expect(text).toContain("raise an `ask_user` card for it in the turn that you publish the plan.");
      expect(text).toContain("Do not ask the user to type a sentence for it in the chat or in feedback.");
      expect(text).toContain("Neither one is an approval:");
    });
  });
});

describe("preamble.test.ts", () => {
  /**
   * The preamble now carries the harness time zone.
   *
   * It belongs here rather than in the conventions section because conventions is a
   * runtime extension and the host context is not passed to one: only the core can
   * read `timezone` out of the config. The value is rendered once per session (the
   * section seal), so this checks the sentence the session commits.
   */

  /** A control structure under a temporary account home, built once. */
  const PATHS = buildPaths(mkdtempSync(join(tmpdir(), "pi-sec-preamble-")));

  function preambleFor(timezone: string): string {
    const config = defaultConfig();
    const context = {
      getConfig: () => ({ ...config, timezone }),
      paths: PATHS,
    } as unknown as ExtensionContext;
    const extension = createCodingExtension(context);
    const section = extension.sections?.find((candidate) => candidate.key === "preamble");
    if (section === undefined) throw new Error("the coding extension has no preamble section");
    return String(section.render({} as never, {} as never));
  }

  describe("the preamble", () => {
    it("names the harness time zone and how to print a time in it", () => {
      const text = preambleFor("Asia/Tokyo");

      expect(text).toContain(
        "The harness timezone is `Asia/Tokyo` (`timezone` in config.json). " +
          "Write times in it: `TZ=Asia/Tokyo date` prints the current time, " +
          "and `TZ=Asia/Tokyo date -d @<seconds>` converts an epoch value.",
      );
      // The lines it already had are untouched.
      expect(text).toContain("You are pi-sec, an autonomous personal secretary running as its own unprivileged Linux user.");
      expect(text).toContain(`Memory is just files: plain markdown under ${PATHS.memoryDir}`);
      // The working directory is the workspace tree under the same home, and the
      // environment factory names it through the same function.
      expect(text).toContain(`Your default working directory is ${PATHS.workspaceTree} (the workspace tree;`);
      expect(text).not.toContain("Asia/Tokyo` (the workspace tree");
    });

    it("follows the configured value, and the default is UTC", () => {
      expect(preambleFor("UTC")).toContain("The harness timezone is `UTC` (`timezone` in config.json).");
      expect(preambleFor("America/New_York")).toContain("`TZ=America/New_York date -d @<seconds>`");
    });
  });
});

describe("js-tool-description.test.ts", () => {
  /**
   * The `js` tool says, where a model reads it, where an identifier comes from.
   *
   * The common conventions carry the rule first,
   * and the tool description repeats it at the moment the model writes a script,
   * because a rule about a script is cheapest to follow there. A description is a
   * string in the extension source, so this test reads the registered tool rather
   * than the source file: that is the text a request carries.
   */
  describe("the js tool description", () => {
    let harness: TestHarness | undefined;

    afterEach(async () => {
      await harness?.close();
      harness = undefined;
    });

    it("takes an id from the value a call returned, not from the script's text", async () => {
      harness = await createTestHarness({
        config: {
          agent: { extensions: { enabled: BUNDLED_EXTENSIONS.map((extension) => extension.name) } },
        } as Partial<Config>,
      });
      const tools = harness.runtime.registry.snapshot().tools();
      const js = tools.find((entry) => entry.tool.name === "js");
      expect(js).toBeDefined();

      // Pinned whole, so a later edit to the description cannot drop the sentence.
      expect(js?.tool.description).toContain(
        "Pass an id that a call creates or prints through the value that the call returned: the same id typed into the script is invented.",
      );
    });
  });
});

describe("tool-argument-schema.test.ts", () => {
  /**
   * A tool refuses an argument its input schema does not name.
   *
   * The schema validator allows unknown keys unless the schema closes the object,
   * so a misspelled or stale argument was dropped without a word and the caller
   * believed it had set something. Every tool a bundled extension defines closes
   * its top-level schema now, and the error names the arguments that were sent.
   *
   * The tools an external library supplies (`read`, `write`, `bash`, ...) and the
   * tools an instance extension adds are out of scope: their schemas are not ours
   * to close.
   */

  /** A context with no runtime behind it: every bundled factory builds against this. */
  function stubContext(): ExtensionContext {
    const paths = buildPaths(join(tmpdir(), "pi-sec-tool-schema"));
    return { getConfig: () => defaultConfig(), paths } as unknown as ExtensionContext;
  }

  /** Tool names the coding extension takes from the library rather than defining. */
  const LIBRARY_TOOLS = new Set((CodingTools.tools ?? []).map((tool) => tool.name));

  /** Every tool a bundled extension defines, with its name and input schema. */
  function bundledTools(): { name: string; parameters: unknown }[] {
    const tools: { name: string; parameters: unknown }[] = [];
    for (const extension of BUNDLED_EXTENSIONS) {
      const built = extension.create(stubContext());
      for (const tool of (built.tools ?? []) as readonly ToolRegistration[]) {
        if (LIBRARY_TOOLS.has(tool.name)) continue;
        tools.push({ name: tool.name, parameters: tool.parameters });
      }
    }
    return tools;
  }

  function toolNamed(name: string): ToolRegistration {
    const extension = BUNDLED_EXTENSIONS.map((candidate) => candidate.create(stubContext())).find((built) =>
      (built.tools ?? []).some((tool) => tool.name === name),
    );
    const found = (extension?.tools ?? []).find((tool) => tool.name === name);
    if (found === undefined) throw new Error(`no bundled tool named ${name}`);
    return found;
  }

  describe("bundled tool input schemas", () => {
    it("closes the top-level schema of every tool a bundled extension defines", () => {
      const tools = bundledTools();
      // The parse itself: a catalog walk that found nothing would pass the check
      // below for the wrong reason.
      expect(tools.length).toBeGreaterThanOrEqual(50);

      const open = tools
        .filter((tool) => (tool.parameters as { additionalProperties?: unknown }).additionalProperties !== false)
        .map((tool) => tool.name);
      expect(open).toEqual([]);
    });

    it("refuses an argument outside the schema, and shows the arguments it got", () => {
      let message = "";
      try {
        validateToolArguments(toolNamed("jobs_get"), { name: "jobs_get", arguments: { id: "x", bogusArg: 1 } });
      } catch (error) {
        message = String(error);
      }

      // The validator's own words, so a caller that reads the error knows the key
      // was not ignored.
      expect(message).toContain("bogusArg: unknown field");
      // The arguments are echoed back, because the fix is to send them again without
      // the key the message names.
      expect(message).toContain("Received arguments:");
      expect(message).toContain('"bogusArg": 1');
    });
  });
});

describe("expiry-check.test.ts", () => {
  const TODAY = "2026-10-17";

  function entry(overrides: Partial<ExpiryEntry> & { name: string; expiresOn: string }): ExpiryEntry {
    return { ...overrides };
  }

  function report(raw: unknown, options: { today?: string; warnDaysDefault?: number } = {}) {
    const entries = parseRegistry(raw, "test-registry");
    return evaluateExpiry(entries, { today: options.today ?? TODAY, warnDaysDefault: options.warnDaysDefault });
  }

  /** The text of a tool result, whatever content parts it carries. */
  function textOf(result: ToolExecutionResult): string {
    const parts = result.output as { type: string; text?: string }[];
    return parts.map((part) => part.text ?? "").join("");
  }

  describe("expiry_check: parseRegistry", () => {
    it("accepts an array of entries, a wrapped list, and a map keyed by name", () => {
      const source = { expires_on: "2026-11-01", note: "rotate", renew: "dashboard" };
      const fromArray = parseRegistry([{ name: "a", ...source }], "s");
      const wrapped = parseRegistry({ entries: [{ name: "a", ...source }] }, "s");
      const keyed = parseRegistry({ a: source }, "s");
      const expected = [{ name: "a", expiresOn: "2026-11-01", note: "rotate", renew: "dashboard" }];
      expect(fromArray).toEqual(expected);
      expect(wrapped).toEqual(expected);
      expect(keyed).toEqual(expected);
    });

    it("reads warn_days_before from the entry", () => {
      const [parsed] = parseRegistry({ a: { expires_on: "2026-11-01", warn_days_before: 7 } }, "s");
      expect(parsed?.warnDaysBefore).toBe(7);
    });
  });

  describe("expiry_check: evaluation", () => {
    it("reports an entry inside the warning window", () => {
      const due = report({ "cf-api-token": { expires_on: "2026-11-01" } });
      expect(due).toEqual([
        expect.objectContaining({ name: "cf-api-token", expires_on: "2026-11-01", daysLeft: 15 }),
      ]);
    });

    it("reports nothing when every entry is outside the window", () => {
      const due = report({
        far: { expires_on: "2027-06-01" },
        alsoFar: { expires_on: "2026-12-01", warn_days_before: 10 },
      });
      expect(due).toEqual([]);
    });

    it("reports an already expired entry, with a negative day count", () => {
      const due = report({ old: { expires_on: "2026-10-01" } });
      expect(due).toHaveLength(1);
      expect(due[0]?.daysLeft).toBe(-16);
    });

    it("counts a whole day left as 1 and treats the expiry day itself as due", () => {
      const due = report({ tomorrow: { expires_on: "2026-10-18" }, today: { expires_on: TODAY } });
      expect(due.map((item) => [item.name, item.daysLeft])).toEqual([
        ["today", 0],
        ["tomorrow", 1],
      ]);
    });

    it("uses 30 days when the entry carries no warn_days_before", () => {
      const registry = { near: { expires_on: "2026-11-06" }, far: { expires_on: "2026-11-17" } };
      expect(DEFAULT_WARN_DAYS).toBe(30);
      expect(report(registry).map((item) => item.name)).toEqual(["near"]);
      // 20 days out is outside a 5-day window and inside the default one.
      expect(report({ near: { expires_on: "2026-11-06" } }, { warnDaysDefault: 5 })).toEqual([]);
      expect(report({ near: { expires_on: "2026-11-06" } }, { warnDaysDefault: 20 })).toHaveLength(1);
    });

    it("lets the entry's own warn_days_before override the default in both directions", () => {
      const due = report({
        late: { expires_on: "2026-11-06", warn_days_before: 90 },
        early: { expires_on: "2026-11-06", warn_days_before: 0 },
      });
      expect(due.map((item) => item.name)).toEqual(["late"]);
    });

    it("carries note and renew into the report and leaves absent ones out", () => {
      const due = report({
        a: { expires_on: "2026-10-20", note: "rotate in dashboard", renew: "operator, 10 minutes" },
        b: { expires_on: "2026-10-21" },
      });
      expect(due[0]).toEqual({
        name: "a",
        expires_on: "2026-10-20",
        daysLeft: 3,
        note: "rotate in dashboard",
        renew: "operator, 10 minutes",
      });
      expect(JSON.parse(JSON.stringify(due[1]))).toEqual({ name: "b", expires_on: "2026-10-21", daysLeft: 4 });
    });

    it("ignores fields the schema does not know", () => {
      const due = report({ a: { expires_on: "2026-10-20", owner: "operator", scope: ["dns:read"] } });
      expect(due).toHaveLength(1);
    });

    it("returns the same list for the same input", () => {
      const raw = { b: { expires_on: "2026-10-20" }, a: { expires_on: "2026-10-20" } };
      expect(report(raw)).toEqual(report(raw));
      // Soonest first, then by name, so an equal count still has one order.
      expect(report(raw).map((item) => item.name)).toEqual(["a", "b"]);
    });
  });

  describe("expiry_check: bad input", () => {
    const cases: Array<[string, unknown]> = [
      ["a shape that is not a date", { a: { expires_on: "17/10/2026" } }],
      ["a month with no 31st", { a: { expires_on: "2026-02-30" } }],
      ["an unpadded month", { a: { expires_on: "2026-1-5" } }],
      ["a missing expires_on", { a: { note: "no date" } }],
      ["a non-string expires_on", { a: { expires_on: 20261101 } }],
      ["a fractional warn_days_before", { a: { expires_on: "2026-11-01", warn_days_before: 1.5 } }],
      ["a negative warn_days_before", { a: { expires_on: "2026-11-01", warn_days_before: -1 } }],
      ["an array entry with no name", [{ expires_on: "2026-11-01" }]],
    ];

    it.each(cases)("rejects %s", (_label, raw) => {
      expect(() => report(raw)).toThrow(ExpiryRegistryError);
    });

    it("rejects a top-level value that is neither an object nor an array", () => {
      expect(() => parseRegistry("nope", "test-registry")).toThrow(ExpiryRegistryError);
    });

    it("names the entry and the bad value in the message", () => {
      expect(() => report({ "cf-token": { expires_on: "2026-13-01" } })).toThrow(/cf-token/);
      expect(() => report({ "cf-token": { expires_on: "2026-13-01" } })).toThrow(/2026-13-01/);
    });

    it("rejects a bad measured day", () => {
      expect(() => evaluateExpiry([entry({ name: "a", expiresOn: "2026-11-01" })], { today: "2026-10-32" })).toThrow(
        ExpiryRegistryError,
      );
    });
  });

  describe("expiry_check: the measured day", () => {
    it("reads the date in a named zone, not the host's", () => {
      // 2026-10-17T16:00Z is 2026-10-18 01:00 in Tokyo and still the 17th in UTC.
      const instant = Date.UTC(2026, 9, 17, 16, 0, 0);
      expect(dayInZone(instant, "UTC")).toBe("2026-10-17");
      expect(dayInZone(instant, "Asia/Tokyo")).toBe("2026-10-18");
      expect(todayInZone(instant, "Asia/Tokyo")).toBe("2026-10-18");
      // No zone named: the harness default, which is UTC and not a fixed operator zone.
      expect(todayInZone(instant)).toBe("2026-10-17");
    });

    it("takes the configured zone when the call names no day", async () => {
      // 15:30Z on the 21st is still the 21st in UTC and already the 22nd in Tokyo,
      // so the two zones disagree about the day the call is measuring against.
      vi.useFakeTimers();
      vi.setSystemTime(Date.UTC(2026, 9, 21, 15, 30, 0));
      const dir = await mkdtemp(join(tmpdir(), "pi-sec-expiry-"));
      try {
        const path = join(dir, "registry.json");
        await writeFile(path, JSON.stringify({ far: { expires_on: "2027-06-01" } }), "utf8");
        const todayOf = async (zone: string): Promise<string> => {
          const tool = createExpiryCheckTool(() => zone);
          const result = await tool.execute({ registryPath: path } as never, {} as never, {} as never);
          return JSON.parse(textOf(result)).today as string;
        };

        expect(await todayOf("UTC")).toBe("2026-10-21");
        expect(await todayOf("Asia/Tokyo")).toBe("2026-10-22");

        // The zone is read at call time, so a reload that changes it lands on the
        // next call rather than on the next restart.
        let zone = "UTC";
        const tool = createExpiryCheckTool(() => zone);
        const run = async (): Promise<string> =>
          JSON.parse(textOf(await tool.execute({ registryPath: path } as never, {} as never, {} as never))).today as string;
        expect(await run()).toBe("2026-10-21");
        zone = "Asia/Tokyo";
        expect(await run()).toBe("2026-10-22");
      } finally {
        vi.useRealTimers();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("expiry_check: the tool", () => {
    let dir: string | undefined;

    afterEach(async () => {
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
      dir = undefined;
    });

    async function writeRegistry(text: string): Promise<string> {
      dir = await mkdtemp(join(tmpdir(), "pi-sec-expiry-"));
      const path = join(dir, "registry.json");
      await writeFile(path, text, "utf8");
      return path;
    }

    // The tool touches neither the execution api nor the harness context, so the
    // call is made with placeholders.
    const call = (tool: ReturnType<typeof createExpiryCheckTool>, args: Record<string, unknown>) =>
      tool.execute(args as never, {} as never, {} as never);

    it("returns only the entries inside the window, as JSON", async () => {
      const path = await writeRegistry(
        JSON.stringify({
          "cf-api-token": { expires_on: "2026-11-01", note: "rotate", renew: "dashboard" },
          "far-away": { expires_on: "2027-06-01" },
        }),
      );
      const result = await call(createExpiryCheckTool(), { registryPath: path, today: TODAY });
      expect(result.isError).toBeFalsy();
      const report = JSON.parse(textOf(result));
      expect(report.today).toBe(TODAY);
      expect(report.warnDaysDefault).toBe(DEFAULT_WARN_DAYS);
      expect(report.due).toEqual([
        { name: "cf-api-token", expires_on: "2026-11-01", daysLeft: 15, note: "rotate", renew: "dashboard" },
      ]);
    });

    it("returns an empty due list when nothing is inside the window", async () => {
      const path = await writeRegistry(JSON.stringify({ far: { expires_on: "2027-06-01" } }));
      const result = await call(createExpiryCheckTool(), { registryPath: path, today: TODAY });
      const report = JSON.parse(textOf(result));
      expect(report.due).toEqual([]);
    });

    it("takes warnDaysDefault from the call", async () => {
      const path = await writeRegistry(JSON.stringify({ a: { expires_on: "2026-11-06" }, b: { expires_on: "2026-10-20" } }));
      const narrow = JSON.parse(textOf(await call(createExpiryCheckTool(), { registryPath: path, today: TODAY, warnDaysDefault: 5 })));
      expect(narrow.due.map((item: { name: string }) => item.name)).toEqual(["b"]);
    });

    it("reports a bad date as an error instead of a list", async () => {
      const path = await writeRegistry(JSON.stringify({ a: { expires_on: "2026-02-30" } }));
      const result = await call(createExpiryCheckTool(), { registryPath: path, today: TODAY });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("2026-02-30");
    });

    it("reports a missing file as an error", async () => {
      const result = await call(createExpiryCheckTool(), { registryPath: "/nonexistent/registry.json", today: TODAY });
      expect(result.isError).toBe(true);
    });

    it("refuses a relative path", async () => {
      const result = await call(createExpiryCheckTool(), { registryPath: "registry.json", today: TODAY });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("absolute");
    });
  });
});

describe("the root role file", () => {
  it("asks for a live job on the same topic before a standing hand-over", async () => {
    // A request on a topic that a watch or a routine already
    // tracks was handed to the standing job first, and the user had to point at the watch.
    const text = await readFile(join(import.meta.dirname, "..", "prompts", "role", "root-agent.md"), "utf8");

    expect(text).toContain("Before you hand such a request over, look in `jobs_list` for a live job on the same topic.");
    expect(text).toContain("A job that runs on a routine is an example.");
    expect(text).toContain("Answer from that job's state file first.");
    expect(text).toContain("Then hand over only the part that the state file does not answer.");
  });

  it("looks for a fact about the user before it writes the fact", async () => {
    // An assumption about a thing the user owns went into a brief, and the file
    // that recorded the fact was never read.
    const text = await readFile(join(import.meta.dirname, "..", "prompts", "role", "root-agent.md"), "utf8");

    expect(text).toContain("A fact about the user is not such an assumption.");
    expect(text).toContain("A fact about the user is what the user is, owns, did, bought, likes, or plans.");
    expect(text).toContain("Look for such a fact before you write it into a brief or an answer.");
    expect(text).toContain("The record is the file `user-facts.md` in the memory directory that the preamble names.");
    expect(text).toContain("Read that file when a session starts, and again when a fact can change your answer.");
    expect(text).toContain("Write down each fact that the user states, in the turn where you hear it.");
    expect(text).toContain("The Standing jobs section decides which job takes a request.");
  });
});

describe("the worker role file", () => {
  it("keeps facts of one installation out of a commit and names the identity list", async () => {
    const text = await readFile(join(import.meta.dirname, "..", "prompts", "role", "worker.md"), "utf8");

    expect(text).toContain("A file and a commit message that you commit carry no fact of one installation.");
    expect(text).toContain("In a test, use an id that a reader can see is made up, such as one with a run of six zeros.");
    expect(text).toContain("Commit only with an author and committer identity from the list of commit identities, the file `commit-identities.txt` in the pi-sec home.");
  });
});

describe("the root role file and proper names", () => {
  it("writes a proper name of a user fact into the word list only after a clean scan", async () => {
    const text = await readFile(join(import.meta.dirname, "..", "prompts", "role", "root-agent.md"), "utf8");

    expect(text).toContain("When you write such a name into `user-facts.md`, also write it into the word list in the same turn.");
    expect(text).toContain("Add the name only when the scan reports 0 findings.");
    expect(text).toContain("Tell the user that the name is not in the word list, and how many files of the repository hold it.");
  });
});

describe("the focused chat role file", () => {
  it("sends the root a fact that the user states", async () => {
    // A focused chat cannot write a memory file, so a fact it hears reaches the record
    // only through the root.
    const text = await readFile(join(import.meta.dirname, "..", "prompts", "role", "focused-chat.md"), "utf8");

    expect(text).toContain("Ask the root in three cases.");
    expect(text).toContain("The user states a fact about the user or the user's life.");
    expect(text).toContain("Put the fact in the user's own words and name this conversation's id.");
  });
});
