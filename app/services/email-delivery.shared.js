export async function coordinateLoyaltyEmailDelivery(
  input,
  { queue, dispatch },
) {
  const queueResult = await queue(input);
  const notification = queueResult.notification;

  if (!notification) {
    return queueResult;
  }

  if (notification.status !== "pending") {
    return {
      ...queueResult,
      delivery: {
        status: "skipped",
        reason: `already_${notification.status}`,
        notificationId: notification.id,
      },
    };
  }

  return {
    ...queueResult,
    delivery: await dispatch(notification),
  };
}
