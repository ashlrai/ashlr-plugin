/**
 * notebook-edit-server-handlers — registers ashlr__notebook_edit into the shared tool registry.
 */

import { registerTool, type ToolCallContext, type ToolResult } from "./_tool-base";
import { ashlrNotebookEdit, formatNotebookEditResult, type NotebookEditArgs } from "./notebook-edit-server";

registerTool({
  name: "ashlr__notebook_edit",
  description:
    "Edit a single cell in a Jupyter notebook (.ipynb). Use instead of native NotebookEdit " +
    "when the notebook is >5KB or has many unrelated cells — only the edited cell and its " +
    "immediate neighbors are returned, with `[N cells unchanged]` for the rest. The full " +
    "notebook is never echoed. Typical savings: 65-75% on multi-cell notebooks. " +
    "Args: notebookPath, cellIndex, newSource, cellType (optional: code|markdown).",
  inputSchema: {
    type: "object",
    properties: {
      notebookPath: { type: "string", description: "Absolute or cwd-relative path to the .ipynb notebook" },
      cellIndex: { type: "number", description: "Zero-based index of the cell to edit" },
      newSource: { type: "string", description: "New source content for the cell" },
      cellType: {
        type: "string",
        enum: ["code", "markdown"],
        description: "Optional: change the cell type (code or markdown)",
      },
    },
    required: ["notebookPath", "cellIndex", "newSource"],
  },
  handler: async (args: Record<string, unknown>, _ctx: ToolCallContext): Promise<ToolResult> => {
    const result = await ashlrNotebookEdit(args as unknown as NotebookEditArgs);
    return { content: [{ type: "text", text: formatNotebookEditResult(result) }] };
  },
});
