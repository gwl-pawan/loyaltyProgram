import { authenticate } from "../shopify.server";
import { logError, parseJsonRequest } from "../services/errors.server";
import {
  claimReferral,
  getOrCreateReferralProfile,
  trackReferralVisit,
} from "../services/referrals.server";
import {
  createReferralApiHandlers,
  REFERRAL_RESPONSE_HEADERS,
} from "../services/referrals-api.server";

const handlers = createReferralApiHandlers({
  authenticateAppProxy: (request) => authenticate.public.appProxy(request),
  parseJsonRequest,
  logError,
  claimReferral,
  getOrCreateReferralProfile,
  trackReferralVisit,
});

export const action = handlers.action;
export const loader = handlers.loader;
export const headers = () => REFERRAL_RESPONSE_HEADERS;
