/**
 * NOTE (qbane): the description no longer applies as we moved away from the text-indent hacks :(
 *
 * Plugin that makes line wrapping in the editor respect the identation of the line.
 * It does this by adding a line decoration that adds padding-left (as much as there is indentation),
 * and adds the same amount as negative "text-indent". The nice thing about text-indent is that it
 * applies to the initial line of a wrapped line.
 *
 * The identation decorations have to happen in a StateField (without access to the editor),
 * because they change the layout of the text :( The character width I need however, is in the editor...
 * So I do this ugly hack where I, in `character_width_listener`, I fire an effect that gets picked up
 * by another StateField (`extra_cycle_character_width`) that saves the character width into state,
 * so THEN I can add the markers in the decorations statefield.
 */

import { Facet, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { range } from "lodash-es";

/**
 * Use this to prevent soft-wrapping from going all the way to the right
 * and creating a MONSTER of a line, 1-character-wide, 80 lines high...
 * To disable use `MaxIdentationSpacesFacet.of(Infinity)`
 * @type {Facet<number, number>}
 */
export let MaxIdentationSpacesFacet = Facet.define({
  combine: (values) => values[0],
});

let line_wrapping_decorations = StateField.define({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let indent_limit = tr.state.facet(MaxIdentationSpacesFacet) ?? 40;

    let tabSize = tr.state.tabSize;
    let previous = tr.startState.field(extra_cycle_character_width, false) ?? {
      measuredSpaceWidth: null,
      defaultCharacterWidth: null,
    };
    let previous_space_width =
      previous.measuredSpaceWidth ?? previous.defaultCharacterWidth;
    let { measuredSpaceWidth, defaultCharacterWidth } = tr.state.field(
      extra_cycle_character_width,
      false
    ) ?? { measuredSpaceWidth: null, defaultCharacterWidth: null };
    let space_width = measuredSpaceWidth ?? defaultCharacterWidth;

    if (space_width == null) return Decoration.none;
    if (
      !tr.docChanged &&
      deco !== Decoration.none &&
      previous_space_width === space_width
    )
      return deco;

    let decorations = [];

    // TODO? Only apply to visible lines? Wouldn't that screw stuff up??
    // TODO? Don't create new decorations when a line hasn't changed?
    for (let i of range(0, tr.state.doc.lines)) {
      let line = tr.state.doc.line(i + 1);
      if (line.length === 0) continue;

      let indented_tabs = 0;
      let indented_spaces = 0;
      let indented_spaces_after_a_tab = 0;
      for (let ch of line.text) {
        // Stop counting after indent limit, because that way all the following code is easier 😅
        if (indented_tabs * tabSize + indented_spaces >= indent_limit) break;

        if (ch === "\t") {
          // Tabs after spaces that aren't a multiple of tabSize are ignored
          if (indented_spaces % tabSize !== 0) break;
          indented_tabs++;
        } else if (ch === " ") {
          if (indented_tabs > 0) {
            indented_spaces_after_a_tab++;
          } else {
            indented_spaces++;
          }
        } else {
          break;
        }
      }
      // TODO? It still breaks when there is a tab and then an amount of spaces
      // ..... that is smaller than the tab size. No idea how to fix, but for now
      // ..... I only care about multiples of tabsize
      // ..... (Works in Safari, breaks in Chrome and Firefox)
      // ..... I guess there is some relation between `text-indent` and `tab-size`? But I don't know what it is.
      indented_spaces =
        indented_spaces +
        (indented_spaces_after_a_tab - (indented_spaces_after_a_tab % tabSize));

      let indent_in_spaces = indented_tabs * tabSize + indented_spaces;
      let offset = indent_in_spaces * space_width;

      let linerwapper = Decoration.line({
        attributes: {
          // Also tried with providing the indent_limit in css form,
          // but not as much luck yet
          // style: `--indented: min(${offset}px, ${indent_limit});`,
          style: `--indented: ${offset}px;`,
          class: "awesome-wrapping-plugin-the-line",
        },
      });
      // Need to push before the tabs one else codemirror gets madddd
      decorations.push(linerwapper.range(line.from, line.from));

      if (indent_in_spaces !== 0) {
        decorations.push(
          Decoration.mark({
            class: "awesome-wrapping-plugin-the-tabs",
          }).range(line.from, line.from + (indented_tabs + indented_spaces))
        );
      }
      // NOTE: Small cool thingy that replaces "superflous" tabs with the "⇥ " character,
      // ..... But not yet sure how to make this work perfect with possible tabs/spaces mixed
      // ..... So leaving it out for now
      // if (characters_that_are_actually_there > indent_in_spaces) {
      //   for (let i of range(indent_in_spaces, indented_tabs)) {
      //     decorations.push(
      //       Decoration.replace({
      //         widget: new ReactWidget(
      //           createElement("span", { style: { opacity: 0.2 } }, "⇥ ")
      //         ),
      //         block: false,
      //       }).range(line.from + i, line.from + i + 1)
      //     );
      //   }
      // }
    }
    return Decoration.set(decorations);
  },
  provide: (f) => EditorView.decorations.from(f),
});

let base_theme = EditorView.baseTheme({
  ".awesome-wrapping-plugin-the-line": {
    "--correction": 0,
    borderLeft: "calc(var(--indented)) solid transparent",
  },
  ".awesome-wrapping-plugin-the-line:before": {
    content: "''",
    marginLeft: "calc(-1 * var(--indented))",
  },
  ".awesome-wrapping-plugin-the-tabs": {
    /* display: inline-block; */
    whiteSpace: "pre",
    verticalAlign: "top",
  },
});

// All the stuff to get the character width inside the state field:
// Could use the css `ch` as well, but feels... wrong? Less versatile?
// (I'm also using codemirror sometimes for non-monospace editors)
/** @type {any} */
const CharacterWidthEffect = StateEffect.define({});
const extra_cycle_character_width = StateField.define({
  create() {
    return {
      defaultCharacterWidth: null,
      measuredSpaceWidth: null,
      measuredTabWidth: null,
    };
  },
  update(value, tr) {
    for (let effect of tr.effects) {
      if (effect.is(CharacterWidthEffect)) return effect.value;
    }
    return value;
  },
});
let character_width_listener = EditorView.updateListener.of((viewupdate) => {
  let width = viewupdate.view.defaultCharacterWidth;
  let { defaultCharacterWidth } = viewupdate.view.state.field(
    extra_cycle_character_width,
    false
  ) ?? { defaultCharacterWidth: null };

  // I assume that codemirror will notice if text size changes,
  // so only then I'll also re-measure the space width.
  if (defaultCharacterWidth !== width) {
    // Tried to adapt so it would always use the dummy line (with just spaces), but it never seems to work
    // https://github.com/codemirror/view/blob/41eaf3e1435ec62ecb128f7e4b8d4df2a02140db/src/docview.ts#L324-L343
    // I guess best to first fix defaultCharacterWidth in CM6,
    // but eventually we'll need a way to actually measures the identation of the line.
    // Hopefully this person will respond:
    // https://discuss.codemirror.net/t/custom-dom-inline-styles/3563/10
    let space_width;
    let tab_width;
    // @ts-ignore

    viewupdate.view.dispatch({
      effects: [
        CharacterWidthEffect.of({
          defaultCharacterWidth: width,
          measuredSpaceWidth: space_width,
          measuredTabWidth: tab_width,
        }),
      ],
    });
  }
});

// When your cursor is just after a soft-wrap, and you press [space], codemirror will trigger a
// "\n" inputHandler, followed by a " " inputHandler.
// Turns out, "\n" inputHandlers normally don't happen: pressing [enter] will skip this entirely.
// So I think it is safe to assume that if we get a "\n" inputHandler, it is because of a soft-wrap, and I can cancel it.
let block_creation_of_weird_newlines = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (text === "\n") {
      return true;
    }
    return false;
  }
);

export let awesome_line_wrapping = [
  EditorView.lineWrapping,
  base_theme,
  extra_cycle_character_width,
  character_width_listener,
  line_wrapping_decorations,
  block_creation_of_weird_newlines,
];
