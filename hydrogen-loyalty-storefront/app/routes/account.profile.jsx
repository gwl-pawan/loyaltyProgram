import {CUSTOMER_UPDATE_MUTATION} from '~/graphql/customer-account/CustomerUpdateMutation';
import {useEffect, useMemo, useState} from 'react';
import {
  data,
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useOutletContext,
} from 'react-router';
import {
  loadCustomerId,
  deleteBirthdayProfile,
  deleteSpecialDateProfile,
  loadBirthdayProfile,
  loadSpecialDateProfile,
  loadLoyaltyBalance,
  loadLoyaltyHistory,
  loadReferralProfile,
  redeemLoyaltyReward,
  saveBirthdayProfile,
  saveSpecialDateProfile,
} from '~/lib/loyalty';

const REWARD_HISTORY_PAGE_SIZE = 8;

function formatOrderReference(orderName) {
  const reference = String(orderName || '').trim();
  const orderNumber = reference.match(/^#?(\d+)$/)?.[1];

  if (orderNumber) return `#${orderNumber}`;
  return reference.startsWith('gid://') ? '-' : reference || '-';
}

/**
 * @type {Route.MetaFunction}
 */
export const meta = () => {
  return [{title: 'Profile'}];
};

/**
 * @param {Route.LoaderArgs}
 */
export async function loader({context}) {
  await context.customerAccount.handleAuthStatus();

  return loadAccountLoyaltyData(context);
}

/**
 * @param {Route.ActionArgs}
 */
export async function action({request, context}) {
  const {customerAccount} = context;
  const form = await request.formData();

  if (
    request.method === 'POST' &&
    form.get('loyaltyAction') === 'store-credit'
  ) {
    return redeemAccountStoreCredit({context, customerAccount, form});
  }

  if (request.method === 'POST' && form.get('loyaltyAction') === 'birthday') {
    return updateAccountBirthday({context, customerAccount, form});
  }

  if (
    request.method === 'POST' &&
    form.get('loyaltyAction') === 'special-date'
  ) {
    return updateAccountSpecialDate({context, customerAccount, form});
  }

  if (request.method !== 'PUT') {
    return data({error: 'Method not allowed'}, {status: 405});
  }

  try {
    const customer = {};
    const validInputKeys = ['firstName', 'lastName'];
    for (const [key, value] of form.entries()) {
      if (!validInputKeys.includes(key)) {
        continue;
      }
      if (typeof value === 'string' && value.length) {
        customer[key] = value;
      }
    }

    // update customer and possibly password
    const {data, errors} = await customerAccount.mutate(
      CUSTOMER_UPDATE_MUTATION,
      {
        variables: {
          customer,
          language: customerAccount.i18n.language,
        },
      },
    );

    if (errors?.length) {
      throw new Error(errors[0].message);
    }

    if (!data?.customerUpdate?.customer) {
      throw new Error('Customer profile update failed.');
    }

    return {
      actionType: 'profile',
      error: null,
      customer: data?.customerUpdate?.customer,
    };
  } catch (error) {
    return data(
      {actionType: 'profile', error: error.message, customer: null},
      {
        status: 400,
      },
    );
  }
}

export default function AccountProfile() {
  const account = useOutletContext();
  const {loyalty, history, referral, birthday, specialDates} = useLoaderData();
  const navigation = useNavigation();
  /** @type {ActionReturnData} */
  const action = useActionData();
  const profileAction = action?.actionType === 'profile' ? action : null;
  const loyaltyAction = action?.actionType === 'loyalty' ? action : null;
  const birthdayAction = action?.actionType === 'birthday' ? action : null;
  const specialDateAction =
    action?.actionType === 'special-date' ? action : null;
  const customer = profileAction?.customer ?? account?.customer;
  const isProfileSubmitting =
    navigation.state !== 'idle' &&
    navigation.formMethod?.toUpperCase() === 'PUT';
  const isLoyaltySubmitting =
    navigation.state !== 'idle' &&
    navigation.formData?.get('loyaltyAction') === 'store-credit';
  const isBirthdaySubmitting =
    navigation.state !== 'idle' &&
    navigation.formData?.get('loyaltyAction') === 'birthday';
  const isSpecialDateSubmitting =
    navigation.state !== 'idle' &&
    navigation.formData?.get('loyaltyAction') === 'special-date';

  return (
    <div className="account-profile">
      <section className="account-profile__details">
        <div className="account-section-heading">
          <span>Profile</span>
          <h2>My profile</h2>
        </div>
        <Form method="PUT" className="account-profile__form">
          <fieldset>
            <legend>Personal information</legend>
            <div className="account-profile__fields">
              <label htmlFor="firstName">
                First name
                <input
                  id="firstName"
                  name="firstName"
                  type="text"
                  autoComplete="given-name"
                  placeholder="First name"
                  aria-label="First name"
                  defaultValue={customer.firstName ?? ''}
                  minLength={2}
                />
              </label>
              <label htmlFor="lastName">
                Last name
                <input
                  id="lastName"
                  name="lastName"
                  type="text"
                  autoComplete="family-name"
                  placeholder="Last name"
                  aria-label="Last name"
                  defaultValue={customer.lastName ?? ''}
                  minLength={2}
                />
              </label>
            </div>
          </fieldset>
          {profileAction?.error ? (
            <p className="account-profile__error">
              <small>{profileAction.error}</small>
            </p>
          ) : null}
          <button type="submit" disabled={isProfileSubmitting}>
            {isProfileSubmitting ? 'Updating' : 'Update profile'}
          </button>
        </Form>
        <AccountBirthdayForm
          birthday={birthdayAction?.birthday || birthday}
          message={birthdayAction?.message}
          success={birthdayAction?.success}
          isSubmitting={isBirthdaySubmitting}
        />
        <AccountSpecialDateForm
          specialDates={specialDateAction?.specialDates || specialDates}
          message={specialDateAction?.message}
          success={specialDateAction?.success}
          isSubmitting={isSpecialDateSubmitting}
        />
      </section>
      <AccountLoyaltyPanel
        loyalty={loyalty}
        history={history}
        referral={referral}
        actionMessage={loyaltyAction?.message}
        actionSuccess={loyaltyAction?.success}
        isSubmitting={isLoyaltySubmitting}
      />
    </div>
  );
}

async function loadAccountLoyaltyData(context) {
  try {
    const customerId = await loadCustomerId(context.customerAccount);

    if (!customerId) {
      return {
        loyalty: {
          enabled: true,
          isLoggedIn: false,
          loyaltyPoints: 0,
          message: 'Sign in to view loyalty points.',
        },
        history: [],
        referral: null,
        birthday: null,
        specialDates: null,
      };
    }

    const [
      loyaltyResult,
      historyResult,
      referralResult,
      birthdayResult,
      specialDatesResult,
    ] = await Promise.allSettled([
      loadLoyaltyBalance(context, customerId),
      loadLoyaltyHistory(context, customerId),
      loadReferralProfile(context, customerId),
      loadBirthdayProfile(context, customerId),
      loadSpecialDateProfile(context, customerId),
    ]);
    const loyalty =
      loyaltyResult.status === 'fulfilled'
        ? loyaltyResult.value
        : {
            success: false,
            loyaltyPoints: 0,
            storeCreditReward: null,
            message:
              loyaltyResult.reason?.message ||
              'Could not load loyalty balance.',
          };
    const history =
      historyResult.status === 'fulfilled'
        ? historyResult.value?.history || []
        : [];
    const referral =
      referralResult.status === 'fulfilled'
        ? referralResult.value?.referral || null
        : null;
    const birthday =
      birthdayResult.status === 'fulfilled'
        ? birthdayResult.value?.birthday || null
        : null;
    const specialDates =
      specialDatesResult.status === 'fulfilled'
        ? specialDatesResult.value?.specialDates || null
        : null;

    if (historyResult.status === 'rejected') {
      console.error(
        '[hydrogen-account-loyalty] Could not load history',
        historyResult.reason,
      );
    }

    return {
      loyalty: {
        ...loyalty,
        enabled: loyalty.checkoutRedemptionEnabled !== false,
        isLoggedIn: true,
      },
      history,
      referral,
      birthday,
      specialDates,
    };
  } catch (error) {
    console.error(
      '[hydrogen-account-loyalty] Could not load account panel',
      error,
    );

    return {
      loyalty: {
        success: false,
        enabled: true,
        isLoggedIn: true,
        loyaltyPoints: 0,
        storeCreditReward: null,
        message: error?.message || 'Could not load loyalty rewards.',
      },
      history: [],
      referral: null,
      birthday: null,
      specialDates: null,
    };
  }
}

async function updateAccountSpecialDate({context, customerAccount, form}) {
  try {
    const customerId = await loadCustomerId(customerAccount);
    if (!customerId) {
      return data(
        {actionType: 'special-date', success: false, message: 'Sign in first.'},
        {status: 401},
      );
    }

    const slot = Number(form.get('specialDateSlot'));
    const isDelete = form.get('specialDateIntent') === 'delete';
    const result = isDelete
      ? await deleteSpecialDateProfile(context, customerId, slot)
      : await saveSpecialDateProfile(context, customerId, slot, {
          month: Number(form.get('specialDateMonth')),
          day: Number(form.get('specialDateDay')),
        });
    const reward = result.specialDates?.rewards?.find(
      (item) => item.slot === slot,
    );

    return data({
      actionType: 'special-date',
      success: true,
      message: isDelete
        ? `${reward?.heading || 'Special date'} removed.`
        : `${reward?.heading || 'Special date'} saved for annual rewards.`,
      specialDates: result.specialDates,
    });
  } catch (error) {
    return data(
      {
        actionType: 'special-date',
        success: false,
        message: error?.message || 'Could not save special date.',
      },
      {status: 400},
    );
  }
}

async function updateAccountBirthday({context, customerAccount, form}) {
  try {
    const customerId = await loadCustomerId(customerAccount);
    if (!customerId) {
      return data(
        {actionType: 'birthday', success: false, message: 'Sign in first.'},
        {status: 401},
      );
    }

    const result =
      form.get('birthdayIntent') === 'delete'
        ? await deleteBirthdayProfile(context, customerId)
        : await saveBirthdayProfile(context, customerId, {
            month: Number(form.get('birthMonth')),
            day: Number(form.get('birthDay')),
          });

    return data({
      actionType: 'birthday',
      success: true,
      message:
        form.get('birthdayIntent') === 'delete'
          ? 'Birthday removed.'
          : 'Birthday saved for annual rewards.',
      birthday: result.birthday,
    });
  } catch (error) {
    return data(
      {
        actionType: 'birthday',
        success: false,
        message: error?.message || 'Could not save birthday.',
      },
      {status: 400},
    );
  }
}

function AccountBirthdayForm({birthday, message, success, isSubmitting}) {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  return (
    <div className="account-profile__birthday">
      <div className="account-section-heading">
        <span>Loyalty</span>
        <h2>Birthday reward</h2>
      </div>
      {birthday?.enabled ? (
        <div className="account-profile__form">
          <p>
            Add your birth month and day to receive {birthday.points} points
            once a year. Enter it at least {birthday.minimumLeadDays} days
            before the reward date. It is locked after the first save.
          </p>
          <small>{birthday.privacy}</small>
          {message ? (
            <p className={success ? undefined : 'account-profile__error'}>
              <small>{message}</small>
            </p>
          ) : null}
          {birthday.birthday ? (
            <>
              <p>
                <strong>Saved birthday: {birthday.birthday.label}</strong>
              </p>
              <p>{birthday.correctionMessage}</p>
              <Form method="POST" className="account-profile__actions">
                <input type="hidden" name="loyaltyAction" value="birthday" />
                <input type="hidden" name="birthdayIntent" value="delete" />
                <button type="submit" disabled={isSubmitting}>
                  Remove birthday
                </button>
              </Form>
            </>
          ) : birthday.canSetBirthday ? (
            <Form method="POST" className="account-profile__form">
              <input type="hidden" name="loyaltyAction" value="birthday" />
              <div className="account-profile__fields">
                <label htmlFor="birthMonth">
                  Birth month
                  <select id="birthMonth" name="birthMonth" required>
                    <option value="">Select month</option>
                    {months.map((month, index) => (
                      <option key={month} value={index + 1}>
                        {month}
                      </option>
                    ))}
                  </select>
                </label>
                <label htmlFor="birthDay">
                  Birth day
                  <select id="birthDay" name="birthDay" required>
                    <option value="">Select day</option>
                    {Array.from({length: 31}, (_, index) => index + 1).map(
                      (day) => (
                        <option key={day} value={day}>
                          {day}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              </div>
              <div className="account-profile__actions">
                <button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Saving' : 'Save birthday once'}
                </button>
              </div>
            </Form>
          ) : (
            <>
              <p>Your saved birthday has been removed.</p>
              <p>{birthday.correctionMessage}</p>
            </>
          )}
        </div>
      ) : (
        <p>Birthday rewards are currently unavailable.</p>
      )}
    </div>
  );
}

function AccountSpecialDateForm({
  specialDates,
  message,
  success,
  isSubmitting,
}) {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const enabledRewards = (specialDates?.rewards || []).filter(
    (reward) => reward.enabled,
  );

  return (
    <div className="account-profile__birthday">
      <div className="account-section-heading">
        <span>Loyalty</span>
        <h2>Special date rewards</h2>
      </div>
      {enabledRewards.length ? (
        <div className="account-profile__form">
          <p>
            Save a personal date, such as your anniversary, at least{' '}
            {specialDates.minimumLeadDays} days before it occurs.
          </p>
          <small>{specialDates.privacy}</small>
          {message ? (
            <p className={success ? undefined : 'account-profile__error'}>
              <small>{message}</small>
            </p>
          ) : null}
          {enabledRewards.map((reward) => (
            <div key={`${reward.slot}-${reward.date?.label || 'empty'}`}>
              <h3>{reward.heading}</h3>
              <p>Earn {reward.points} points once a year.</p>
              {reward.date ? (
                <p>
                  <strong>Saved date: {reward.date.label}</strong>
                  {reward.lastIssuedYear
                    ? ` · Last rewarded ${reward.lastIssuedYear}`
                    : ''}
                </p>
              ) : null}
              <Form method="POST" className="account-profile__form">
                <input
                  type="hidden"
                  name="loyaltyAction"
                  value="special-date"
                />
                <input
                  type="hidden"
                  name="specialDateSlot"
                  value={reward.slot}
                />
                <div className="account-profile__fields">
                  <label htmlFor={`specialDateMonth-${reward.slot}`}>
                    Month
                    <select
                      id={`specialDateMonth-${reward.slot}`}
                      name="specialDateMonth"
                      defaultValue={reward.date?.month || ''}
                      required
                    >
                      <option value="">Select month</option>
                      {months.map((month, index) => (
                        <option key={month} value={index + 1}>
                          {month}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label htmlFor={`specialDateDay-${reward.slot}`}>
                    Day
                    <select
                      id={`specialDateDay-${reward.slot}`}
                      name="specialDateDay"
                      defaultValue={reward.date?.day || ''}
                      required
                    >
                      <option value="">Select day</option>
                      {Array.from({length: 31}, (_, index) => index + 1).map(
                        (day) => (
                          <option key={day} value={day}>
                            {day}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                </div>
                <div className="account-profile__actions">
                  <button type="submit" disabled={isSubmitting}>
                    {isSubmitting
                      ? 'Saving'
                      : reward.date
                        ? 'Update date'
                        : 'Save date'}
                  </button>
                  {reward.date ? (
                    <button
                      type="submit"
                      name="specialDateIntent"
                      value="delete"
                      disabled={isSubmitting}
                    >
                      Remove date
                    </button>
                  ) : null}
                </div>
              </Form>
            </div>
          ))}
        </div>
      ) : (
        <p>Special date rewards are currently unavailable.</p>
      )}
    </div>
  );
}

async function redeemAccountStoreCredit({context, customerAccount, form}) {
  try {
    const customerId = await loadCustomerId(customerAccount);

    if (!customerId) {
      return data(
        {
          actionType: 'loyalty',
          success: false,
          message: 'Sign in to redeem loyalty points.',
        },
        {status: 401},
      );
    }

    const points = Number(form.get('points'));

    if (!Number.isInteger(points) || points <= 0) {
      return data(
        {
          actionType: 'loyalty',
          success: false,
          message: 'Choose a valid points amount.',
        },
        {status: 400},
      );
    }

    const redemption = await redeemLoyaltyReward(context, customerId, {
      points,
      type: 'store_credit',
    });

    return data({
      actionType: 'loyalty',
      success: true,
      message:
        redemption?.message ||
        `Store credit added: ${formatCurrency(
          redemption?.reward?.amount,
          redemption?.reward?.currencyCode,
        )}`,
    });
  } catch (error) {
    console.error(
      '[hydrogen-account-loyalty] Could not redeem store credit',
      error,
    );

    return data(
      {
        actionType: 'loyalty',
        success: false,
        message: error?.message || 'Could not convert points to store credit.',
      },
      {status: 400},
    );
  }
}

function AccountLoyaltyPanel({
  loyalty,
  history,
  referral,
  actionMessage,
  actionSuccess,
  isSubmitting,
}) {
  const [activeTab, setActiveTab] = useState('store-credit');
  const storeCreditReward = normalizeStoreCreditReward(
    loyalty?.storeCreditReward,
  );
  const defaultStoreCreditPoints = storeCreditReward?.points;
  const points = Number(loyalty?.loyaltyPoints || 0);
  const pointStep = storeCreditReward?.points || 100;
  const maxPoints = storeCreditReward
    ? Math.max(pointStep, Math.floor(points / pointStep) * pointStep)
    : 0;
  const [pointsToConvert, setPointsToConvert] = useState(
    storeCreditReward ? String(storeCreditReward.points) : '',
  );

  useEffect(() => {
    setPointsToConvert(
      defaultStoreCreditPoints ? String(defaultStoreCreditPoints) : '',
    );
  }, [defaultStoreCreditPoints]);

  const selectedPoints = Number(pointsToConvert);
  const selectedCreditAmount =
    storeCreditReward && Number.isFinite(selectedPoints)
      ? storeCreditReward.amount * (selectedPoints / storeCreditReward.points)
      : 0;
  const canRedeem =
    Boolean(storeCreditReward) &&
    loyalty?.enabled !== false &&
    Number.isInteger(selectedPoints) &&
    selectedPoints >= pointStep &&
    selectedPoints % pointStep === 0 &&
    selectedPoints <= points;
  const storeCreditBalance = Number(loyalty?.storeCreditBalance?.amount || 0);
  const currencyCode =
    loyalty?.storeCreditBalance?.currencyCode || loyalty?.currencyCode || 'USD';
  const convertibleCreditAmount = storeCreditReward
    ? Math.floor(points / storeCreditReward.points) * storeCreditReward.amount
    : 0;
  const nextCreditPoints = storeCreditReward
    ? points % storeCreditReward.points === 0
      ? storeCreditReward.points
      : storeCreditReward.points - (points % storeCreditReward.points)
    : 0;
  const message = actionMessage || loyalty?.message;
  const messageClassName = [
    'account-loyalty__message',
    actionSuccess === false || loyalty?.success === false
      ? 'account-loyalty__message--error'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const conversionText = storeCreditReward
    ? formatTemplate(
        loyalty?.accountConversionRateText ||
          '{points} points = {amount} store credit',
        {
          points: storeCreditReward.points.toLocaleString(),
          amount: formatCurrency(storeCreditReward.amount, currencyCode),
        },
      )
    : '';
  const adjustPointsToConvert = (delta) => {
    if (!storeCreditReward) return;

    const currentValue = Number(pointsToConvert);
    const nextValue = Number.isFinite(currentValue)
      ? currentValue + delta
      : storeCreditReward.points;
    const boundedValue = Math.min(
      Math.max(nextValue, storeCreditReward.points),
      maxPoints,
    );

    setPointsToConvert(String(boundedValue));
  };

  return (
    <section className="account-loyalty" aria-label="Loyalty rewards">
      <div className="account-loyalty__header">
        <div className="account-section-heading">
          <span>Loyalty</span>
          <h2>Rewards wallet</h2>
        </div>
        <div
          className="account-loyalty__tabs"
          role="tablist"
          aria-label="Loyalty account sections"
        >
          <button
            type="button"
            role="tab"
            className={activeTab === 'store-credit' ? 'is-active' : ''}
            aria-selected={activeTab === 'store-credit'}
            onClick={() => setActiveTab('store-credit')}
          >
            Store credit
          </button>
          <button
            type="button"
            role="tab"
            className={activeTab === 'history' ? 'is-active' : ''}
            aria-selected={activeTab === 'history'}
            onClick={() => setActiveTab('history')}
          >
            Reward history
          </button>
          <button
            type="button"
            role="tab"
            className={activeTab === 'referrals' ? 'is-active' : ''}
            aria-selected={activeTab === 'referrals'}
            onClick={() => setActiveTab('referrals')}
          >
            Refer a friend
          </button>
        </div>
      </div>

      {message ? <p className={messageClassName}>{message}</p> : null}

      {activeTab === 'store-credit' ? (
        <div className="account-loyalty__panel">
          <div className="account-loyalty__balance-card">
            <div className="account-loyalty__balance-head">
              <span>
                {loyalty?.accountAvailableLabel || 'Available points'}
              </span>
              <h3>{loyalty?.accountBalanceTitle || 'Loyalty balance'}</h3>
            </div>
            <p className="account-loyalty__points">
              <strong>{points.toLocaleString()}</strong>
              <span>{points === 1 ? 'point' : 'points'}</span>
            </p>
            <div className="account-loyalty__mini-stats">
              <div className="account-loyalty__stat account-loyalty__stat--primary">
                <span>Ready to convert</span>
                <strong>
                  {formatCurrency(convertibleCreditAmount, currencyCode)}
                </strong>
              </div>
              <div className="account-loyalty__stat">
                <span>Current store credit</span>
                <strong>
                  {formatCurrency(storeCreditBalance, currencyCode)}
                </strong>
              </div>
              {storeCreditReward ? (
                <div className="account-loyalty__stat">
                  <span>Next credit</span>
                  <strong>{nextCreditPoints.toLocaleString()} pts</strong>
                </div>
              ) : null}
            </div>
          </div>

          {storeCreditReward ? (
            <div className="account-loyalty__convert-card">
              <div className="account-loyalty__convert-copy">
                <div>
                  <h3>
                    {loyalty?.accountStoreCreditTitle || 'Store Credit Reward'}
                  </h3>
                  <p>{conversionText}</p>
                </div>
                <span className="account-loyalty__credit-pill">
                  Available store credit:{' '}
                  {formatCurrency(storeCreditBalance, currencyCode)}
                </span>
              </div>
              <Form method="post" className="account-loyalty__redeem-form">
                <input
                  type="hidden"
                  name="loyaltyAction"
                  value="store-credit"
                />
                <label htmlFor="account-loyalty-points">
                  Points to convert
                </label>
                <div className="account-loyalty__converter">
                  <button
                    type="button"
                    aria-label="Decrease points"
                    disabled={
                      isSubmitting ||
                      loyalty?.enabled === false ||
                      selectedPoints <= pointStep
                    }
                    onClick={() => adjustPointsToConvert(-pointStep)}
                  >
                    -
                  </button>
                  <input
                    id="account-loyalty-points"
                    name="points"
                    type="number"
                    min={pointStep}
                    max={maxPoints}
                    step={pointStep}
                    value={pointsToConvert}
                    onChange={(event) => setPointsToConvert(event.target.value)}
                    disabled={isSubmitting || loyalty?.enabled === false}
                  />
                  <button
                    type="button"
                    aria-label="Increase points"
                    disabled={
                      isSubmitting ||
                      loyalty?.enabled === false ||
                      selectedPoints >= maxPoints
                    }
                    onClick={() => adjustPointsToConvert(pointStep)}
                  >
                    +
                  </button>
                </div>
                <div className="account-loyalty__preview">
                  <span>Store credit value</span>
                  <strong>
                    {formatCurrency(selectedCreditAmount, currencyCode)}
                  </strong>
                </div>
                <button
                  className="account-loyalty__submit"
                  type="submit"
                  disabled={!canRedeem || isSubmitting}
                >
                  {isSubmitting
                    ? loyalty?.accountRedeemingText || 'Redeeming'
                    : loyalty?.accountRedeemButtonText || 'Redeem'}
                </button>
              </Form>
              {loyalty?.enabled === false ? (
                <p>
                  {loyalty?.accountDisabledMsg ||
                    'Store credit conversion is currently disabled.'}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="account-loyalty__convert-card">
              <p>Store credit rewards are not configured yet.</p>
            </div>
          )}
        </div>
      ) : activeTab === 'history' ? (
        <RewardHistory history={history} currencyCode={currencyCode} />
      ) : (
        <div className="account-loyalty__convert-card">
          <h3>Refer a friend</h3>
          {referral?.enabled ? (
            <>
              <p>
                Share your link. You earn {referral.advocatePoints} points and
                your friend earns {referral.friendPoints} points after their
                first paid order.
              </p>
              <label htmlFor="account-referral-link">Your referral link</label>
              <input
                id="account-referral-link"
                type="text"
                readOnly
                value={referral.link}
                onFocus={(event) => event.currentTarget.select()}
              />
              <p>
                {referral.successfulReferrals} successful referral
                {referral.successfulReferrals === 1 ? '' : 's'}
              </p>
            </>
          ) : (
            <p>The referral program is currently unavailable.</p>
          )}
        </div>
      )}
    </section>
  );
}

function RewardHistory({history, currencyCode}) {
  const rows = useMemo(() => history || [], [history]);
  const [page, setPage] = useState(1);
  const pageCount = Math.max(
    1,
    Math.ceil(rows.length / REWARD_HISTORY_PAGE_SIZE),
  );
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * REWARD_HISTORY_PAGE_SIZE;
  const pageRows = rows.slice(pageStart, pageStart + REWARD_HISTORY_PAGE_SIZE);
  const firstItemNumber = rows.length === 0 ? 0 : pageStart + 1;
  const lastItemNumber = Math.min(pageStart + pageRows.length, rows.length);

  useEffect(() => {
    setPage(1);
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="account-loyalty__empty">
        <h3>No reward history</h3>
        <p>
          Your earned points, redemptions, and reward updates will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="account-loyalty__history">
      <div className="account-loyalty__history-header">
        <div>
          <h3>Reward activity</h3>
          <p>
            Latest {rows.length} history log{rows.length === 1 ? '' : 's'}
          </p>
        </div>
        <span>
          {rows.length} item{rows.length === 1 ? '' : 's'}
        </span>
      </div>
      <div
        className={[
          'account-loyalty__history-table-wrap',
          pageCount > 1 ? 'account-loyalty__history-table-wrap--paged' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <table className="account-loyalty__history-table">
          <thead>
            <tr>
              <th>Activity</th>
              <th>Reward code</th>
              <th>Points</th>
              <th>Amount</th>
              <th>Order</th>
              <th>Message</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((item) => {
              const rewardType = getRewardTypeLabel(item.activityType);
              const activityTone = getActivityTone(item.activityType);

              return (
                <tr key={item.id}>
                  <td data-label="Activity">
                    <div className="account-loyalty__activity-cell">
                      <span
                        className={`account-loyalty__badge account-loyalty__badge--${activityTone}`}
                      >
                        {item.label || 'Activity'}
                      </span>
                      <span className="account-loyalty__type-badge">
                        {rewardType}
                      </span>
                    </div>
                  </td>
                  <td data-label="Reward code">
                    <code>{formatRewardCode(item)}</code>
                  </td>
                  <td data-label="Points">{formatPoints(item.pointsUsed)}</td>
                  <td data-label="Amount">
                    {formatAmount(item.discountAmount, currencyCode)}
                  </td>
                  <td data-label="Order">
                    {formatOrderReference(item.orderName)}
                  </td>
                  <td
                    data-label="Message"
                    className="account-loyalty__history-message"
                  >
                    {item.message || '-'}
                  </td>
                  <td data-label="Time">{formatDate(item.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pageCount > 1 ? (
        <div className="account-loyalty__pagination">
          <span>
            Showing {firstItemNumber}-{lastItemNumber} of {rows.length}
          </span>
          <div className="account-loyalty__pagination-actions">
            <button
              type="button"
              disabled={safePage === 1}
              onClick={() =>
                setPage((currentPage) => Math.max(currentPage - 1, 1))
              }
            >
              Previous
            </button>
            <span>
              Page {safePage} of {pageCount}
            </span>
            <button
              type="button"
              disabled={safePage === pageCount}
              onClick={() =>
                setPage((currentPage) => Math.min(currentPage + 1, pageCount))
              }
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function normalizeStoreCreditReward(reward) {
  const points = Number(reward?.points);
  const amount = Number(reward?.amount);

  if (
    reward?.type !== 'store_credit' ||
    !Number.isInteger(points) ||
    points < 1 ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return null;
  }

  return {
    ...reward,
    points,
    amount,
  };
}

function formatTemplate(template, replacements) {
  return Object.entries(replacements).reduce((text, [key, value]) => {
    return text
      .replaceAll(`{${key}}`, String(value))
      .replaceAll(`{{${key}}}`, String(value));
  }, template);
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCurrency(value, currencyCode = 'USD') {
  const amount = Number(value || 0);

  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currencyCode || 'USD',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currencyCode || 'USD'} ${amount.toLocaleString('en')}`;
  }
}

function formatAmount(value, currencyCode) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0
    ? formatCurrency(amount, currencyCode)
    : '-';
}

function formatPoints(value) {
  const points = Number(value);
  return Number.isFinite(points) ? `${points.toLocaleString()} points` : '-';
}

function getRewardTypeLabel(activityType) {
  if (activityType?.startsWith('store_credit')) return 'Store credit';
  if (activityType?.startsWith('gift_card')) return 'Gift card';
  if (activityType === 'points_refunded') return 'Points';
  return 'Discount';
}

function getActivityTone(activityType) {
  if (activityType?.includes('failed')) return 'critical';
  if (activityType?.includes('expired')) return 'warning';
  if (activityType?.includes('created')) return 'info';
  if (activityType?.includes('applied') || activityType?.includes('refunded')) {
    return 'success';
  }
  return 'neutral';
}

function formatRewardCode(item) {
  if (item.activityType?.startsWith('store_credit')) {
    return item.rewardCode || '-';
  }

  return item.rewardCode || '-';
}

/**
 * @typedef {{
 *   error: string | null;
 *   customer: CustomerFragment | null;
 * }} ActionResponse
 */

/** @typedef {import('customer-accountapi.generated').CustomerFragment} CustomerFragment */
/** @typedef {import('@shopify/hydrogen/customer-account-api-types').CustomerUpdateInput} CustomerUpdateInput */
/** @typedef {import('./+types/account.profile').Route} Route */
/** @typedef {ReturnType<typeof useLoaderData<typeof loader>>} LoaderReturnData */
/** @typedef {ReturnType<typeof useActionData<typeof action>>} ActionReturnData */
