// Cloudflare entry (wrangler `main`). Kept apart from worker.js so the router
// stays importable in Node, where `cloudflare:workers` does not exist.
import { handle } from "./worker.js";

export { PlayAccount, SpendGuard } from "./account.js";

export default {
  fetch: (request, env) => handle(request, env),
};
