import { GlmExecutor } from "./glm.js";
import ZCODE_PLAN_SHAPE from "./zcode-plan-shape.json" with { type: "json" };

// Statuses that mean "this endpoint leg rejects the credential/request shape"
// rather than "the provider is down". ZcodeExecutor advances to the next leg
// (zcode-plan → bigmodel → api.z.ai) on these, mirroring the Kiro
// gateway-first override. 400 stays terminal (malformed request), 429/5xx keep
// base behavior.
const ZCODE_ENDPOINT_FALLBACK_STATUSES = [401, 403, 404];

const EPHEMERAL = { type: "ephemeral" };

function zcodeBlocks(model) {
  const data = ZCODE_PLAN_SHAPE;
  const env = data.environment;
  const envLines = [
    env.heading,
    env.invokedLine,
    `- ${env.cwdLabel}: /root`,
    `- ${env.gitLabel}: ${env.gitNo}`,
    `- ${env.platformLabel}: linux`,
    `- ${env.shellLabel}: /bin/bash`,
    `- ${env.osVersionLabel}: linux`,
    `- ${env.poweredByLine.replace("{model}", model || "glm-5.3")}`,
  ].join("\n");
  const stable = data.stableSections.join("\n\n");
  const dynamic = [
    data.dynamicSections.beforeEnvironment,
    envLines,
    data.dynamicSections.afterEnvironment,
  ].join("\n\n");
  return [
    { type: "text", text: data.cliPrefix, cache_control: EPHEMERAL },
    { type: "text", text: stable, cache_control: EPHEMERAL },
    { type: "text", text: `\n\n${dynamic}`, cache_control: EPHEMERAL },
  ];
}

/**
 * Rewire the claude-format body into the start-plan wire shape:
 * 1. system: prepend the 3 official ZCode blocks (client blocks preserved
 *    after, cache_control stripped to stay under the 4-breakpoint cap)
 * 2. messages: leading user turn carrying the currentDate context prefix
 *    wrapped in <system-reminder>, then the user's real messages
 * 3. metadata.user_id: account-scoped id (device/session blob in the real
 *    client; any stable string passes)
 */
function injectZcodePlanShape(body, model, credentials) {
  const jwt = credentials?.providerSpecificData?.zcodeJwtToken
    || credentials?.accessToken
    || credentials?.apiKey
    || "zc";
  const userSystem = Array.isArray(body.system)
    ? body.system.map(b => ({ ...b, cache_control: undefined }))
    : (typeof body.system === "string" && body.system.trim()
      ? [{ type: "text", text: body.system }]
      : []);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const date = new Date().toISOString().slice(0, 10);
  const cp = ZCODE_PLAN_SHAPE.contextPrefix;
  const sr = ZCODE_PLAN_SHAPE.systemReminder;
  const currentDateSection = `${cp.currentDateHeading}\n${cp.currentDateLine.replace("{date}", date)}`;
  const prefixText = [cp.intro, currentDateSection, "", cp.outro].join("\n");
  return {
    ...body,
    system: [...zcodeBlocks(model), ...userSystem],
    metadata: { ...(body.metadata || {}), user_id: credentials?.providerSpecificData?.userId || `user_${jwt.slice(0, 8)}` },
    messages: [
      { role: "user", content: [{ type: "text", text: `${sr.open}\n${prefixText}\n${sr.close}` }] },
      ...messages,
    ],
  };
}

/**
 * ZCode executor — GLM effort tiers (inherited) + endpoint-leg fallback.
 *
 * The zcode-plan leg (zcode.z.ai/api/v1/zcode-plan/anthropic) is the Start
 * Plan runtime surface; the ZCode app additionally signs its requests with a
 * client-signing handshake (X-Client-Sig / X-Client-Pow). A router request
 * without that signature can be rejected with an auth-shaped status even when
 * the derived coding key is valid on the other legs — so 401/403/404 on any
 * leg but the last advances to the next endpoint instead of hard-stopping.
 */
export class ZcodeExecutor extends GlmExecutor {
  constructor(provider = "zcode") {
    super(provider);
    this._urlIndex = 0;
  }

  /**
   * Per-leg credential selection. The legs authenticate against different
   * account surfaces:
   *   - leg 0 (zcode-plan): the Start Plan session JWT (connection.apiKey —
   *     the exact credential the ZCode app stores as options.apiKey), sent
   *     unsigned exactly like the app does.
   *   - legs 1-2 (bigmodel / api.z.ai coding plans): the derived coding-plan
   *     key ("id.secret", providerSpecificData.codingApiKey). OAuth users
   *     without coding-plan entitlement have no valid credential here — the
   *     auth-error fallback moves on / surfaces the upstream billing error.
   *
   * Header shape mirrors ZCode's AI-SDK client (het + Fvo in the app bundle):
   * the credential goes out TWICE — x-api-key (SDK default) AND
   * Authorization: Bearer (Fvo wrapper prepends it for anthropic-kind
   * providers). The zcode-plan leg validates the Bearer header; a request
   * carrying only x-api-key is rejected 401.
   */
  buildHeaders(credentials, stream = true, model = null, opencodeIdentity = null, urlIndex = 0, body = null) {
    // Track the leg even when the retry loop calls buildUrl() first (it sets
    // this._urlIndex); urlIndex param wins when the caller passes it.
    const leg = typeof urlIndex === "number" && urlIndex > 0 ? urlIndex : this._urlIndex;
    const codingApiKey = credentials?.providerSpecificData?.codingApiKey;
    const effective = leg >= 1 && codingApiKey
      ? { ...credentials, apiKey: codingApiKey }
      : credentials;
    const headers = super.buildHeaders(effective, stream, model, opencodeIdentity);
    const token = headers["x-api-key"];
    if (leg === 0) {
      // Start-plan leg validates ONLY the OAuth session JWT — the derived
      // coding key gets 401 here. Prefer the JWT from providerSpecificData
      // (oauth flow stores it there), fall back to the connection token.
      const jwt = credentials?.providerSpecificData?.zcodeJwtToken
        || credentials?.accessToken
        || token;
      if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
      delete headers["x-api-key"];
      // Desktop-client runtime headers: the zcode-plan gateway fingerprints
      // them (verified via zcode-agent-kit 3.11.2 mirror — without them the
      // gateway answers 3012 "unusual activity").
      headers["X-Device-Mid"] = credentials?.providerSpecificData?.deviceMid
        || credentials?.providerSpecificData?.device_mid
        || headers["X-Device-Mid"]
        || "9r-" + (credentials?.id || "anon");
      headers["X-Platform"] = "linux";
      headers["X-ZCode-App-Version"] = "3.11.2";
      headers["User-Agent"] = "ZCode/3.11.2";
    } else if (token && !headers["Authorization"]) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  /**
   * Multi-leg URL resolution. DefaultExecutor.buildUrl (inherited through
   * GlmExecutor) resolves only config.baseUrl — it predates baseUrls chains,
   * which only BaseExecutor.buildUrl (Kiro) walks. Without this override the
   * retry loop would re-request leg 0 on every urlIndex.
   */
  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    this._urlIndex = urlIndex;
    const baseUrls = this.getBaseUrls();
    const leg = baseUrls[urlIndex] || baseUrls[0];
    if (leg) return leg;
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  /**
   * Start-plan body shape. The zcode-plan gateway content-inspects the request:
   * without the ZCode identity system blocks it answers 3012 "method not
   * allowed", without metadata.user_id / context-prefix it 3001s. Inject the
   * desktop client's exact shape on leg 0 only (verified against the desktop
   * bundle mirror in zcode-agent-kit 0.2.42). Other legs: untouched.
   */
  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    if (this._urlIndex !== 0 || !transformed || typeof transformed !== "object") return transformed;
    return injectZcodePlanShape(transformed, model, credentials);
  }

  async execute(args) {
    // Store credentials for content-aware fallback decisions + error context.
    this._lastCredentials = args?.credentials || {};
    this._startPlanCaptchaBlocked = false;
    return super.execute(args);
  }

  shouldRetry(status, urlIndex) {
    if (ZCODE_ENDPOINT_FALLBACK_STATUSES.includes(status)) {
      return urlIndex + 1 < this.getFallbackCount();
    }
    if (status === 400 && urlIndex === 0) {
      // Captcha wall on the start-plan leg: leg 0's 400s are the Aliyun
      // attestation (code 3007), never a client-body problem the coding legs
      // would share. Fall through ONLY when the connection carries a coding
      // key that can actually serve legs 1-2; Start-Plan-only connections get
      // the terminal, actionable parseError message instead.
      if (urlIndex + 1 < this.getFallbackCount() && this._lastCredentials?.providerSpecificData?.codingApiKey) {
        this._startPlanCaptchaBlocked = true;
        return true;
      }
      return false;
    }
    return super.shouldRetry(status, urlIndex);
  }

  /**
   * Captcha-aware error surfacing. The zcode-plan (Start Plan) leg is
   * protected by Aliyun captcha attestation: the ZCode desktop app renders
   * the captcha widget, and the engine attaches the resulting
   * X-Aliyun-Captcha-Verify-Param as a runtime header before each model
   * request (reason "model-request" / "captcha-retry" — verified in the app
   * bundle). A router cannot mint that token, so HTTP 400 code 3007
   * ("captcha verify failed") on this leg is terminal by design. Rewrite it
   * into an actionable message instead of leaking the raw upstream body.
   */
  parseError(response, bodyText) {
    const base = { status: response.status, message: bodyText || `HTTP ${response.status}` };
    const CAPTCHA_NOTE =
      " (Note: the ZCode Start Plan endpoint was skipped — it requires Aliyun captcha attestation only the ZCode desktop app provides, so Start Plan quota cannot be routed through a gateway. Route access needs a GLM Coding Plan key with an active plan.)";
    if (this._startPlanCaptchaBlocked) {
      return { ...base, message: `${base.message}${CAPTCHA_NOTE}` };
    }
    if (response.status !== 400) return base;
    try {
      const parsed = JSON.parse(bodyText);
      const msg = String(parsed?.msg || "");
      if (parsed?.code === 3007 || /captcha/i.test(msg)) {
        return {
          status: response.status,
          message:
            "ZCode Start Plan endpoint requires Aliyun captcha attestation that only the ZCode desktop app can provide (it solves the captcha and attaches X-Aliyun-Captcha-Verify-Param). " +
            "Start Plan quota cannot be routed through a gateway — use a GLM Coding Plan key (id.secret from api.z.ai or open.bigmodel.cn) for ExtremeRouter access.",
        };
      }
    } catch { /* non-JSON body — return as-is */ }
    return base;
  }
}

export default ZcodeExecutor;
