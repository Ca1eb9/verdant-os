import type { FarmAlert } from "@farm/shared";

const RESEND_URL = "https://api.resend.com/emails";
/** The uplink can be down; a send never waits longer than this */
const SEND_TIMEOUT_MS = 10_000;

export interface EmailConfig {
  apiKey: string;
  from: string;
  to: string[];
}

/** Off when none of the variables are set; throws when only some are */
export function emailConfigFromEnv(env: NodeJS.ProcessEnv): EmailConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim() ?? "";
  const from = env.ALERT_EMAIL_FROM?.trim() ?? "";
  const to = (env.ALERT_EMAIL_TO ?? "").split(",").map((address) => address.trim()).filter(Boolean);
  if (!apiKey && !from && to.length === 0) return null;
  if (!apiKey || !from || to.length === 0) {
    throw new Error("email needs RESEND_API_KEY, ALERT_EMAIL_FROM and ALERT_EMAIL_TO together");
  }
  return { apiKey, from, to };
}

/**
 * Sends one alert by email through Resend. Never throws: a failed send is
 * logged and dropped, since nothing on the farm depends on the uplink.
 */
export async function sendAlertEmail(config: EmailConfig, alert: FarmAlert, fetchFn = fetch): Promise<boolean> {
  try {
    const response = await fetchFn(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        // Resend drops a repeat of the same key, so a retried alert mails once
        "Idempotency-Key": alert.alert_id,
      },
      body: JSON.stringify({
        from: config.from,
        to: config.to,
        subject: `[${alert.severity.toUpperCase()}] ${alert.message}`,
        text: [
          alert.message,
          "",
          `Source: ${alert.source} (${alert.source_type})`,
          `Raised: ${new Date(alert.timestamp).toISOString()}`,
        ].join("\n"),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[EMAIL] Resend refused alert ${alert.alert_id}: ${response.status} ${await response.text()}`);
      return false;
    }
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[EMAIL] Could not send alert ${alert.alert_id}: ${reason}`);
    return false;
  }
}
