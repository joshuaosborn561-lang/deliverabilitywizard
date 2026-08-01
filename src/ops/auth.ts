import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type OpsRole = "owner" | "operator";

export interface OpsSession {
  username: string;
  role: OpsRole;
  csrf: string;
  expiresAt: number;
}

export interface OpsAuthConfig {
  enabled: boolean;
  ownerUsername: string;
  operatorUsername: string;
  ownerToken: string;
  operatorToken: string;
  sessionSecret: string;
  sessionHours: number;
}

const COOKIE_NAME = "dw_ops_session";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class OpsAuth {
  constructor(private readonly config: OpsAuthConfig) {}

  isConfigured(): boolean {
    return (
      this.config.enabled &&
      this.config.sessionSecret.length >= 32 &&
      this.config.ownerToken.length >= 16 &&
      this.config.operatorToken.length >= 16
    );
  }

  configurationError(): string | null {
    if (!this.config.enabled) return "Operations UI is disabled";
    if (this.config.sessionSecret.length < 32) {
      return "OPS_SESSION_SECRET must contain at least 32 characters";
    }
    if (this.config.ownerToken.length < 16) {
      return "OPS_OWNER_TOKEN must contain at least 16 characters";
    }
    if (this.config.operatorToken.length < 16) {
      return "OPS_OPERATOR_TOKEN must contain at least 16 characters";
    }
    return null;
  }

  authenticate(username: string, accessKey: string): OpsSession | null {
    if (!this.isConfigured()) return null;
    const normalized = username.trim().toLowerCase();
    let role: OpsRole;
    let expected: string;
    if (normalized === this.config.ownerUsername.toLowerCase()) {
      role = "owner";
      expected = this.config.ownerToken;
    } else if (normalized === this.config.operatorUsername.toLowerCase()) {
      role = "operator";
      expected = this.config.operatorToken;
    } else {
      return null;
    }
    if (!safeEqual(accessKey, expected)) return null;
    return {
      username: normalized,
      role,
      csrf: randomBytes(18).toString("base64url"),
      expiresAt: Date.now() + this.config.sessionHours * 60 * 60 * 1000,
    };
  }

  sign(session: OpsSession): string {
    const body = Buffer.from(JSON.stringify(session)).toString("base64url");
    const signature = createHmac("sha256", this.config.sessionSecret)
      .update(body)
      .digest("base64url");
    return `${body}.${signature}`;
  }

  verify(signed: string | undefined): OpsSession | null {
    if (!signed || !this.isConfigured()) return null;
    const [body, suppliedSignature, extra] = signed.split(".");
    if (!body || !suppliedSignature || extra) return null;
    const expected = createHmac("sha256", this.config.sessionSecret)
      .update(body)
      .digest("base64url");
    if (!safeEqual(suppliedSignature, expected)) return null;
    try {
      const parsed = JSON.parse(
        Buffer.from(body, "base64url").toString("utf8"),
      ) as OpsSession;
      if (
        !parsed.username ||
        !["owner", "operator"].includes(parsed.role) ||
        !parsed.csrf ||
        !Number.isFinite(parsed.expiresAt) ||
        parsed.expiresAt <= Date.now()
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  sessionFromCookie(cookieHeader: string | undefined): OpsSession | null {
    if (!cookieHeader) return null;
    const cookies = cookieHeader.split(";").map((part) => part.trim());
    const raw = cookies
      .find((part) => part.startsWith(`${COOKIE_NAME}=`))
      ?.slice(COOKIE_NAME.length + 1);
    return this.verify(raw ? decodeURIComponent(raw) : undefined);
  }

  cookie(session: OpsSession): string {
    const maxAge = Math.max(
      0,
      Math.floor((session.expiresAt - Date.now()) / 1000),
    );
    return `${COOKIE_NAME}=${encodeURIComponent(this.sign(session))}; Path=/ops; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
  }

  clearCookie(): string {
    return `${COOKIE_NAME}=; Path=/ops; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
  }
}
