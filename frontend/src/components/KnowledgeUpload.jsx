import { useRef, useState } from "react";
import { formatBytes } from "../lib/knowledge.js";
import { Icon } from "./icons.jsx";
import { Button } from "./ui.jsx";

// Shared by the project's Knowledge step and the workspace Knowledge page.

/** Drag-and-drop area plus a file picker; `limits` is the API's knowledge limits. */
export function UploadArea({ limits, onFiles, uploading, disabled }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);

  function drop(event) {
    event.preventDefault();
    setOver(false);
    if (!disabled && event.dataTransfer.files.length) onFiles([...event.dataTransfer.files]);
  }

  return (
    <div
      className={["dropzone", over && !disabled && "dropzone--over"].filter(Boolean).join(" ")}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <Icon name="upload" size={22} />
      <div className="dropzone__title">Drop files here, or</div>
      <Button
        variant="primary"
        onClick={() => inputRef.current?.click()}
        loading={uploading}
        disabled={disabled}
      >
        {!uploading && <Icon name="plus" size={14} />}
        Choose files
      </Button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={limits.file_types.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose files to add"
        disabled={disabled}
        onChange={(e) => {
          if (e.target.files.length) onFiles([...e.target.files]);
          e.target.value = "";
        }}
      />
      <div className="dropzone__hint">
        PDF, Word (.docx), text, Markdown or CSV · up to {formatBytes(limits.max_file_bytes)} each ·{" "}
        {limits.max_files} files per project
      </div>
    </div>
  );
}
