export type EmailOtpChallenge = {
  challengeId: string;
  expiresIn: number;
  retryAfter: number;
};

type EmailOtpClientErrorCode = "email_otp_request_failed" | "email_otp_not_eligible";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function requestEmailOtp(
  loginUrl: string,
  input: { email: string; redirect: string; returnTo?: string },
  fetchImpl: FetchLike = fetch
): Promise<EmailOtpChallenge> {
  const response = await fetchImpl(loginUrl, {
    body: JSON.stringify({
      email: input.email.trim().toLowerCase(),
      redirect: input.redirect,
      ...(input.returnTo ? { returnTo: input.returnTo } : {})
    }),
    headers: {
      Accept: "application/json",
      "content-type": "application/json"
    },
    method: "POST"
  });
  const payload = await readJsonRecord(response);

  if (response.status !== 202) {
    if (response.status === 403 && readString(payload.error) === "email_otp_not_eligible") {
      throw new EmailOtpClientError("email_otp_not_eligible");
    }
    throw new EmailOtpClientError();
  }

  const challengeId = readString(payload.challengeId);
  if (!challengeId) {
    throw new EmailOtpClientError();
  }

  return {
    challengeId,
    expiresIn: readPositiveSeconds(payload.expiresIn, 600),
    retryAfter: readPositiveSeconds(payload.retryAfter, 60)
  };
}

export async function verifyEmailOtp(
  verifyUrl: string,
  input: { challengeId: string; code: string; redirect: string },
  fetchImpl: FetchLike = fetch
): Promise<{ redirectUrl: string }> {
  const response = await fetchImpl(verifyUrl, {
    body: JSON.stringify(input),
    headers: {
      Accept: "application/json",
      "content-type": "application/json"
    },
    method: "POST"
  });
  const payload = await readJsonRecord(response);

  if (!response.ok) {
    throw new EmailOtpClientError();
  }

  const redirectUrl = readString(payload.redirectUrl);
  if (!redirectUrl) {
    throw new EmailOtpClientError();
  }

  return { redirectUrl };
}

export function emailOtpVerifyUrl(loginUrl: string) {
  return `${loginUrl.replace(/\/+$/, "")}/verify`;
}

export function normalizeEmailOtpCode(value: string) {
  return value.replace(/\D/g, "").slice(0, 6);
}

export function isValidEmailOtpCode(value: string) {
  return /^\d{6}$/.test(value);
}

export function isEmailOtpNotEligibleError(error: unknown) {
  return error instanceof EmailOtpClientError && error.code === "email_otp_not_eligible";
}

export function sameOriginEmailOtpRedirect(redirectUrl: string, origin: string) {
  const target = new URL(redirectUrl, origin);
  if (target.origin !== new URL(origin).origin) {
    throw new EmailOtpClientError();
  }
  return target.toString();
}

export function reloadAfterEmailOtpLogin(
  redirectUrl: string,
  navigation: {
    origin: string;
    replaceState: (target: string) => void;
    reload: () => void;
  }
) {
  const target = sameOriginEmailOtpRedirect(redirectUrl, navigation.origin);
  navigation.replaceState(target);
  navigation.reload();
}

class EmailOtpClientError extends Error {
  readonly code: EmailOtpClientErrorCode;

  constructor(code: EmailOtpClientErrorCode = "email_otp_request_failed") {
    super(code);
    this.name = "EmailOtpClientError";
    this.code = code;
  }
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new EmailOtpClientError();
  }

  try {
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new EmailOtpClientError();
    }
    return payload as Record<string, unknown>;
  } catch {
    throw new EmailOtpClientError();
  }
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveSeconds(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : fallback;
}
