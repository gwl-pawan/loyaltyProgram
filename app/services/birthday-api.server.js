export const BIRTHDAY_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
};

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: { ...BIRTHDAY_RESPONSE_HEADERS, ...init.headers },
  });
}

function requestError(message, status) {
  return Object.assign(new Error(message), { status });
}

export function normalizeShop(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return String(value || "").trim();
  }
}

export function createBirthdayApiHandlers({
  authenticateRequest,
  parseJsonRequest,
  logError,
  getProfile,
  saveBirthday,
  deleteBirthday,
}) {
  const loader = async ({ request }) => {
    try {
      const identity = await authenticateRequest(request);
      if (!identity.shopDomain) throw requestError("Shop is required", 400);
      if (!identity.customerId)
        throw requestError("Customer login is required", 401);

      const birthday = await getProfile(
        identity.shopDomain,
        identity.customerId,
      );
      return json({ success: true, birthday });
    } catch (error) {
      if (error instanceof Response) return error;
      logError("birthday:profile", error);
      return json(
        {
          success: false,
          message: error?.status ? error.message : "Could not load birthday",
        },
        { status: error?.status || 500 },
      );
    }
  };

  const action = async ({ request }) => {
    try {
      if (request.method !== "POST" && request.method !== "DELETE") {
        throw requestError("Method not allowed", 405);
      }
      const identity = await authenticateRequest(request);
      if (!identity.shopDomain) throw requestError("Shop is required", 400);
      if (!identity.customerId)
        throw requestError("Customer login is required", 401);

      const body = await parseJsonRequest(request, "birthday");
      const birthday =
        request.method === "DELETE" || body.action === "delete"
          ? await deleteBirthday(identity)
          : await saveBirthday({
              ...identity,
              birthday: body.birthday || body,
            });
      return json({ success: true, birthday });
    } catch (error) {
      if (error instanceof Response) return error;
      logError("birthday:action", error);
      return json(
        {
          success: false,
          message: error?.status ? error.message : "Could not save birthday",
        },
        { status: error?.status || 500 },
      );
    }
  };

  return { loader, action };
}
