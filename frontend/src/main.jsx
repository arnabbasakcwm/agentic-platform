import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted fonts (no request to Google Fonts): Inter for the UI, JetBrains Mono for
// ids, agent keys, model names and JSON.
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
