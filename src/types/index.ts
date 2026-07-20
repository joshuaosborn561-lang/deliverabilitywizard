export interface SmartleadCampaign {
  id: number;
  name: string;
  status: string;
  created_at?: string;
  updated_at?: string;
  client_id?: number | null;
}

export interface SmartleadEmailAccount {
  id: number;
  from_email?: string;
  from_name?: string;
  username?: string;
  email?: string;
  is_smtp_success?: boolean;
  is_imap_success?: boolean;
  message_per_day?: number;
  daily_sent_count?: number;
}

export interface SmartleadSequenceVariant {
  id?: number;
  subject?: string;
  email_body?: string;
  variant_label?: string;
}

export interface SmartleadSequence {
  id: number;
  seq_number: number;
  subject?: string;
  email_body?: string;
  sequence_variants?: SmartleadSequenceVariant[];
  variants?: SmartleadSequenceVariant[];
}

export interface SpamTestSummary {
  spam_test_id?: string | number;
  id?: string | number;
  test_name?: string;
  test_type?: string;
  status?: string;
  campaign_id?: string | number | null;
  current_test_run_no?: number;
  schedule_start_time?: string;
  test_end_date?: string | null;
}

export interface CreatedPlacementTest {
  id: string | number;
  test_name?: string;
  status?: string;
  campaign_id?: string | number;
  sequence_mapping_id?: string | number;
  spam_filters?: unknown;
  link_checker?: boolean;
}

export interface ProviderwiseRow {
  provider?: string;
  inbox_rate?: number;
  spam_rate?: number;
  bounce_rate?: number;
  mailbox_count?: number;
}

export interface MailboxSummaryRow {
  id?: string | number;
  from_email?: string;
  esp?: string;
  total_email_count?: number;
  inbox_count?: number;
  tab_count?: number;
  spam_count?: number;
  failed_count?: number;
  placement_score?: number;
  spam_test_id?: string | number;
}

/** IP blacklist row from /spam-test/report/{id}/blacklist */
export interface BlacklistRow {
  reply_id?: string | number;
  to_email?: string;
  domain?: string;
  blacklist_type_value?: string;
  total_blacklist?: number;
  rdns?: string;
  ip?: string;
  details?: string;
  reply?: { from_email?: string };
  "reply.from_email"?: string;
  from_email?: string;
}

/** Domain blacklist report from /spam-test/report/{id}/domain-blacklist */
export interface DomainBlacklistSeedAccount {
  id?: string | number;
  email?: string;
  esp?: string;
  domain_blacklisted?: boolean;
}

export interface DomainBlacklistReport {
  from_email?: string;
  seed_accounts?: DomainBlacklistSeedAccount[];
  /** Some payloads may flatten the flag onto the parent */
  domain_blacklisted?: boolean;
  domain?: string;
}

export interface BlacklistedDomainHit {
  /** Sending domain that is blacklisted, e.g. parlaytechlab.info */
  domain: string;
  fromEmail?: string;
  source: "domain-blacklist" | "ip-blacklist";
  ip?: string;
  listName?: string;
  totalHits?: number;
  details?: string;
  seedEspHits?: string[];
}

export interface CampaignTestPlan {
  campaign: SmartleadCampaign;
  senderEmails: string[];
  sequenceMappingId: number;
  sequenceNumber: number;
  subjectPreview: string;
  batches: string[][];
}
