const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3600;
const SERPER_TIMEOUT_MS = 1600;
const GEMINI_TIMEOUT_MS = 3000;
const RESPONSE_RESERVE_MS = 350;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Для запроса нескольких новостей допускается по одному-двум предложениям на каждую. Не используй Markdown, таблицы или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  const startedAt = Date.now();
  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 6 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("SERPER_DIAGNOSTIC", { status: "http_error", httpStatus: response.status, durationMs: Date.now() - startedAt });
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 6)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        const date = String(item.date || "").slice(0, 80);
        return `${i + 1}. Заголовок: ${title}; Дата: ${date || "не указана"}; Описание: ${snippet}; Источник: ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    console.log("SERPER_DIAGNOSTIC", { status: items.length ? "success" : "empty_results", durationMs: Date.now() - startedAt, resultsCount: items.length });
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("SERPER_DIAGNOSTIC", { status: error?.name === "AbortError" ? "timeout" : "network_error", durationMs: Date.now() - startedAt, errorName: error?.name || "unknown" });
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const newsIntent = /новост|news/i.test(text);
  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\n${newsIntent ? "Это запрос на подборку новостей. Представь до трёх РАЗНЫХ подтверждённых публикаций, каждую отдельным коротким предложением. Указывай дату и источник только если они присутствуют в результатах. Не объединяй три новости в одну и не придумывай недостающие. Если подходящих публикаций меньше трёх, прямо скажи об этом. Общая длина до 850 символов." : "Используй результаты только там, где они относятся к вопросу."}`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const startedAt = Date.now();
  console.log("GEMINI_REQUEST", { model, timeoutMs: Math.min(GEMINI_TIMEOUT_MS, timeoutMs), historyMessages: contents.length - 1, hasSearchContext: Boolean(searchContext) });
  let response, data;
  try {
    ({ response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 400
        }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  ));
  } catch (error) {
    console.warn("GEMINI_DIAGNOSTIC", { status: error?.name === "AbortError" ? "timeout" : "network_error", durationMs: Date.now() - startedAt, errorName: error?.name || "unknown", timeoutMs: Math.min(GEMINI_TIMEOUT_MS, timeoutMs) });
    throw error;
  }

  if (!response.ok) {
    const status = Number(response.status);
    console.error("GEMINI_DIAGNOSTIC", { status: "http_error", httpStatus: status, durationMs: Date.now() - startedAt, apiStatus: data?.error?.status || null, apiMessage: String(data?.error?.message || "").slice(0, 300) });
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  console.log("GEMINI_DIAGNOSTIC", { status: answer ? "success" : "empty_answer", durationMs: Date.now() - startedAt, answerChars: answer.length, finishReason: candidate?.finishReason || null });
  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  console.log("ENV_DIAGNOSTIC", {
    vercelEnv: process.env.VERCEL_ENV || "unknown",
    vercelGitCommitSha: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 12) || null,
    hasGeminiKey: Boolean(String(process.env.GEMINI_API_KEY || "").trim()),
    hasSerperKey: Boolean(String(process.env.SERPER_API_KEY || "").trim())
  });

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Give Serper time to respond while reserving enough time for Gemini.
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 1900)));
    }

    if (isSearchIntent(text) && !searchContext) {
      console.warn("SEARCH_UNAVAILABLE", { elapsedMs: Date.now() - startedAt });
      return res.status(200).json(aliceResponse("Не удалось получить актуальные данные из интернета. Попробуй повторить запрос позже.", false, oldHistory));
    }

    const geminiBudget = Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - RESPONSE_RESERVE_MS));
    console.log("REQUEST_STAGE", { stage: "gemini", elapsedMs: Date.now() - startedAt, remainingMs: remainingMs(), geminiBudget, searchContextChars: searchContext.length });
    const answer = await askGemini(text, oldHistory, searchContext, geminiBudget);

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    console.log("REQUEST_DIAGNOSTIC", { status: "success", totalMs: Date.now() - startedAt });
    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    console.warn("REQUEST_DIAGNOSTIC", { status: "fallback", totalMs: Date.now() - startedAt, errorName: error?.name || "unknown", errorCode: error?.message || "unknown" });
    const safeError = error?.name === "AbortError" ? new Error("TIME_BUDGET_EXHAUSTED") : error;
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory };
