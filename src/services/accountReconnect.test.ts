import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { AccountReconnectService } from "./accountReconnect.js";
import type { InventoryBook, InventorySnapshot } from "./inventory.js";

const LIVE_LIST_ERROR =
  "permission denied for table smart_senders_scheduled_deletions";

function stateFile(): string {
  return `/tmp/reconnect-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

function snapshot(accounts: InventorySnapshot["accounts"]): InventorySnapshot {
  return {
    campaigns: [],
    accounts,
    clients: [],
    fetchedAt: Date.now(),
  };
}

function bookOf(
  accountsOrError: InventorySnapshot["accounts"] | Error,
): InventoryBook {
  return {
    get: async () => {
      if (accountsOrError instanceof Error) throw accountsOrError;
      return snapshot(accountsOrError);
    },
  } as unknown as InventoryBook;
}

function recorder() {
  const sends: { text: string; kind?: string }[] = [];
  const slack = {
    send: async (text: string, _blocks?: unknown[], kind?: string) => {
      sends.push({ text, kind });
    },
    notifyReconnect: async (summary: {
      scanned: number;
      disconnected: number;
      errors: string[];
    }) => {
      sends.push({
        text: `*Disconnected Smartlead accounts*\nChecked ${summary.scanned} accounts. ${summary.disconnected} were disconnected.${
          summary.errors.length
            ? `\nWhat went wrong:\n${summary.errors.map((e) => `• ${e}`).join("\n")}`
            : ""
        }`,
        kind: "action_result",
      });
    },
  };
  return { sends, slack: slack as unknown as SlackClient };
}

function service(opts: {
  book: InventoryBook;
  slack: SlackClient;
  state?: StateStore;
  smartlead?: Partial<SmartleadClient>;
  inventory?: InventorySnapshot;
  dryRun?: boolean;
}): AccountReconnectService {
  const state = opts.state ?? new StateStore(stateFile());
  // Past the first-run seed so real reconnect Slack is not suppressed.
  state.markAlert("reconnect-alert:dedupe-v1");
  const listCalls = { count: 0 };
  const sl = {
    listAllEmailAccounts: async () => {
      listCalls.count += 1;
      throw new Error(`HTTP 500: ${LIVE_LIST_ERROR}`);
    },
    reauthEmailAccount: async () => ({
      ok: true,
      reauthenticated: true,
      skipped: false,
      message: "reconnected",
    }),
    configureWarmup: async () => undefined,
    ...opts.smartlead,
  } as unknown as SmartleadClient;
  (sl as { listCalls: { count: number } }).listCalls = listCalls;
  return new AccountReconnectService(
    loadConfig({ DRY_RUN: opts.dryRun === false ? "false" : "true" }),
    sl,
    null,
    opts.slack,
    state,
    opts.book,
  );
}

describe("AccountReconnectService — shared book (D132/D94)", () => {
  it("scans the carried-over book instead of Checked 0 when email-accounts 500s", async () => {
    const carried = snapshot([
      {
        id: 1,
        from_email: "ok@x.com",
        is_smtp_success: true,
        is_imap_success: true,
      },
      {
        id: 2,
        from_email: "dcd@x.com",
        is_smtp_success: false,
        is_imap_success: true,
      },
    ]);
    const { sends, slack } = recorder();
    let listCalls = 0;
    const svc = service({
      book: bookOf(new Error(`HTTP 500: ${LIVE_LIST_ERROR}`)),
      slack,
      smartlead: {
        listAllEmailAccounts: async () => {
          listCalls += 1;
          throw new Error(`HTTP 500: ${LIVE_LIST_ERROR}`);
        },
      },
    });

    const result = await svc.run({ inventory: carried });

    assert.equal(listCalls, 0, "must not refetch email-accounts");
    assert.equal(result.scanned, 2, "scan the carried book, not 0");
    assert.equal(result.disconnected, 1);
    assert.equal(result.reconnected, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(
      sends.some((s) => /Checked 0 accounts/i.test(s.text)),
      false,
    );
    assert.equal(
      sends.some((s) => /0 were disconnected/i.test(s.text)),
      false,
    );
  });

  it("fail-closes with a one-shot ops_alert when there is no book", async () => {
    const { sends, slack } = recorder();
    const state = new StateStore(stateFile());
    const svc = service({
      book: bookOf(new Error(`HTTP 500: ${LIVE_LIST_ERROR}`)),
      slack,
      state,
    });

    const first = await svc.run();
    assert.equal(first.scanned, 0);
    assert.equal(first.disconnected, 0);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].kind, "ops_alert");
    assert.match(sends[0].text, /mailbox-list API is failing/i);
    assert.match(sends[0].text, /not a disconnect wave/i);
    assert.doesNotMatch(sends[0].text, /Checked 0 accounts/i);
    assert.doesNotMatch(sends[0].text, /0 were disconnected/i);

    const second = await svc.run();
    assert.equal(second.scanned, 0);
    assert.equal(sends.length, 1, "one page per episode, not every health pass");
  });

  it("does not Slack a 429 when there is no book", async () => {
    const { sends, slack } = recorder();
    const svc = service({
      book: bookOf(new Error("HTTP 429")),
      slack,
    });
    const result = await svc.run();
    assert.equal(result.scanned, 0);
    assert.equal(sends.length, 0);
  });
});
