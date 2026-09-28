import prisma from "../db.server";
import { tryQueueAndDispatchLoyaltyEmail } from "./email-delivery.server";
import { LOYALTY_EMAIL_EVENTS } from "./email-notifications.server";
import { getLoyaltySettings } from "./loyalty-settings.server";
import { createReferralService } from "./referrals-core.server";
import { createReferralCode, normalizeReferralCode } from "./referrals.shared";

export { createReferralCode, normalizeReferralCode } from "./referrals.shared";

const referralService = createReferralService({
  prisma,
  getLoyaltySettings,
  createReferralCode,
  normalizeReferralCode,
  queueEmail: tryQueueAndDispatchLoyaltyEmail,
  emailEvents: LOYALTY_EMAIL_EVENTS,
});

export const {
  claimReferral,
  getOrCreateReferralProfile,
  issueQualifiedReferralRewards,
  trackReferralVisit,
} = referralService;
