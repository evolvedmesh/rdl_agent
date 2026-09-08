import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

const el = document.getElementById("root");
if (!el) throw new Error("no #root in the document");

createRoot(el).render(<App />);
