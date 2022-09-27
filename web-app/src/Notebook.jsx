import React from "react";
import styled from "styled-components";
import { CodeMirror, Extension } from "codemirror-x-react";
import { EditorSelection, EditorState, StateField } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { Inspector } from "./Inspector";
import { compact, isEqual } from "lodash";
import { v4 as uuidv4 } from "uuid";

import { cell_keymap } from "./packages/codemirror-nexus/add-move-and-run-cells";
import { deserialize } from "./deserialize-value-to-show";

import { DragDropContext, Draggable, Droppable } from "react-beautiful-dnd";
import { debug_syntax_plugin } from "codemirror-debug-syntax-plugin";
import { codemirror_interactive } from "./packages/codemirror-interactive/codemirror-interactive";

import { Flipper, Flipped } from "react-flip-toolkit";

import { IonIcon } from "@ionic/react";
import {
  codeOutline,
  eyeOutline,
  planetOutline,
  textOutline,
} from "ionicons/icons";

import { ContextMenuWrapper } from "./packages/react-contextmenu/react-contextmenu";
import { basic_javascript_setup } from "./codemirror-javascript-setup";
import { useRealMemo } from "use-real-memo";
import { format_with_prettier } from "./format-javascript-with-prettier";
import { SelectCellsEffect, SelectedCellsField } from "./cell-selection";
import {
  AddCellEffect,
  CellDispatchEffect,
  CellEditorStatesField,
  CellTypeFacet,
  empty_cell,
  FromCellTransactionEffect,
  MoveCellEffect,
  MutateCellMetaEffect,
  RemoveCellEffect,
} from "./NotebookEditor";
import { basic_markdown_setup } from "./basic-markdown-setup";

let CellContainer = styled.div`
  display: flex;
  flex-direction: row;
  align-items: stretch;
  margin-bottom: 1rem;

  will-change: transform;
`;

let InspectorHoverBackground = styled.div``;

let InspectorContainer = styled.div`
  padding-left: calc(16px + 4px);
  padding-right: 16px;
  overflow-y: auto;

  font-size: 16px;
  min-height: 24px;
`;

export let EditorStyled = styled.div`
  background-color: rgba(0, 0, 0, 0.4);
  margin-top: 8px;

  & .cm-content {
    padding: 16px !important;
  }
`;

let CellStyle = styled.div`
  flex: 1 1 0px;
  min-width: 0px;

  /* background-color: rgba(0, 0, 0, 0.4); */
  /* I like transparency better for when the backdrop color changes
     but it isn't great when dragging */
  background-color: #121212;

  font-family: Menlo, "Roboto Mono", "Lucida Sans Typewriter", "Source Code Pro",
    monospace;

  & ${InspectorContainer} {
    transition: all 0.2s ease-in-out;
  }
  &.modified {
    & ${EditorStyled} {
      background-color: rgb(33 28 19);
    }
    & ${InspectorContainer} {
      transition: all 1s ease-in-out;
      opacity: 0.5;
      filter: blur(1px);
    }
  }

  position: relative;
  &::before {
    content: "";
    pointer-events: none;
    position: absolute;
    left: -10px;
    right: 100%;
    top: 0;
    bottom: 0;
  }

  &.pending::before {
    background-color: #4a4a4a;
  }
  &.error::before {
    background-color: #820209;
  }
  &.running::before {
    background-color: white;
  }

  &.selected::after {
    content: "";
    position: absolute;
    inset: -0.5rem;
    left: -1rem;
    background-color: #20a5ba24;
    pointer-events: none;
  }

  border-radius: 3px;
  /* box-shadow: rgba(255, 255, 255, 0) 0px 0px 20px; */
  filter: drop-shadow(0 0px 0px rgba(255, 255, 255, 0));
  transform: scaleX(1);
  transform-origin: top left;

  transition: filter 0.2s ease-in-out, transform 0.2s ease-in-out;

  & ${InspectorHoverBackground} {
    position: relative;

    &::after {
      content: "";
      position: absolute;
      inset: -8px 0 -8px 0;
      background-color: #001c21;
      z-index: -1;
      pointer-events: none;

      transition: opacity 0.2s ease-in-out;
      opacity: 0;
    }
  }

  .dragging &,
  ${CellContainer}:has(.drag-handle:hover) &,
  ${CellContainer}:has(.menu:focus) & {
    /* box-shadow: rgba(255, 255, 255, 0.1) 0px 0px 20px; */
    filter: drop-shadow(0 0 20px rgba(255, 255, 255, 0.1));
    /* transform: scaleX(1.05); */
    transform: translateX(-2px) translateY(-2px);
    z-index: 1;

    & ${InspectorHoverBackground}::after {
      opacity: 1;
    }
  }
  .dragging & {
    --prexisting-transform: translateX(-2px) translateY(-2px);
    animation: shake 0.2s ease-in-out infinite alternate;
  }
`;

let engine_cell_from_notebook_cell = (cell) => {
  return {
    last_run: -Infinity,
    result: null,
    running: false,
  };
};

let DragAndDropListStyle = styled.div`
  display: flex;
  flex-direction: column;
`;

let DragAndDropList = ({ children, nexus_editorview, cell_order }) => {
  return (
    <DragDropContext
      onDragEnd={({ draggableId, destination, source }) => {
        if (destination) {
          nexus_editorview.dispatch({
            effects: MoveCellEffect.of({
              cell_id: draggableId,
              from: source.index,
              to: destination.index,
            }),
          });
        }
      }}
    >
      <Droppable droppableId="cells">
        {(provided) => (
          <DragAndDropListStyle
            {...provided.droppableProps}
            ref={provided.innerRef}
          >
            <Flipper flipKey={cell_order.join(",")} spring={"stiff"}>
              <div data-can-start-cell-selection>{children}</div>
            </Flipper>
            {provided.placeholder}
          </DragAndDropListStyle>
        )}
      </Droppable>
    </DragDropContext>
  );
};

let CellEditorSelection = StateField.define({
  create() {
    return /** @type {null | { cell_id: import("./notebook-types").CellId, selection: EditorSelection }} */ (
      null
    );
  },
  update(value, tr) {
    // for (let {
    //   value: { cell_id, transaction },
    // } of from_cell_effects(tr)) {
    //   if (transaction.selection || transaction.docChanged) {
    //     value = { cell_id, selection: transaction.newSelection };
    //   }
    // }
    return value;
  },
});

/**
 * @param {{
 *  icon: import("react").ReactElement,
 *  label: string,
 *  shortcut?: string,
 * }} props
 */
let ContextMenuItem = ({ icon, label, shortcut }) => {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        whiteSpace: "pre",
      }}
    >
      <span style={{ flex: "0 1 content", transform: "translateY(2px)" }}>
        {icon}
      </span>
      <div style={{ minWidth: 8 }} />
      <span>{label}</span>
      <div style={{ flex: "1 0 40px" }} />
      {shortcut && (
        <div style={{ opacity: 0.5, fontSize: "0.8em" }}>{shortcut}</div>
      )}
    </div>
  );
};

// let blur_cells_when_selecting = EditorState.transactionExtender.of(
//   (transaction) => {
//     if (
//       transaction.startState.field(SelectedCellsField) != null &&
//       transaction.state.field(SelectedCellsField, false) == null
//     ) {
//       // This happens when hot reloading, this extension hasn't reloaded yet, but
//       // the next version of `SelectedCellsFacet` has replaced the old.
//       // Thus, we are looking for the old version of `SelectedCellsFacet` on the new state,
//       // which doesn't exist!!
//       return null;
//     }
//     if (
//       transaction.startState.field(SelectedCellsField) !==
//         transaction.state.field(SelectedCellsField) &&
//       transaction.state.field(SelectedCellsField).length > 0
//     ) {
//       let notebook = transaction.state.field(CellEditorStatesField);
//       return {
//         effects: notebook.cell_order.map((cell_id) =>
//           FromCellTransactionEffect.of({
//             cell_id: cell_id,
//             transaction: notebook.cells[cell_id].state.update({ effects: [BlurEffect.of()] }),
//           })
//         ),
//       };
//     }
//     return null;
//   }
// );

/**
 * @param {{
 *  notebook: import("./notebook-types").Notebook,
 *  engine: import("./notebook-types").EngineShadow,
 *  notebook_view: import("./NotebookEditor").NotebookView,
 * }} props
 */
export let CellList = ({ notebook, engine, notebook_view }) => {
  /**
   * Keep track of what cells are just created by the users,
   * so we can animate them in 🤩
   */
  let [last_created_cells, set_last_created_cells] = React.useState(
    /** @type {any[]} */ ([])
  );
  let keep_track_of_last_created_cells_extension = React.useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        let created_cells = update.transactions.flatMap((transaction) =>
          transaction.effects
            .filter((x) => x.is(AddCellEffect))
            .map((x) => x.value.cell.id)
        );
        if (created_cells.length !== 0) {
          set_last_created_cells(created_cells);
        }
      }),
    [set_last_created_cells]
  );

  let nexus_editorview = notebook_view;

  let selected_cells = notebook_view.state.field(SelectedCellsField);

  return (
    <React.Fragment>
      <DragAndDropList
        cell_order={notebook.cell_order}
        nexus_editorview={nexus_editorview}
      >
        <div
          style={{
            height: 0,
            position: "relative",
          }}
        >
          <AddButton
            onClick={() => {
              nexus_editorview.dispatch({
                effects: AddCellEffect.of({
                  index: 0,
                  cell: empty_cell(),
                }),
              });
            }}
          >
            + <span className="show-me-later">add cell</span>
          </AddButton>
        </div>

        {notebook.cell_order
          .map((cell_id) => notebook.cells[cell_id])
          .map((cell, index) => (
            <React.Fragment key={cell.id}>
              <Draggable draggableId={cell.id} index={index}>
                {(provided, snapshot) => (
                  <Flipped flipId={cell.id}>
                    <CellContainer
                      data-can-start-selection={false}
                      ref={provided.innerRef}
                      {...provided.draggableProps}
                      className={
                        snapshot.isDragging && !snapshot.dropAnimation
                          ? "dragging"
                          : ""
                      }
                    >
                      <ContextMenuWrapper
                        options={[
                          {
                            title: (
                              <ContextMenuItem
                                icon={<IonIcon icon={planetOutline} />}
                                label="Delete"
                                shortcut="⌘K"
                              />
                            ),
                            onClick: () => {
                              nexus_editorview.dispatch({
                                effects: [
                                  RemoveCellEffect.of({ cell_id: cell.id }),
                                ],
                              });
                            },
                          },
                          {
                            title: (
                              <ContextMenuItem
                                icon={<IonIcon icon={eyeOutline} />}
                                label="Fold"
                              />
                            ),
                            onClick: () => {
                              notebook_view.dispatch({
                                effects: CellDispatchEffect.of({
                                  cell_id: cell.id,
                                  transaction: {
                                    effects: MutateCellMetaEffect.of((cell) => {
                                      cell.folded = !cell.folded;
                                    }),
                                  },
                                }),
                              });
                            },
                          },
                        ]}
                      >
                        <div
                          style={{
                            minWidth: 30,
                          }}
                          {...provided.dragHandleProps}
                          onClick={() => {
                            notebook_view.dispatch({
                              effects: CellDispatchEffect.of({
                                cell_id: cell.id,
                                transaction: {
                                  effects: MutateCellMetaEffect.of((cell) => {
                                    cell.folded = !cell.folded;
                                  }),
                                },
                              }),
                            });
                          }}
                          className="drag-handle"
                        />
                      </ContextMenuWrapper>
                      {notebook_view.state
                        .field(CellEditorStatesField)
                        .cells[cell.id].facet(CellTypeFacet) === "text" ? (
                        <TextCell
                          cell={cell}
                          editor_state={
                            notebook_view.state.field(CellEditorStatesField)
                              .cells[cell.id]
                          }
                          dispatch_to_nexus={notebook_view.dispatch}
                        />
                      ) : (
                        <Cell
                          cell={cell}
                          cylinder={engine.cylinders[cell.id]}
                          notebook={notebook}
                          is_selected={selected_cells.includes(cell.id)}
                          did_just_get_created={last_created_cells.includes(
                            cell.id
                          )}
                          editor_state={
                            notebook_view.state.field(CellEditorStatesField)
                              .cells[cell.id]
                          }
                          dispatch_to_nexus={notebook_view.dispatch}
                        />
                      )}
                    </CellContainer>
                  </Flipped>
                )}
              </Draggable>
              <div
                style={{
                  height: 0,
                  position: "relative",
                }}
              >
                <ContextMenuWrapper
                  options={[
                    {
                      title: (
                        <ContextMenuItem
                          icon={<IonIcon icon={codeOutline} />}
                          label="Add Code Cell"
                          shortcut="⌘K"
                        />
                      ),
                      onClick: () => {
                        let my_index = notebook.cell_order.indexOf(cell.id);
                        nexus_editorview.dispatch({
                          effects: AddCellEffect.of({
                            index: my_index + 1,
                            cell: empty_cell(),
                          }),
                        });
                      },
                    },
                    {
                      title: (
                        <ContextMenuItem
                          icon={<IonIcon icon={textOutline} />}
                          label="Add Text Cell"
                        />
                      ),
                      onClick: () => {
                        let my_index = notebook.cell_order.indexOf(cell.id);
                        nexus_editorview.dispatch({
                          effects: AddCellEffect.of({
                            index: my_index + 1,
                            cell: empty_cell("text"),
                          }),
                        });
                      },
                    },
                  ]}
                >
                  <AddButton
                    onClick={() => {
                      console.log("Hi");
                      let my_index = notebook.cell_order.indexOf(cell.id);
                      nexus_editorview.dispatch({
                        effects: AddCellEffect.of({
                          index: my_index + 1,
                          cell: empty_cell(),
                        }),
                      });
                    }}
                  >
                    + <span className="show-me-later">add cell</span>
                  </AddButton>
                </ContextMenuWrapper>
              </div>
            </React.Fragment>
          ))}
      </DragAndDropList>
    </React.Fragment>
  );
};

/**
 * @param {{
 *  cell: import("./notebook-types").Cell,
 *  cylinder: import("./notebook-types").CylinderShadow,
 *  notebook: import("./notebook-types").Notebook,
 *  is_selected: boolean,
 *  did_just_get_created: boolean,
 *  editor_state: EditorState | void,
 *  dispatch_to_nexus: (tr: import("@codemirror/state").TransactionSpec) => void,
 * }} props
 */
export let Cell = ({
  cell,
  cylinder = engine_cell_from_notebook_cell(cell),
  notebook,
  is_selected,
  did_just_get_created,
  editor_state,
  dispatch_to_nexus,
}) => {
  let initial_editor_state = useRealMemo(() => {
    return editor_state;
  }, []);
  // let initial_editor_state = useRealMemo(() => {
  //   let _editor_state = /** @type {EditorState} */ (editor_state);
  //   return EditorState.create({
  //     doc: _editor_state.doc.toString(),
  //     extensions: [],
  //   });
  // }, []);

  // prettier-ignore
  let editorview_ref = React.useRef(/** @type {EditorView} */ (/** @type {any} */ (null)));

  let result_deserialized = React.useMemo(() => {
    if (cylinder?.result?.type === "return") {
      return {
        type: cylinder.result.type,
        name: cylinder.result.name,
        value: deserialize(0, cylinder.result.value),
      };
    } else if (cylinder?.result?.type === "throw") {
      return {
        // Because observable inspector doesn't show the stack trace when it is a thrown value?
        // But we need to make our own custom error interface anyway (after we fix sourcemaps? Sighh)
        type: "return",
        value: deserialize(0, cylinder.result.value),
      };
    } else {
      return { type: "pending" };
    }
  }, [cylinder?.result]);

  /** @type {import("react").MutableRefObject<HTMLDivElement>} */
  let cell_wrapper_ref = React.useRef(/** @type {any} */ (null));
  React.useEffect(() => {
    if (did_just_get_created) {
      editorview_ref.current.focus();
      cell_wrapper_ref.current.animate(
        [
          {
            clipPath: `inset(100% 0 0 0)`,
            transform: "translateY(-100%)",
          },
          {
            clipPath: `inset(0 0 0 0)`,
            transform: "translateY(0%)",
          },
        ],
        {
          duration: 200,
        }
      );
    }
  }, []);

  if (initial_editor_state == null) {
    throw new Error("HUH");
  }

  return (
    <CellStyle
      ref={cell_wrapper_ref}
      data-cell-id={cell.id}
      className={compact([
        cylinder.running && "running",
        (cylinder.last_run ?? -Infinity) < (cell.last_run ?? -Infinity) &&
          "pending",
        cylinder.result?.type === "throw" && "error",
        cylinder.result?.type === "return" && "success",
        cell.unsaved_code !== cell.code && "modified",
        is_selected && "selected",
      ]).join(" ")}
    >
      <InspectorHoverBackground>
        <InspectorContainer>
          {result_deserialized.name && (
            <span>
              <span style={{ color: "#afb7d3", fontWeight: "700" }}>
                {result_deserialized.name}
              </span>
              <span>{" = "}</span>
            </span>
          )}
          <Inspector value={result_deserialized} />
        </InspectorContainer>
      </InspectorHoverBackground>

      <EditorStyled
        style={{
          height: cell.folded ? 0 : undefined,
          marginTop: cell.folded ? 0 : undefined,
        }}
      >
        <CodeMirror
          state={initial_editor_state}
          ref={editorview_ref}
          dispatch={(tr, editorview) => {
            // editorview.update([tr]);
            dispatch_to_nexus({
              effects: FromCellTransactionEffect.of({
                cell_id: cell.id,
                transaction: tr,
              }),
            });
          }}
        >
          <Extension
            key="basic-javascript-setup"
            extension={basic_javascript_setup}
          />

          <Extension
            extension={keymap.of([
              {
                key: "Mod-g",
                run: (view) => {
                  try {
                    let x = format_with_prettier({
                      code: view.state.doc.toString(),
                      cursor: view.state.selection.main.head,
                    });
                    view.dispatch({
                      selection: EditorSelection.cursor(x.cursorOffset),
                      changes: {
                        from: 0,
                        to: view.state.doc.length,
                        insert: x.formatted.trim(),
                      },
                    });
                  } catch (e) {}
                  return true;
                },
              },
            ])}
            deps={[]}
          />

          {/* <Extension extension={codemirror_interactive} /> */}
          {/* <Extension extension={debug_syntax_plugin} /> */}
          {/* <Extension extension={inline_notebooks_extension} /> */}

          {/* <Extension
            key="blur_when_other_cell_focus"
            extension={blur_when_other_cell_focus}
          /> */}

          <Extension key="cell_keymap" extension={cell_keymap} />
        </CodeMirror>
      </EditorStyled>
    </CellStyle>
  );
};

/**
 * @param {{
 *  cell: import("./notebook-types").Cell,
 *  cylinder: import("./notebook-types").CylinderShadow,
 *  notebook: import("./notebook-types").Notebook,
 *  is_selected: boolean,
 *  did_just_get_created: boolean,
 *  editor_state: EditorState | void,
 *  dispatch_to_nexus: (tr: import("@codemirror/state").TransactionSpec) => void,
 * }} props
 */
export let TextCell = ({
  cell,
  cylinder = engine_cell_from_notebook_cell(cell),
  notebook,
  is_selected,
  did_just_get_created,
  editor_state,
  dispatch_to_nexus,
}) => {
  let initial_editor_state = useRealMemo(() => {
    return editor_state;
  }, []);
  // let initial_editor_state = useRealMemo(() => {
  //   let _editor_state = /** @type {EditorState} */ (editor_state);
  //   return EditorState.create({
  //     doc: _editor_state.doc.toString(),
  //     extensions: [],
  //   });
  // }, []);

  // prettier-ignore
  let editorview_ref = React.useRef(/** @type {EditorView} */ (/** @type {any} */ (null)));

  let result_deserialized = React.useMemo(() => {
    if (cylinder?.result?.type === "return") {
      return {
        type: cylinder.result.type,
        name: cylinder.result.name,
        value: deserialize(0, cylinder.result.value),
      };
    } else if (cylinder?.result?.type === "throw") {
      return {
        // Because observable inspector doesn't show the stack trace when it is a thrown value?
        // But we need to make our own custom error interface anyway (after we fix sourcemaps? Sighh)
        type: "return",
        value: deserialize(0, cylinder.result.value),
      };
    } else {
      return { type: "pending" };
    }
  }, [cylinder?.result]);

  /** @type {import("react").MutableRefObject<HTMLDivElement>} */
  let cell_wrapper_ref = React.useRef(/** @type {any} */ (null));
  React.useEffect(() => {
    if (did_just_get_created) {
      editorview_ref.current.focus();
      cell_wrapper_ref.current.animate(
        [
          {
            clipPath: `inset(100% 0 0 0)`,
            transform: "translateY(-100%)",
          },
          {
            clipPath: `inset(0 0 0 0)`,
            transform: "translateY(0%)",
          },
        ],
        {
          duration: 200,
        }
      );
    }
  }, []);

  if (initial_editor_state == null) {
    throw new Error("HUH");
  }

  return (
    <TextCellStyle
      ref={cell_wrapper_ref}
      data-cell-id={cell.id}
      className={compact([
        cylinder.running && "running",
        (cylinder.last_run ?? -Infinity) < (cell.last_run ?? -Infinity) &&
          "pending",
        cylinder.result?.type === "throw" && "error",
        cylinder.result?.type === "return" && "success",
        cell.unsaved_code !== cell.code && "modified",
        is_selected && "selected",
      ]).join(" ")}
    >
      <CodeMirror
        state={initial_editor_state}
        ref={editorview_ref}
        dispatch={(tr, editorview) => {
          // editorview.update([tr]);
          dispatch_to_nexus({
            effects: FromCellTransactionEffect.of({
              cell_id: cell.id,
              transaction: tr,
            }),
          });
        }}
      >
        {/* <Extension
            key="basic-javascript-setup"
            extension={basic_javascript_setup}
          /> */}

        <Extension key="markdown-setup" extension={basic_markdown_setup} />

        {/* <Extension extension={codemirror_interactive} /> */}
        <Extension extension={debug_syntax_plugin} />
        {/* <Extension extension={inline_notebooks_extension} /> */}

        {/* <Extension
            key="blur_when_other_cell_focus"
            extension={blur_when_other_cell_focus}
          /> */}

        <Extension key="cell_keymap" extension={cell_keymap} />
      </CodeMirror>
    </TextCellStyle>
  );
};

let TextCellStyle = styled.div`
  flex: 1 1 0px;
  min-width: 0px;

  font-family: system-ui;
  font-size: 1.2em;

  position: relative;

  padding-left: 16px;

  &.selected::after {
    content: "";
    position: absolute;
    inset: -0.5rem;
    left: -1rem;
    background-color: #20a5ba24;
    pointer-events: none;
  }

  .cm-scroller {
    overflow: visible;
  }

  border-radius: 3px;
  /* box-shadow: rgba(255, 255, 255, 0) 0px 0px 20px; */
  filter: drop-shadow(0 0px 0px rgba(255, 255, 255, 0));
  transform: scaleX(1);
  transform-origin: top left;

  transition: filter 0.2s ease-in-out, transform 0.2s ease-in-out;

  .dragging &,
  ${CellContainer}:has(.drag-handle:hover) &,
  ${CellContainer}:has(.menu:focus) & {
    /* box-shadow: rgba(255, 255, 255, 0.1) 0px 0px 20px; */
    filter: drop-shadow(0 0 20px rgba(255, 255, 255, 0.1));
    /* transform: scaleX(1.05); */
    transform: translateX(-2px) translateY(-2px);
    z-index: 1;
  }
  .dragging & {
    --prexisting-transform: translateX(-2px) translateY(-2px);
    animation: shake 0.2s ease-in-out infinite alternate;
  }

  .inline-code {
    background-color: black;

    .code-mark {
      color: red;
    }
  }

  .list-item.cm-line:has(.list-mark) {
    margin-left: -1em;
  }
  .cm-line.list-item:not(:has(.list-mark)) {
    /* Most likely need to tweak this for other em's */
    margin-left: 5px;
  }
  .list-mark {
    color: transparent;
    width: 1em;
    display: inline-block;
  }
  span.list-mark::before {
    content: "-";
    position: absolute;
    /* top: 0; */
    transform: translateY(-4px);
    font-size: 1.2em;
    color: rgba(200, 0, 0);
  }
  .hard-break::after {
    content: "⏎";
    color: rgba(255, 255, 255, 0.2);
  }
  .hr {
    border-top: 1px solid rgba(255, 255, 255, 0.2);
    display: inline-block;
    width: 100%;
    vertical-align: middle;
  }

  /* .blockquote.cm-line {
    margin-left: -1em;
  } */
  .quote-mark {
    color: transparent;
    font-size: 0;
    display: inline-block;
    position: relative;
  }
  .blockquote {
    position: relative;
  }
  .blockquote::before {
    content: "";
    position: absolute;
    margin-left: 0.2em;
    pointer-events: none;
    font-size: 1.2em;
    background-color: rgba(200, 0, 0);
    width: 0.16em;
    top: 0;
    bottom: 0;
    left: -0.6em;
  }

  .emphasis-mark {
    opacity: 0.5;
  }

  .emphasis {
    font-style: italic;
  }
  .strong-emphasis {
    font-weight: bold;
  }
`;

let AddButton = styled.button`
  position: absolute;
  top: calc(100% - 1rem);
  transform: translateY(-25%);
  z-index: 1000;
  left: calc(100% - 20px);
  color: #ffffff82;
  border: none;
  white-space: pre;

  display: flex;
  flex-direction: row;
  align-items: center;

  opacity: 0;
  transition: opacity 0.2s ease-in-out;

  *:hover + div > &,
  div:hover > &,
  div:has(+ *:hover) > & {
    opacity: 1;
  }

  & .show-me-later {
    display: none;
    font-size: 0.8rem;
  }
  &:hover .show-me-later,
  dialog[open] + div & .show-me-later {
    display: inline;
  }
  /* Hehe */
  dialog[open] + div & {
    background-color: white;
    color: black;
  }
`;
