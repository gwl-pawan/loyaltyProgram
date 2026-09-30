export const DEFAULT_EMAIL_NOTIFICATION_SETTINGS = {
  enabled: true,
  signupBonusEnabled: true,
  orderPointsEnabled: true,
  rewardCreatedEnabled: true,
  rewardAppliedEnabled: true,
  refundEnabled: true,
  pointsExpiryEnabled: true,
  referralEnabled: true,
  birthdayRewardEnabled: true,
  specialDateRewardEnabled: true,
};

export const EMAIL_TEMPLATE_FIELDS = [
  { key: "subject", label: "Subject", maxLength: 160 },
  { key: "title", label: "Heading", maxLength: 160 },
  { key: "intro", label: "Message", maxLength: 1000, multiline: true },
  { key: "note", label: "Note", maxLength: 500, multiline: true },
  { key: "ctaLabel", label: "Button label", maxLength: 80 },
];

export const EMAIL_TEMPLATE_PLACEHOLDERS = [
  "customer_name",
  "store_name",
  "points",
  "points_balance",
  "order_number",
  "order_total",
  "reward",
  "reward_code",
  "refund_amount",
  "expiry_date",
  "reward_heading",
];

export const EMAIL_TEMPLATE_DEFINITIONS = [
  {
    eventType: "signup_bonus",
    label: "Signup bonus",
    description: "Welcome points credited when a customer joins loyalty.",
    defaults: {
      subject: "You earned {{points}} welcome points",
      title: "Your rewards journey starts here",
      intro:
        "Welcome to the loyalty program. We added a bonus to get you started.",
      note: "Keep earning points whenever you shop.",
      ctaLabel: "Visit store",
    },
  },
  {
    eventType: "order_points",
    label: "Order points",
    description: "Points credited after an eligible paid order.",
    defaults: {
      subject: "You earned {{points}} loyalty points",
      title: "{{points}} points were added to your account",
      intro:
        "Thanks for order {{order_number}}. Your new points are ready to use toward future rewards.",
      note: "Keep shopping to unlock your next reward.",
      ctaLabel: "Visit store",
    },
  },
  {
    eventType: "reward_created",
    label: "Reward created",
    description: "A discount, gift card, or store credit created from points.",
    defaults: {
      subject: "Your {{reward}} is ready",
      title: "Your loyalty reward is ready",
      intro: "You turned your points into a reward for your next purchase.",
      note: "Your reward is available in your loyalty account.",
      ctaLabel: "Shop with your reward",
    },
  },
  {
    eventType: "reward_applied",
    label: "Reward applied",
    description: "A loyalty reward applied to a paid order.",
    defaults: {
      subject: "Your loyalty reward was applied",
      title: "Your reward was applied successfully",
      intro:
        "Your loyalty savings for order {{order_number}} have been confirmed.",
      note: "Thank you for putting your points to good use.",
      ctaLabel: "Visit store",
    },
  },
  {
    eventType: "refund_points",
    label: "Refund update",
    description: "Points deducted or returned after a refund.",
    defaults: {
      subject: "Your loyalty balance was updated",
      title: "Your points balance was updated",
      intro:
        "We adjusted your loyalty points for order {{order_number}} after a refund.",
      note: "Your loyalty balance now reflects this refund.",
      ctaLabel: "Visit store",
    },
  },
  {
    eventType: "points_expiring_soon",
    label: "Points expiring soon",
    description: "A reminder before earned points expire.",
    defaults: {
      subject: "{{points}} loyalty points expire soon",
      title: "{{points}} points expire soon",
      intro: "There is still time to turn these points into a loyalty reward.",
      note: "Redeem your points before {{expiry_date}} to keep their value.",
      ctaLabel: "Use your points",
    },
  },
  {
    eventType: "points_expired",
    label: "Points expired",
    description: "A confirmation after points expire.",
    defaults: {
      subject: "{{points}} loyalty points expired",
      title: "{{points}} points have expired",
      intro:
        "These points reached their expiry date and were removed from your balance.",
      note: "New points can still be earned on eligible purchases.",
      ctaLabel: "Start earning again",
    },
  },
  {
    eventType: "referral_claimed",
    label: "Referral claimed",
    description: "A friend joined through a referral.",
    defaults: {
      subject: "Your referral was claimed",
      title: "Your referral was claimed",
      intro:
        "Your referral was recorded. Eligible rewards will be added after the qualifying action.",
      note: "We will let you know when your referral reward is ready.",
      ctaLabel: "Visit store",
    },
  },
  {
    eventType: "referral_rewarded",
    label: "Referral rewarded",
    description: "Referral points credited after the qualifying action.",
    defaults: {
      subject: "You earned {{points}} referral points",
      title: "{{points}} referral points were added",
      intro: "Your referral reward is now available in your loyalty account.",
      note: "Keep sharing to earn more referral rewards.",
      ctaLabel: "Visit store",
    },
  },
  {
    eventType: "birthday_reward",
    label: "Birthday reward",
    description: "Annual birthday points credited to an eligible customer.",
    defaults: {
      subject: "Happy birthday! You received {{points}} loyalty points",
      title: "A birthday gift from us",
      intro:
        "Happy birthday! We added bonus points to your loyalty balance to help you celebrate.",
      note: "Use your points whenever you are ready for your next reward.",
      ctaLabel: "View rewards",
    },
  },
  {
    eventType: "special_date_reward",
    label: "Special date reward",
    description: "Points credited on a customer-selected annual date.",
    defaults: {
      subject: "{{reward_heading}}: You received {{points}} loyalty points",
      title: "{{reward_heading}}",
      intro:
        "We added special reward points to your loyalty balance to celebrate with you.",
      note: "Use your points whenever you are ready for your next reward.",
      ctaLabel: "View rewards",
    },
  },
];

export function normalizeEmailTemplates(value) {
  const source =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};

  return Object.fromEntries(
    EMAIL_TEMPLATE_DEFINITIONS.map(({ eventType, defaults }) => {
      const template = source[eventType];
      const normalized = Object.fromEntries(
        EMAIL_TEMPLATE_FIELDS.map(({ key, maxLength }) => {
          const fieldValue =
            typeof template?.[key] === "string"
              ? template[key].trim().slice(0, maxLength)
              : "";

          return [key, fieldValue === defaults[key] ? "" : fieldValue];
        }).filter(([, fieldValue]) => fieldValue),
      );

      return [eventType, normalized];
    }).filter(([, template]) => Object.keys(template).length > 0),
  );
}

export function renderEmailTemplate(value, variables) {
  return String(value || "").replace(
    /{{\s*([a-z_]+)\s*}}/gi,
    (placeholder, key) => {
      const normalizedKey = key.toLowerCase();

      return Object.hasOwn(variables, normalizedKey)
        ? String(variables[normalizedKey] ?? "")
        : placeholder;
    },
  );
}
