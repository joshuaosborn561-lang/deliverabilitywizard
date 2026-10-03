/**
 * D219 — converge type:google / type:m365 / type:azure on Smartlead
 * mailboxes from domain + ESP. Drift-only. Weekday Chicago hours.
 * Never decides from a partial email-accounts page (uses the shared book).
 */

import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { accountEmail } from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import { canonOpsIdleReason } from "../lib/canonOpsHours.js";
import {
  MAILBOX_TYPE_TAGS,
  classifyMailboxSendType,
  typeTagFor,
} from "../lib/mailboxType.js";
import { tagNames } from "./warmupGate.js";
import type { InventoryBook } from "./inventory.js";
import type { InventorySnapshot } from "./inventory.js";

const TAG_BATCH = 25;
const TYPE_TAG_COLOR: Record<string, string> = {
  "type:google": "#34A853",
  "type:m365": "#0078D4",
  "type:azure": "#EB3C00",
};

export interface MailboxTypeTagResult {
  assigned: number;
  removed: number;
  scanned: number;
  skipped?: boolean;
  reason?: string;
}

export class MailboxTypeTagService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: Pick<
      SmartleadClient,
      "ensureTag" | "assignTags" | "removeTags"
    >,
    private readonly book?: InventoryBook,
    private readonly pause: () => Promise<void> = () => sleep(1000),
  ) {}

  async run(
    opts: { inventory?: InventorySnapshot; now?: Date } = {},
  ): Promise<MailboxTypeTagResult> {
    const idle = canonOpsIdleReason({
      timezone: this.config.canonOpsTimezone,
      weekdayOnly: this.config.canonOpsWeekdayOnly,
      hourStart: this.config.canonOpsHourStart,
      hourEnd: this.config.canonOpsHourEnd,
      now: opts.now,
    });
    if (idle) {
      return { assigned: 0, removed: 0, scanned: 0, skipped: true, reason: idle };
    }

    const { accounts } =
      opts.inventory ?? (this.book ? await this.book.get() : { accounts: [] });
    const desired = new Map<number, string>();
    for (const account of accounts) {
      if (!account.id) continue;
      const kind = classifyMailboxSendType({
        type: account.type,
        from_email: accountEmail(account),
        email: accountEmail(account),
        tags: account.tags,
      });
      // Classify without letting a stale tag lock a domain we now know.
      const fromDomain = classifyMailboxSendType({
        type: account.type,
        from_email: accountEmail(account),
        email: accountEmail(account),
      });
      const want = fromDomain ?? kind;
      if (!want) continue;
      desired.set(account.id, typeTagFor(want));
    }

    const assignByTag = new Map<string, number[]>();
    const dropByTag = new Map<string, number[]>();
    for (const account of accounts) {
      const want = desired.get(account.id);
      if (!want) continue;
      const tags = tagNames(account).map((tag) => tag.toLowerCase());
      if (!tags.includes(want)) {
        const list = assignByTag.get(want) ?? [];
        list.push(account.id);
        assignByTag.set(want, list);
      }
      for (const other of MAILBOX_TYPE_TAGS) {
        if (other === want) continue;
        if (tags.includes(other)) {
          const list = dropByTag.get(other) ?? [];
          list.push(account.id);
          dropByTag.set(other, list);
        }
      }
    }

    let assigned = 0;
    let removed = 0;
    if (!this.config.dryRun) {
      for (const [name, ids] of assignByTag) {
        const tag = await this.smartlead.ensureTag(
          name,
          TYPE_TAG_COLOR[name] ?? "#9E9E9E",
        );
        for (const batch of chunk(ids, TAG_BATCH)) {
          await this.smartlead.assignTags(batch, [tag.id]);
          assigned += batch.length;
          await this.pause();
        }
      }
      for (const [name, ids] of dropByTag) {
        const tag = await this.smartlead.ensureTag(
          name,
          TYPE_TAG_COLOR[name] ?? "#9E9E9E",
        );
        for (const batch of chunk(ids, TAG_BATCH)) {
          await this.smartlead.removeTags(batch, [tag.id]);
          removed += batch.length;
          await this.pause();
        }
      }
    } else {
      assigned = [...assignByTag.values()].reduce((n, ids) => n + ids.length, 0);
      removed = [...dropByTag.values()].reduce((n, ids) => n + ids.length, 0);
    }

    console.log(
      `[mailbox-type-tags] assigned=${assigned} removed=${removed} scanned=${accounts.length}${this.config.dryRun ? " (dry-run)" : ""}`,
    );
    return { assigned, removed, scanned: accounts.length };
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
