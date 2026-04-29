/**
 * db/index.ts — Re-exports the complete public API of the db layer.
 *
 * Existing callers import from `"../db.js"` which resolves to `db.ts` (the
 * facade). That facade re-exports from here. New callers may import from
 * `"../db/index.js"` directly — same public surface either way.
 *
 * Extracted from db.ts as part of Track C decomposition (v1.24).
 */

// Connection + lifecycle
export { getDb, _setDb, _resetDb } from "./connection";

// Users + auth
export type { User, MagicToken } from "./users";
export {
  createUser,
  getUserById,
  getUserByToken,
  getUserByEmail,
  getUserGenomeKeyEncrypted,
  setUserGenomeKeyEncrypted,
  setUserAdmin,
  tryRecordDailyCapNotification,
  getUserByGitHubId,
  upsertGitHubIdentity,
  createMagicToken,
  getMagicToken,
  markMagicTokenUsed,
  countRecentMagicTokens,
  getOrCreateUserByEmail,
  issueApiToken,
  storePendingAuthToken,
  consumeVerifiedTokenForEmail,
  storePendingAuthTokenBySid,
  consumePendingAuthTokenBySid,
  getVerifiedTokenForEmail,
} from "./users";

// Stats + usage
export type { StatsUpload, DailyUsage, LlmCall, LogLlmCallParams, NudgeEventRow } from "./stats";
export {
  upsertStatsUpload,
  getLatestUpload,
  aggregateUploads,
  bumpDailyUsage,
  checkDailyCap,
  getDailyUsage,
  logLlmCall,
  getLlmCallsForUser,
  insertNudgeEvents,
  aggregateNudgeEvents,
} from "./stats";

// Billing + subscriptions + teams
export type { Subscription, StripeProduct, Team, TeamMember, TeamInvite } from "./billing";
export {
  setUserTier,
  getSubscriptionByUserId,
  userIsTrialEligible,
  getSubscriptionByStripeSubId,
  getSubscriptionByStripeCustomerId,
  upsertSubscription,
  tryMarkStripeEventProcessed,
  deleteStripeEvent,
  getStripeProduct,
  upsertStripeProduct,
  getUserByStripeCustomerId,
  createTeam,
  getTeamById,
  getTeamForUser,
  listTeamMembers,
  createTeamInvite,
  getTeamInvite,
  listTeamInvites,
  revokeTeamInvite,
  acceptTeamInvite,
} from "./billing";

// Genome + key envelopes + personal genomes + policy + audit + webhooks
export type {
  Genome,
  GenomeSection,
  GenomeConflict,
  GenomePubkey,
  KeyEnvelope,
  PolicyRule,
  PolicyRules,
  PolicyPack,
  PolicyCurrent,
  AuditEvent,
  AppendAuditEventParams,
  QueryAuditEventsParams,
  WebhookEvent,
} from "./genome";
export {
  upsertGenome,
  getGenomeById,
  requireGenomeAccess,
  deleteGenome,
  bumpGenomeSeq,
  upsertGenomeSection,
  setEncryptionRequired,
  getGenomeSectionsSince,
  getGenomeSectionByPath,
  upsertGenomeConflict,
  getGenomeConflicts,
  resolveGenomeConflict,
  logGenomePush,
  setUserGenomePubkey,
  getUserGenomePubkey,
  upsertKeyEnvelope,
  getKeyEnvelopeForMember,
  listKeyEnvelopesForGenome,
  revokeKeyEnvelope,
  countRecentGenomePushes,
  getPersonalGenomeForUser,
  getPersonalGenomeByRepoUrl,
  listPersonalGenomesForUser,
  updateGenomeBuildStatus,
  createPolicyPack,
  getPolicyPackById,
  getCurrentPolicyPack,
  getPolicyPackHistory,
  getPolicyPackByVersion,
  setCurrentPolicyPack,
  appendAuditEvent,
  queryAuditEvents,
  streamAuditEvents,
  recordWebhookEvent,
  hasProcessedDelivery,
  hasProcessedCommit,
  updateWebhookEventStatus,
} from "./genome";

// Admin + status page
export type {
  AdminUserRow,
  OverviewCounts,
  DailyRevenue,
  LlmUsageByTier,
  AdminUserDetail,
  RecentPayment,
  HealthCheck,
  Incident,
  IncidentUpdate,
  StatusSubscriber,
} from "./admin";
export {
  adminListUsers,
  adminCountUsers,
  adminGetRecentSignups,
  adminGetOverviewCounts,
  adminGetRevenueTimeline,
  adminGetLlmUsageByTier,
  adminGetUserDetail,
  adminSetUserComp,
  adminGetRecentPayments,
  adminQueryAuditEvents,
  checkBroadcastRateLimit,
  _resetBroadcastRateLimit,
  adminGetAllUserEmails,
  insertHealthCheck,
  getLatestHealthChecks,
  getUptimeHistory,
  getRecentIncidents,
  getIncidentById,
  getIncidentUpdates,
  createIncident,
  appendIncidentUpdate,
  upsertStatusSubscriber,
  confirmStatusSubscriber,
  removeStatusSubscriber,
  getConfirmedStatusSubscribers,
  countRecentSubscribeAttempts,
} from "./admin";
