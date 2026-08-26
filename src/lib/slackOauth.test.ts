import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { writeSlackBotTokenFile } from "./slackOauth.js";
import { readSlackBotToken } from "../clients/slack.js";

describe("slack oauth token file", () => {
  it("writes a token the Slack client will prefer over env", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dw-slack-"));
    const file = path.join(dir, "slack-bot-token");
    await writeSlackBotTokenFile(file, "xoxb-test-token");
    assert.equal((await readFile(file, "utf8")).trim(), "xoxb-test-token");
    assert.equal(
      readSlackBotToken({
        botToken: "xoxb-old",
        botTokenFile: file,
        channelLabel: "#test",
      }),
      "xoxb-test-token",
    );
  });
});
