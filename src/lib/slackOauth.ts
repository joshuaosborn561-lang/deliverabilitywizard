import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function exchangeSlackOauth(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ botToken: string; botUserId?: string; teamName?: string }> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await response.json()) as {
    ok?: boolean;
    error?: string;
    access_token?: string;
    bot_user_id?: string;
    team?: { name?: string };
  };
  if (!json.ok || !json.access_token) {
    throw new Error(json.error || "Slack OAuth failed");
  }
  return {
    botToken: json.access_token,
    botUserId: json.bot_user_id,
    teamName: json.team?.name,
  };
}

export async function writeSlackBotTokenFile(
  filePath: string,
  token: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${token.trim()}\n`, { mode: 0o600 });
}
