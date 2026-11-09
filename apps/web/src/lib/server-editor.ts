import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { getDocument } from "@blocknote/server-util/dom";
import { createServerSchema } from "./blocknote-schema";

/**
 * BlockNote ≥0.57's ServerBlockNoteEditor needs a DOM document passed in. On first use it installs that
 * document's window as globalThis.window/document, and it throws if a later editor brings a different one. So every
 * server editor in the process shares this one lazily-created jsdom document (or an existing global DOM, if
 * something already installed one).
 */
let serverDocument: Document | undefined;
function getServerDocument(): Document {
  return (serverDocument ??= globalThis.document?.defaultView ? globalThis.document : getDocument());
}

export function createServerEditor() {
  return ServerBlockNoteEditor.create({ schema: createServerSchema() as any }, getServerDocument());
}
