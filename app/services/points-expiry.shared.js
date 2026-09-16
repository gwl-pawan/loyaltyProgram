export function toDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value || 0);

  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

export function addExpiryPeriod(value, amount, unit) {
  const result = toDate(value);

  if (unit === "days") {
    result.setUTCDate(result.getUTCDate() + amount);
  } else {
    const originalDay = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + amount);
    const lastDayOfTargetMonth = new Date(
      Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
    ).getUTCDate();
    result.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
  }

  return result;
}

function getEventDate(transaction) {
  return toDate(transaction.createdAt);
}

export function calculateExpiredPointLots(transactions, now = new Date()) {
  const cutoff = toDate(now);
  const lots = new Map();
  const events = [];

  for (const transaction of transactions || []) {
    const points = Math.max(0, Number(transaction?.points || 0));

    if (points <= 0) continue;

    if (transaction.transactionType === "credit") {
      const lot = {
        id: transaction.id,
        points,
        remainingPoints: points,
        createdAt: getEventDate(transaction),
        expiresAt: transaction.expiresAt ? toDate(transaction.expiresAt) : null,
        expiredAt: transaction.expiredAt ? toDate(transaction.expiredAt) : null,
      };

      lots.set(lot.id, lot);
      events.push({ type: "credit", at: lot.createdAt, priority: 0, lot });

      if (lot.expiresAt && lot.expiresAt <= cutoff) {
        events.push({ type: "expire", at: lot.expiresAt, priority: 1, lot });
      }
    } else if (transaction.transactionType === "debit") {
      events.push({
        type: "debit",
        at: getEventDate(transaction),
        priority: 2,
        points,
      });
    }
  }

  events.sort((left, right) => {
    const timeDifference = left.at.getTime() - right.at.getTime();

    if (timeDifference !== 0) return timeDifference;
    return left.priority - right.priority;
  });

  const activeLots = [];
  const expiredLots = [];
  const emittedLotIds = new Set();

  for (const event of events) {
    if (event.at > cutoff) break;

    if (event.type === "credit") {
      activeLots.push(event.lot);
      continue;
    }

    if (event.type === "expire") {
      const pointsToExpire = event.lot.remainingPoints;

      if (!event.lot.expiredAt && pointsToExpire > 0) {
        expiredLots.push({
          sourceTransactionId: event.lot.id,
          points: pointsToExpire,
          earnedAt: event.lot.createdAt,
          expiresAt: event.lot.expiresAt,
        });
        emittedLotIds.add(event.lot.id);
      }

      event.lot.remainingPoints = 0;
      continue;
    }

    let remainingDebit = event.points;

    for (const lot of activeLots) {
      if (remainingDebit <= 0) break;
      if (lot.remainingPoints <= 0) continue;

      const consumed = Math.min(lot.remainingPoints, remainingDebit);
      lot.remainingPoints -= consumed;
      remainingDebit -= consumed;
    }
  }

  const exhaustedExpiredLots = [...lots.values()]
    .filter(
      (lot) =>
        lot.expiresAt &&
        lot.expiresAt <= cutoff &&
        !lot.expiredAt &&
        !emittedLotIds.has(lot.id) &&
        lot.remainingPoints <= 0,
    )
    .map((lot) => ({
      sourceTransactionId: lot.id,
      points: 0,
      earnedAt: lot.createdAt,
      expiresAt: lot.expiresAt,
    }));

  return [...expiredLots, ...exhaustedExpiredLots].sort(
    (left, right) => left.expiresAt - right.expiresAt,
  );
}
