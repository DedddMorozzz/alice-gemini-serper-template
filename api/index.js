const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4200;
const SERPER_TIMEOUT_MS = 2400;
const GEMINI_TIMEOUT_MS = 3800;
const RESPONSE_RESERVE_MS = 350;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, ясно и так, чтобы ответ было удобно слушать.",
  "Отвечай содержательно: раскрывай суть, объясняй причины, последствия и важные нюансы, приводи уместные примеры. Для вопросов, требующих объяснения, ориентируйся на 600–900 символов, но не растягивай простые ответы искусственно. Если пользователь просит подробно, можешь дать ответ до 1800 символов, его можно озвучить по частям. Не используй Markdown, таблицы или длинные вступления.",
  "Если переданы результаты интернет-поиска, опирайся на них; не выдумывай отсутствующие факты. Если результатов нет, не утверждай, что проверил интернет.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = [], pending = "", completedAnswer = false) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(completedAnswer && !pending ? String(text).trim() + " Что-то ещё желаешь?" : text),
      end_session: endSession
    },
    session_state: { history, pending }
  };
}

function splitSpokenAnswer(value) {
  const text = String(value || "").replace(/\\s+/g, " ").trim();
  if (text.length <= 950) return { spoken: text, pending: "" };
  const head = text.slice(0, 925);
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  const index = cut >= 350 ? cut + 1 : head.lastIndexOf(" ") >= 350 ? head.lastIndexOf(" ") : 925;
  return { spoken: text.slice(0, index).trim() + " Скажи «продолжай», чтобы услышать остальное.", pending: text.slice(index).trim() };
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
  return String(text || "").toLowerCase().split(/[^а-яёa-z]+/).includes("найди");
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

// Yandex persistent states are limited to 1 KB each (UTF-8 JSON).
function compactPersistentHistory(history) {
  const messages = safeHistory(history).slice(-4);
  const out = [];
  for (const item of messages) out.push({ role: item.role, text: item.text.slice(0, 180) });
  while (out.length && Buffer.byteLength(JSON.stringify({ history: out }), "utf8") > 950) {
    if (out.length > 2) out.shift();
    else {
      const longest = out.reduce((a, b) => a.text.length >= b.text.length ? a : b);
      longest.text = longest.text.slice(0, Math.max(0, longest.text.length - 20));
    }
  }
  return out;
}

function persistentResponse(answer, endSession, history, pending, completedAnswer, body) {
  const result = aliceResponse(answer, endSession, history, pending, completedAnswer);
  const saved = { history: compactPersistentHistory(history) };
  if (body?.session?.user?.user_id) result.user_state_update = saved;
  else if (body?.session?.application?.application_id) result.application_state = saved;
  return result;
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


function isNewsIntent(text) {
  return /новост|news/i.test(text);
}

function parseSearchDate(raw, now = new Date()) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return null;
  const iso = value.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    return d.getUTCFullYear() === +iso[1] && d.getUTCMonth() === +iso[2] - 1 && d.getUTCDate() === +iso[3] ? d : null;
  }
  const rel = value.match(/(\d+)\s*(minutes?|hours?|days?|weeks?|months?|минут[а-я]*|час[а-я]*|дн[яей]*|день|недел[а-я]*|месяц[а-я]*)\s*(ago|назад)?/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const days = /minute|минут/.test(unit) ? n / 1440 : /hour|час/.test(unit) ? n / 24 : /week|недел/.test(unit) ? n * 7 : /month|месяц/.test(unit) ? n * 30 : n;
    return new Date(now.getTime() - days * 86400000);
  }
  const months = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11,января:0,февраля:1,марта:2,апреля:3,мая:4,июня:5,июля:6,августа:7,сентября:8,октября:9,ноября:10,декабря:11 };
  const monthNames = Object.keys(months).join("|");
  const en = value.match(new RegExp("\\b(" + monthNames + ")\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b"));
  const ru = value.match(new RegExp("(\\d{1,2})\\s+(" + monthNames + ")\\s+(20\\d{2})"));
  const match = en || ru;
  if (!match) return null;
  const day = Number(en ? match[2] : match[1]);
  const month = months[en ? match[1] : match[2]];
  const year = Number(match[3]);
  const d = new Date(Date.UTC(year, month, day));
  return d.getUTCMonth() === month && d.getUTCDate() === day ? d : null;
}

function selectRecentNews(items) {
  const now = new Date();
  const seen = new Set();
  const candidates = items.map(item => ({
    ...item,
    parsedDate: parseSearchDate(item.date, now)
  })).filter(item => {
    if (!item.title || !item.link) return false;
    if (item.parsedDate) {
      const age = now.getTime() - item.parsedDate.getTime();
      if (age < -86400000 || age > 90 * 86400000) return false;
    }
    const key = item.title.toLowerCase().replace(/[^a-zа-яё0-9]/gi, "").slice(0, 90);
    const url = item.link.split("?")[0].replace(/\/$/, "");
    if (seen.has(key) || seen.has(url)) return false;
    seen.add(key);
    seen.add(url);
    return true;
  });
  const dated = candidates.filter(item => item.parsedDate)
    .sort((a, b) => b.parsedDate - a.parsedDate);
  const undated = candidates.filter(item => !item.parsedDate);
  return [...dated, ...undated].slice(0, 3);
}

function searchFallback(context) {
  const entries = String(context || "").split("\n").filter(line => /^\d+\. Заголовок: /.test(line));
  if (!entries.length) return "";
  const parts = entries.slice(0, 2).map(line => {
    const title = line.match(/Заголовок: (.*?); Дата:/)?.[1]?.trim() || "";
    const snippet = line.match(/; Описание: (.*?); Источник:/)?.[1]?.trim() || "";
    if (!title) return "";
    const detail = snippet && !snippet.toLowerCase().includes(title.toLowerCase()) ? ". " + snippet.slice(0, 180) : "";
    return title + detail;
  }).filter(Boolean);
  return parts.length ? "По результатам поиска: " + parts.join(". ") + ". Это краткие сведения из поисковой выдачи, без дополнительной проверки." : "";
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  const startedAt = Date.now();
  const newsIntent = false;
  const headers = { "X-API-KEY": key, "Content-Type": "application/json" };
  const request = (endpoint, body) => fetchJson(
    "https://google.serper.dev/" + endpoint,
    { method: "POST", headers, body: JSON.stringify(body) },
    Math.min(SERPER_TIMEOUT_MS, timeoutMs)
  ).then(({ response, data }) => {
    if (!response.ok) throw new Error("SERPER_HTTP_" + response.status);
    return data;
  });

  try {
    // A news-only search can legitimately return zero hits. Run a general
    // time-filtered search in parallel to avoid losing the webhook budget.
    const base = { q: query, gl: "ru", hl: "ru" };
    const searches = newsIntent
      ? await Promise.allSettled([
          request("news", { ...base, tbs: "qdr:w" }),
          request("search", { ...base, num: 10, tbs: "qdr:w" })
        ])
      : await Promise.allSettled([request("search", { ...base, num: 6 })]);

    const newsData = newsIntent && searches[0].status === "fulfilled" ? searches[0].value : {};
    const webData = newsIntent
      ? (searches[1].status === "fulfilled" ? searches[1].value : {})
      : (searches[0].status === "fulfilled" ? searches[0].value : {});
    const newsRaw = Array.isArray(newsData.news) ? newsData.news : [];
    const webRaw = Array.isArray(webData.organic) ? webData.organic : [];
    const rawResults = newsIntent ? [...newsRaw, ...webRaw] : webRaw;
    const organic = rawResults.map(item => ({
      title: String(item.title || "").slice(0, 180),
      snippet: String(item.snippet || "").slice(0, 350),
      link: String(item.link || "").slice(0, 240),
      date: String(item.date || "").slice(0, 80)
    }));
    const selected = newsIntent ? selectRecentNews(organic) : organic.slice(0, 6);
    const items = selected.map((item, i) =>
      `${i + 1}. Заголовок: ${item.title}; Дата: ${item.parsedDate ? item.parsedDate.toISOString().slice(0, 10) : "не установлена"}; Описание: ${item.snippet}; Источник: ${item.link}`
    );
    if (!newsIntent) {
      const answerBox = webData.answerBox?.answer || webData.answerBox?.snippet;
      if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    }
    console.log("SERPER_DIAGNOSTIC", {
      status: items.length ? "success" : "empty_results",
      durationMs: Date.now() - startedAt,
      newsCount: newsRaw.length,
      organicCount: webRaw.length,
      newsStatus: searches[0].status,
      webStatus: newsIntent ? searches[1].status : searches[0].status,
      newsError: searches[0].status === "rejected" ? String(searches[0].reason?.message || searches[0].reason?.name).slice(0, 90) : null,
      webError: newsIntent && searches[1].status === "rejected" ? String(searches[1].reason?.message || searches[1].reason?.name).slice(0, 90) : null,
      selectedNews: newsIntent ? selected.length : null,
      selectedTitles: newsIntent ? selected.map(item => item.title.slice(0, 100)) : null,
      selectedDates: newsIntent ? selected.map(item => item.date || "unknown") : null
    });
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("SERPER_DIAGNOSTIC", { status: "error", durationMs: Date.now() - startedAt, errorName: error?.name || "unknown" });
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

  const newsIntent = false;
  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\n${newsIntent ? "Это запрос на подборку новостей. Перескажи только отобранные публикации (до трёх), каждую отдельным коротким предложением. Назови источник по ссылке, если он очевиден. Если дата не установлена, не называй публикацию самой свежей и не выдумывай дату. Не объединяй публикации и не придумывай недостающие. Не добавляй факты из предыдущего диалога или своих знаний; если заголовок описывает ленту новостей, а не событие, пропусти его. Если подходящих публикаций меньше трёх, прямо скажи об этом. Общая длина до 950 символов." : "Используй результаты только там, где они относятся к вопросу."}`
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
  const oldHistory = safeHistory(body?.state?.session?.history?.length ? body.state.session.history : (body?.state?.user?.history || body?.state?.application?.history));
  const pending = String(body?.state?.session?.pending || "").slice(0, 8000);

  console.log("ENV_DIAGNOSTIC", {
    vercelEnv: process.env.VERCEL_ENV || "unknown",
    vercelGitCommitSha: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 12) || null,
    hasGeminiKey: Boolean(String(process.env.GEMINI_API_KEY || "").trim()),
    hasSerperKey: Boolean(String(process.env.SERPER_API_KEY || "").trim())
  });

  if (!text) {
    return res.status(200).json(persistentResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory, "", false, body
    ));
  }

  try {
    const normalized = text.toLowerCase().replace(/[.!?]+$/g, "").trim();
    if (["продолжай", "продолжи", "дальше", "продолжение"].includes(normalized) && pending) {
      const part = splitSpokenAnswer(pending);
      return res.status(200).json(persistentResponse(part.spoken, false, oldHistory, part.pending, true, body));
    }
    if (["начни новую тему", "забудь предыдущий разговор", "очисти контекст"].includes(normalized)) {
      return res.status(200).json(persistentResponse("Хорошо, начинаем новую тему. О чём поговорим?", false, [], "", false, body));
    }
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Give Serper time to respond while reserving enough time for Gemini.
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 1350)));
    }

    if (isSearchIntent(text) && !searchContext) {
      console.warn("SEARCH_UNAVAILABLE", { elapsedMs: Date.now() - startedAt });
      return res.status(200).json(persistentResponse("Не удалось получить актуальные данные из интернета. Попробуй повторить запрос позже.", false, oldHistory, "", false, body));
    }

    const geminiBudget = Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - RESPONSE_RESERVE_MS));
    console.log("REQUEST_STAGE", { stage: "gemini", elapsedMs: Date.now() - startedAt, remainingMs: remainingMs(), geminiBudget, searchContextChars: searchContext.length });
    let answer;
    try {
      answer = await askGemini(text, oldHistory, searchContext, geminiBudget);
    } catch (error) {
      const transient = error?.name === "AbortError" || ["TIME_BUDGET_EXHAUSTED", "GEMINI_REQUEST_FAILED", "GEMINI_EMPTY_RESPONSE"].includes(error?.message);
      const fallback = searchContext && transient ? searchFallback(searchContext) : "";
      if (!fallback) throw error;
      console.warn("SEARCH_FALLBACK", { reason: error?.name || error?.message || "unknown", contextChars: searchContext.length });
      answer = fallback;
    }

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    console.log("REQUEST_DIAGNOSTIC", { status: "success", totalMs: Date.now() - startedAt });
    const part = splitSpokenAnswer(answer);
    return res.status(200).json(persistentResponse(part.spoken, false, history, part.pending, true, body));
  } catch (error) {
    console.warn("REQUEST_DIAGNOSTIC", { status: "fallback", totalMs: Date.now() - startedAt, errorName: error?.name || "unknown", errorCode: error?.message || "unknown" });
    const safeError = error?.name === "AbortError" ? new Error("TIME_BUDGET_EXHAUSTED") : error;
    return res.status(200).json(persistentResponse(errorForUser(safeError), false, oldHistory, "", false, body));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory, splitSpokenAnswer, searchFallback };
