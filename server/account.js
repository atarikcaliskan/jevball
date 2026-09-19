// Thin Durable Object wrappers; all logic is in ledger.js. Each object loads
// its state once under blockConcurrencyWhile and then serves it from memory
// with write-through saves (see the concurrency note at the top of ledger.js).
import { DurableObject } from "cloudflare:workers";
import { evaluate, prepare } from "./jev.js";
import { Ledger, DailyGuard } from "./ledger.js";

const storageOf = (ctx) => ({
  get: (key) => ctx.storage.get(key),
  put: (key, value) => ctx.storage.put(key, value),
  delete: (key) => ctx.storage.delete(key),
});

// One per user id (`idFromName("gh_123")`).
export class PlayAccount extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const guard = () =>
      env.SPEND_GUARD.get(env.SPEND_GUARD.idFromName("global"));
    this.ledger = new Ledger({
      storage: storageOf(ctx),
      env,
      evaluate,
      prepare,
      guard: {
        reserve: (n) => guard().reserve(n),
        settle: (reserved, actual) => guard().settle(reserved, actual),
      },
    });
    ctx.blockConcurrencyWhile(() => this.ledger.load());
  }

  initialize(identity) {
    return this.ledger.initialize(identity);
  }

  snapshot() {
    return this.ledger.snapshot();
  }

  // Awaiting Jev inside decide() opens the input gate, so a second decide()
  // interleaves on purpose; the ledger allows two in flight and no more.
  decide(body) {
    return this.ledger.decide(body);
  }

  topUp(order) {
    return this.ledger.topUp(order);
  }

  reverseTopUp(order) {
    return this.ledger.reverseTopUp(order);
  }
}

// Singleton (`idFromName("global")`): the owner's maximum spend per UTC day.
export class SpendGuard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.guard = new DailyGuard({ storage: storageOf(ctx), env });
    ctx.blockConcurrencyWhile(() => this.guard.load());
  }

  reserve(n) {
    return this.guard.reserve(n);
  }

  settle(reserved, actual) {
    return this.guard.settle(reserved, actual);
  }

  snapshot() {
    return this.guard.snapshot();
  }
}
