import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYDoc, yDocToBlocks } from "@blocknote/core/yjs";
import { createServerSchema } from "./schema";

/**
 * The XML fragment name apps/web's editor binds to (y-prosemirror's default
 * for BlockNote), so stored state opens in the live editor without a rename.
 */
const FRAGMENT = "document-store";

let headless: BlockNoteEditor<any, any, any> | undefined;

/**
 * One headless editor for the whole process, created on first use. It never
 * renders anything: blocksToYDoc only needs the schema's block/inline specs
 * to turn JSON into Yjs types. Render functions in createServerSchema
 * reference `document`, but they're never invoked on this path.
 */
function headlessEditor(): BlockNoteEditor<any, any, any> {
  headless ??= BlockNoteEditor.create({ schema: createServerSchema() as any, _headless: true } as any) as BlockNoteEditor<any, any, any>;
  return headless;
}

/**
 * BlockNote Block[] JSON → the Yjs update that stores it (`ydoc_state.state`),
 * the same encoding the collab server persists. No jsdom, no DOM: this is
 * what lets apps/worker write page content without @blocknote/server-util.
 */
export function blocksToYDocState(blocks: unknown[]): Uint8Array {
  const doc = blocksToYDoc(headlessEditor(), blocks as any, FRAGMENT);
  return Y.encodeStateAsUpdate(doc);
}

/**
 * The inverse of blocksToYDocState: stored Yjs state → BlockNote Block[] JSON,
 * read through the same schema. For tests and checks that read a stored page
 * back (packages/import doesn't depend on @blocknote/core itself).
 */
export function yDocStateToBlocks(state: Uint8Array): any[] {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return yDocToBlocks(headlessEditor(), doc, FRAGMENT) as any[];
}
