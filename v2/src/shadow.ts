import { writesAllowed, type AppConfig } from "./config.js";
import type { V2Store } from "./store.js";
import type { ActionKind, IntendedAction } from "./types.js";

export class WriteBlockedError extends Error {
  constructor(kind: ActionKind, reason: string) {
    super(`v2 shadow blocked ${kind}: ${reason}`);
    this.name = "WriteBlockedError";
  }
}

export interface GateResult<T> {
  executed: boolean;
  shadowed: boolean;
  result?: T;
  action: IntendedAction;
}

/**
 * The only path that may touch Smartlead writes, InboxKit writes, or Slack.
 * Default: log the intended action and return without calling `run`.
 */
export class WriteGate {
  constructor(
    private readonly config: AppConfig,
    private readonly store: V2Store,
  ) {}

  allowed(): boolean {
    return writesAllowed(this.config);
  }

  blockedReason(): string | undefined {
    if (this.config.shadow) return "SHADOW=true (default). Writes are off.";
    if (!this.config.writeEnabled) return "WRITE_ENABLED is not true.";
    return undefined;
  }

  async intend<T>(opts: {
    kind: ActionKind;
    campaignId?: number;
    accountId?: number;
    email?: string;
    payload: Record<string, unknown>;
    run: () => Promise<T>;
  }): Promise<GateResult<T>> {
    const blocked = this.blockedReason();
    const shadowed = !this.allowed();
    if (shadowed) {
      const action = await this.store.logIntended({
        kind: opts.kind,
        campaignId: opts.campaignId,
        accountId: opts.accountId,
        email: opts.email,
        payload: opts.payload,
        executed: false,
        shadowed: true,
        writeEnabled: this.config.writeEnabled,
        blockedReason: blocked,
      });
      return { executed: false, shadowed: true, action };
    }
    const result = await opts.run();
    const action = await this.store.logIntended({
      kind: opts.kind,
      campaignId: opts.campaignId,
      accountId: opts.accountId,
      email: opts.email,
      payload: opts.payload,
      executed: true,
      shadowed: false,
      writeEnabled: true,
    });
    return { executed: true, shadowed: false, result, action };
  }
}
