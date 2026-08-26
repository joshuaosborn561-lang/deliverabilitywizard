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
  signature?: string;
  username?: string;
  email?: string;
  /** Smartlead mailbox ESP type, e.g. GMAIL / OUTLOOK */
  type?: string;
  client_id?: number | null;
  created_at?: string;
  updated_at?: string;
  is_smtp_success?: boolean;
  is_imap_success?: boolean;
  /** Read form of the UI "Message Per Day (Warmups not included)" field. */
  message_per_day?: number;
  /** Write form of message_per_day (POST body). */
  max_email_per_day?: number;
  /** Read form of minimum send gap (minutes). */
  minTimeToWaitInMins?: number | null;
  /** Write form of minimum send gap (minutes). */
  time_to_wait_in_mins?: number | null;
  daily_sent_count?: number;
  tags?: Array<{
    tag_id?: number;
    id?: number;
    tag_name?: string;
    name?: string;
    tag_color?: string;
  }>;
  warmup_details?: {
    id?: number;
    status?: string;
    created_at?: string;
    warmup_created_at?: string;
    reply_rate?: number;
    total_sent_count?: number;
    total_spam_count?: number;
    warmup_reputation?: number | string;
    is_warmup_blocked?: boolean;
    blocked_reason?: string | null;
  } | null;
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
  seq_delay_details?: { delayInDays?: number; delay_in_days?: number };
  subject?: string;
  email_body?: string;
  sequence_variants?: SmartleadSequenceVariant[];
  variants?: SmartleadSequenceVariant[];
  seq_variants?: SmartleadSequenceVariant[];
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
  created_at?: string;
  inbox_count?: number;
  tab_count?: number;
  spam_count?: number;
  adjusted_total_email_count?: number;
  /** Recurrence interval for automated (scheduled) tests. */
  every_days?: number;
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
  provider_name?: string;
  provider_id?: number | string;
  inbox_rate?: number;
  spam_rate?: number;
  bounce_rate?: number;
  mailbox_count?: number;
  inbox_count?: number;
  tab_count?: number;
  spam_count?: number;
  adjusted_total_email_count?: number;
  total_email_count?: number;
  overallTotalCount?: number;
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
