import { FileSpreadsheet, FileText, FileType } from "lucide-react";

// The formats a run's output can be exported or emailed as (made on the server).
export const EXPORT_FORMATS = [
  { id: "docx", label: "Word", ext: ".docx", icon: FileText },
  { id: "pdf", label: "PDF", ext: ".pdf", icon: FileType },
  { id: "csv", label: "CSV", ext: ".csv", icon: FileSpreadsheet },
];
