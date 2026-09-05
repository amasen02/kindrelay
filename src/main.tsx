import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
function App() {
  return (
    <main>
      <h1>KindRelay</h1>
      <p>A local-first handover workspace.</p>
      <p>Draft until a human reviews each item.</p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
