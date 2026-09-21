import { BaseExecutor } from "./base.js";

// tokentable.asia web chat: POST /api/chat, OpenAI-shaped SSE back.
// Quirk: the web apiKey travels in the request BODY, no Authorization header;
// upstream 403s unless Origin/Referer/UA look like the site itself.
const CHAT_URL = "https://tokentable.asia/api/chat";

const WEB_HEADERS = {
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.5",
  Origin: "https://tokentable.asia",
  Referer: "https://tokentable.asia/en/chat",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  "sec-ch-ua": '"Not=A?Brand";v="99", "Brave";v="151", "Chromium";v="151"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

export class TokenTableExecutor extends BaseExecutor {
  constructor() {
    super("tokentable", { baseUrl: CHAT_URL });
  }

  buildUrl() {
    return CHAT_URL;
  }

  buildHeaders() {
    // apiKey lives in the body; sending Authorization breaks the web endpoint
    return { "Content-Type": "application/json", ...WEB_HEADERS };
  }

  transformRequest(model, body, stream, credentials) {
    const apiKey = credentials?.apiKey || credentials?.accessToken;
    if (!apiKey) throw new Error("TokenTable web apiKey missing (tt-web-...)");
    const { apiKey: _drop, ...rest } = body || {};
    return { ...rest, model, stream: true, apiKey };
  }
}

export default TokenTableExecutor;
