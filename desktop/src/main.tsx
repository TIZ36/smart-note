import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { SpotlightApp } from "./components/spotlight/SpotlightApp";
import "./index.css";
import "./prototype.css";
import "./components/atelier/atelier.css";

// Two render modes:
//   default       → full app (rail + canvas + bottom bar)
//   ?spotlight=1  → SpotlightApp only — renders inside the dedicated
//                   frameless/transparent BrowserWindow created by
//                   electron/main.mjs when ⌘K fires.
const params = new URLSearchParams(window.location.search);
const isSpotlight = params.get("spotlight") === "1";

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    {isSpotlight ? <SpotlightApp /> : <App />}
  </StrictMode>
);
