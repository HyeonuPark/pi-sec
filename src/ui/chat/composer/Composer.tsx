/**
 * The composer: the form the shell already draws, with the tray, the pickers, the
 * field and the three actions inside it.
 *
 * The form is the shell's element, so `mountAt` puts this component in its place
 * and every id, class and child order stays what the stylesheet already styles.
 * What changes is how the field is fed: it draws {@link composerText}, and a
 * keystroke is the only thing that writes that value. A stream frame, a snapshot
 * after a reconnect and a read of a list all leave it alone, so the text, the
 * caret and the focus survive whatever the server says. Only a send the server
 * accepted empties it.
 *
 * `Enter` submits the form and `Shift+Enter` adds a newline, and an `Enter` that
 * commits an input-method composition (Korean, Japanese, Chinese) does neither:
 * the input method keeps it. The submit handler repeats the check the ring makes,
 * because `Enter` reaches the send without a press on the button.
 */
import { useLayoutEffect, useRef } from "preact/hooks";
import { modelSetupRequired } from "../../state/run.ts";
import { cancelQueuedSend, sendQueued } from "../../state/send-queue.ts";
import {
  autoSize,
  composerText,
  saveComposerDraft,
  setComposerField,
  submitComposer,
} from "../../state/composer.ts";
import { AttachmentTray } from "./AttachmentTray.tsx";
import { ComposerActions } from "./ComposerActions.tsx";
import { ComposerTools } from "./ComposerTools.tsx";

/** The key code a composing `Enter` carries in browsers that have no `isComposing`. */
const COMPOSING_KEY_CODE = 229;

/** The placeholder the shell has always carried, which states the two keys. */
const PLACEHOLDER = "Message pi-sec… (Enter to send, Shift+Enter for newline)";

/** The status a queued message gives a screen reader. */
const QUEUED_STATUS = "Queued. Sends when the agent is idle.";

/** What the page hands the form. */
export interface ComposerProps {
  /**
   * The form's class as the shell wrote it.
   *
   * The composer does not own that attribute: the conversation branch toggles
   * `hidden` on `#composer` when this chat cannot be written to. So the value the
   * element arrived with is drawn back unchanged, and a class another part wrote
   * before this component was mounted survives instead of being rewritten.
   */
  readonly formClass?: string;
}

export function Composer({ formClass = "composer" }: ComposerProps) {
  const text = composerText.value;
  const queued = sendQueued.value;
  const field = useRef<HTMLTextAreaElement | null>(null);

  // The field grows to fit what is in it, and this is the one place that measures
  // it: a keystroke, a restored draft and a cleared field all arrive as a new
  // value, and the height follows in the same commit.
  useLayoutEffect(() => {
    autoSize(field.current);
  }, [text]);

  const onInput = (event: Event) => {
    const element = event.currentTarget as HTMLTextAreaElement;
    cancelQueuedSend();
    composerText.value = element.value;
    saveComposerDraft(element.value);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    // An Enter pressed while an input method composes commits the composition,
    // and some browsers then fire a second Enter keydown for the same press.
    // `isComposing` and key code 229 mark the composing one: the input method
    // keeps it, and nothing is sent.
    if (event.isComposing || event.keyCode === COMPOSING_KEY_CODE) return;
    // A held key fires `repeat` keydowns. They send nothing and add no newline.
    event.preventDefault();
    if (event.repeat) return;
    (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
  };

  const onSubmit = (event: Event) => {
    event.preventDefault();
    void submitComposer();
  };

  return (
    <form id="composer" class={formClass} onSubmit={onSubmit}>
      <AttachmentTray />
      <ComposerTools />
      <textarea
        id="message"
        rows={1}
        placeholder={PLACEHOLDER}
        aria-label="Message"
        class={queued ? "send-queued" : undefined}
        aria-describedby={queued ? "send-queued-status" : undefined}
        disabled={modelSetupRequired.value}
        value={text}
        ref={(element) => {
          field.current = element;
          setComposerField(element);
        }}
        onInput={onInput}
        onKeyDown={onKeyDown}
      />
      {queued ? (
        <span id="send-queued-status" class="sr-only">
          {QUEUED_STATUS}
        </span>
      ) : null}
      <ComposerActions />
    </form>
  );
}
