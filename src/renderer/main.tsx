import ReactDOM from "react-dom/client";
import "@excalidraw/excalidraw/index.css";

import "./styles.css";

void import("./App").then(({ default: App }) => {
  ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
});
