import { loadingFailed, nextPaint } from "./loading-screen.js";

// Paint the lightweight HTML loader first; the stadium and three.js come after.
nextPaint()
  .then(() => import("./main.js"))
  .catch(loadingFailed);
