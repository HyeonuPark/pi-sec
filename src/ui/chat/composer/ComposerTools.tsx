/**
 * The four buttons beside the field, and the three file pickers behind them.
 *
 * The browser's own picker is what the operator asked for: three buttons, three
 * hidden `<input type="file">` elements. The image and file pickers take a
 * handful in one press (`multiple`); the camera takes one photo, and `capture`
 * makes a phone open the camera itself. The fourth button opens the snippet
 * panel instead, because a snippet is typed rather than picked; that panel is
 * another branch's, so the press is handed on through the composer's state.
 *
 * The pictograms are inline SVG rather than a font glyph: a glyph in this row
 * depends on a font the machine may not have, and these have to read the same
 * everywhere. Each input is emptied after a pick, so the same file can be picked
 * twice in a row.
 */
import { useRef } from "preact/hooks";
import { addAttachmentFiles } from "../../state/attachments.ts";
import { openSnippetPane } from "../../state/composer.ts";

/** The mark every button in this row carries. */
const MARK = {
  class: "composer-tool-mark",
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 1.5,
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
  "aria-hidden": "true",
  focusable: "false",
} as const;

/** What a picker returned, taken and then emptied. */
function takePicked(input: HTMLInputElement): void {
  addAttachmentFiles(input.files ?? []);
  input.value = "";
}

/** The row of pickers, in the order the shell draws them. */
export function ComposerTools() {
  const imageInput = useRef<HTMLInputElement | null>(null);
  const cameraInput = useRef<HTMLInputElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  return (
    <div class="composer-tools">
      <button
        id="attach-image"
        type="button"
        class="button composer-tool"
        aria-label="Attach an image"
        title="Attach an image"
        onClick={() => imageInput.current?.click()}
      >
        <svg {...MARK}>
          <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
          <circle cx="5.8" cy="6.8" r="0.9" />
          <path d="M2.6 12 6.2 8.6l2.6 2.4 1.9-1.8 2.7 2.6" />
        </svg>
      </button>
      <button
        id="attach-camera"
        type="button"
        class="button composer-tool"
        aria-label="Take a photo"
        title="Take a photo"
        onClick={() => cameraInput.current?.click()}
      >
        <svg {...MARK}>
          <rect x="1.8" y="4.8" width="12.4" height="8.2" rx="1.5" />
          <path d="M5.6 4.8 6.5 3h3l.9 1.8" />
          <circle cx="8" cy="8.9" r="2.4" />
        </svg>
      </button>
      <button
        id="attach-file"
        type="button"
        class="button composer-tool"
        aria-label="Attach a file"
        title="Attach a file"
        onClick={() => fileInput.current?.click()}
      >
        <svg {...MARK}>
          <path d="M14.29 7.37l-6.13 6.13a4 4 0 0 1-5.66-5.66l6.13-6.13a2.67 2.67 0 0 1 3.77 3.77l-6.13 6.13a1.33 1.33 0 0 1-1.89-1.89l5.66-5.65" />
        </svg>
      </button>
      <button
        id="attach-snippet"
        type="button"
        class="button composer-tool"
        aria-label="Attach a text snippet"
        title="Attach a text snippet"
        onClick={() => openSnippetPane()}
      >
        <svg {...MARK}>
          <path d="M3 2.5h6.5L13 6v7.5H3z" />
          <path d="M9.5 2.5V6H13" />
          <path d="M5.5 8.5h5M5.5 11h3.5" />
        </svg>
      </button>
      <input id="pick-image" type="file" accept="image/*" multiple hidden ref={imageInput} onChange={(event) => takePicked(event.currentTarget)} />
      <input
        id="pick-camera"
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        ref={cameraInput}
        onChange={(event) => takePicked(event.currentTarget)}
      />
      <input id="pick-file" type="file" multiple hidden ref={fileInput} onChange={(event) => takePicked(event.currentTarget)} />
    </div>
  );
}
