import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./ui/App";
import { packetCodec } from "./import-export/codec";
import { scanGaps } from "./domain/gaps";
import { openRepository } from "./storage/indexeddb-repository";
import { suggest } from "./suggestions/deterministic";

const root = createRoot(document.getElementById("root")!);
root.render(
  <main className="app-shell" aria-busy="true">
    <h1>KindRelay</h1>
    <p>Opening local storage…</p>
  </main>,
);
void openRepository("kindrelay")
  .then((repository) =>
    root.render(
      <StrictMode>
        <App
          services={{
            repository,
            suggestions: { suggest },
            gaps: { scan: scanGaps },
            codec: packetCodec,
          }}
        />
      </StrictMode>,
    ),
  )
  .catch((reason: unknown) =>
    root.render(
      <main className="app-shell">
        <h1>KindRelay</h1>
        <p role="alert">
          {reason instanceof Error
            ? reason.message
            : "Unable to open local storage."}
        </p>
      </main>,
    ),
  );
