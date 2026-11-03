import { FileSpreadsheet, FileText, FileType } from "lucide-react";

// The formats a run's output can be exported or emailed as (made on the server).
export const EXPORT_FORMATS = [
  { id: "docx", label: "Word", ext: ".docx", icon: FileText },
  { id: "pdf", label: "PDF", ext: ".pdf", icon: FileType },
  { id: "csv", label: "CSV", ext: ".csv", icon: FileSpreadsheet },
];

/**
 * The start of a file name for something from one run's output, like the server's
 * export names: <project>_<agent>_<runid-short> (letters, digits and dashes only).
 */
export function fileBase({ projectName, agentId, runId }) {
  const slug = (text, limit) =>
    (String(text ?? "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, limit).replace(/-+$/, "") || "x");
  return [slug(projectName ?? "project", 40), slug(agentId ?? "output", 40), runId ? slug(runId, 8) : null]
    .filter(Boolean)
    .join("_");
}
