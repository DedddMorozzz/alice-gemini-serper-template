
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_PENDING_CHARS = 6000;
const MAX_ALICE_TEXT = 1024;

const TOTAL_RESPONSE_BUDGET_MS = 3600;
const SERPER_TIMEOUT_MS = 1800;
const GEMINI_TIMEOUT_MS = 3000;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, так, чтобы ответ было удобно слушать.",
  "На простые вопросы отвечай кратко, в 1–3 предложениях.",
  "На сложные вопросы отвечай содержательно, но компактно, в 4–6 предложениях.",
  "Не обрывай ответ посреди мысли.",
  "Не используй Markdown, таблицы и длинные вступления.",
  "Не задавай встречный вопрос вместо ответа, если можешь ответить по существу.",
  "Если переданы результаты интернет-поиска, используй их как источник актуальных сведений.",
  "При пересказе новостей называй конкретные события, даты и источники.",
  "Не подменяй свежие новости общими сведениями.",
  "Если найдено меньше трёх подходящих новостей, расскажи только о подтверждённых.",
  "Не выдумывай даты, события и источники.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function normalizeText(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function fitAliceText(value) {
  const text = normalizeText(value);

  if (!text) {
    return "Не удалось подготовить ответ.";
  }

  if (text.length <= MAX_ALICE_TEXT) {
    return text;
  }

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);

  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );

  if (sentenceEnd >= 300) {
    return candidate.slice(0, sentenceEnd + 1).trim();
  }

  const lastSpace = candidate.lastIndexOf(" ");

  return (
    (lastSpace > 200
      ? candidate.slice(0, lastSpace)
      : candidate
    ).trim() + "…"
  );
}

function splitForAlice(value) {
  const text = normalizeText(value);

  if (text.length <= MAX_ALICE_TEXT) {
    return [
      text || "Не удалось подготовить ответ.",
      ""
    ];
  }

  const part = text.slice(0, MAX_ALICE_TEXT - 60);

  const boundary = Math.max(
    part.lastIndexOf(". "),
    part.lastIndexOf("! "),
    part.lastIndexOf("? ")
  );

  const cut = boundary > 250
    ? boundary + 1
    : Math.max(part.lastIndexOf(" "), 250);

  const first = text.slice(0, cut).trim();

  const rest = text
    .slice(cut)
    .trim()
    .slice(0, MAX_PENDING_CHARS);

  return [
    first + " Скажи «продолжай», чтобы услышать дальше.",
    rest
  ];
}

function aliceResponse(
  text,
  endSession = false,
  history = [],
  pending = ""
) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: {
      history,
      pending
    }
  };
}

function isContinue(text) {
  return /^(продолжай|продолжи|дальше|следующая часть|следующую часть|рассказывай дальше)[.!? ]*$/i
    .test(text.trim());
}

function isSearchIntent(text) {
  return /новост|последн|свеж|сегодня|сейчас|актуальн|погод|курс валют|найди|поищи|в интернете|сколько стоит|latest|today|current|news|weather|search|recent/i
    .test(text);
}

function isNewsIntent(text) {
  return /новост|последн|свеж|событи|news|latest/i
    .test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter(item =>
      item &&
      (item.role === "user" || item.role === "model") &&
      typeof item.text === "string"
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({
      role: item.role,
      text: item.text.slice(
        0,
        MAX_HISTORY_MESSAGE_CHARS
      )
    }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    Math.max(100, timeoutMs)
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const raw = await response.text();

    let data = {};

    try {
      data = JSON.parse(raw);
    } catch {
      console.warn("API returned non-JSON response");
    }

    return {
      response,
      data
    };

  } finally {
    clearTimeout(timer);
  }
}

function buildSearchQuery(query, newsIntent) {
  let cleaned = String(query)
    .replace(/найди в интернете/gi, "")
    .replace(/поищи в интернете/gi, "")
    .replace(/расскажи о каждой/gi, "")
    .replace(/расскажи о каждом/gi, "")
    .replace(/три последние новости/gi, "latest news")
    .replace(/последние новости/gi, "latest news")
    .replace(/космическом телескопе Джеймса Уэбба/gi, "James Webb Space Telescope")
    .replace(/телескопе Джеймса Уэбба/gi, "James Webb Space Telescope")
    .trim();

  if (!cleaned) {
    cleaned = query;
  }

  if (newsIntent) {
    const year = new Date().getUTCFullYear();

    cleaned += ` ${year}`;
  }

  return cleaned;
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;

  if (!key) {
    console.warn("SERPER_DIAGNOSTIC", {
      status: "missing_api_key"
    });

    return "";
  }

  if (timeoutMs < 150) {
    console.warn("SERPER_DIAGNOSTIC", {
      status: "insufficient_time",
      timeoutMs
    });

    return "";
  }

  const newsIntent = isNewsIntent(query);

  const searchQuery = buildSearchQuery(
    query,
    newsIntent
  );

  const endpoint = newsIntent
    ? "https://google.serper.dev/news"
    : "https://google.serper.dev/search";

  const started = Date.now();

  console.log("SERPER_REQUEST", {
    type: newsIntent ? "news" : "search",
    timeoutMs,
    query: searchQuery
  });

  try {
    const { response, data } = await fetchJson(
      endpoint,
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          q: searchQuery,
          gl: "us",
          hl: "en",
          num: 8
        })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    const durationMs = Date.now() - started;

    if (!response.ok) {
      console.warn("SERPER_DIAGNOSTIC", {
        status: "http_error",
        httpStatus: response.status,
        durationMs
      });

      return "";
    }

    const results = newsIntent
      ? data.news
      : data.organic;

    if (!Array.isArray(results) || !results.length) {
      console.warn("SERPER_DIAGNOSTIC", {
        status: "empty_results",
        durationMs,
        responseKeys: Object.keys(data || {})
      });

      return "";
    }

    const formatted = results
      .slice(0, 6)
      .map((item, index) => {
        return [
          `Результат ${index + 1}`,
          `Заголовок: ${item.title || ""}`,
          `Дата: ${item.date || "не указана"}`,
          `Источник: ${item.source || ""}`,
          `Описание: ${item.snippet || ""}`,
          `Ссылка: ${item.link || ""}`
        ].join("\n");
      })
      .join("\n\n")
      .slice(0, 6500);

    console.log("SERPER_DIAGNOSTIC", {
      status: "success",
      durationMs,
      resultsCount: results.length,
      resultChars: formatted.length
    });

    return formatted;

  } catch (error) {
    const durationMs = Date.now() - started;

    const timedOut =
      error?.name === "AbortError" ||
      /aborted/i.test(error?.message || "");

    console.warn("SERPER_DIAGNOSTIC", {
      status: timedOut ? "timeout" : "network_error",
      durationMs,
      errorName: error?.name || "unknown"
    });

    return "";
  }
}

async function askGemini(
  text,
  history,
  searchContext,
  timeoutMs
) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error("MISSING_GEMINI_KEY");
  }

  if (timeoutMs < 250) {
    throw new Error("TIME_BUDGET_EXHAUSTED");
  }

  const model = String(
    process.env.GEMINI_MODEL || DEFAULT_MODEL
  ).trim();

  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new Error("INVALID_MODEL_NAME");
  }

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{
      text: item.text
    }]
  }));

  const prompt = searchContext
    ? [
        text,
        "",
        "Результаты поиска в интернете:",
        searchContext,
        "",
        "Используй только релевантные результаты.",
        "Для новостей указывай события и даты.",
        "Не выдавай старые материалы за свежие."
      ].join("\n")
    : text;

  contents.push({
    role: "user",
    parts: [{
      text: prompt
    }]
  });

  const started = Date.now();

  console.log("GEMINI_DIAGNOSTIC", {
    status: "started",
    timeoutMs,
    hasSearchContext: Boolean(searchContext),
    searchChars: searchContext.length,
    model
  });

  try {
    const { response, data } = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: SYSTEM_PROMPT
            }]
          },
          contents,
          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 400,
            thinkingConfig: {
              thinkingLevel: "MINIMAL"
            }
          }
        })
      },
      Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
    );

    const durationMs = Date.now() - started;

    if (!response.ok) {
      console.warn("GEMINI_DIAGNOSTIC", {
        status: "http_error",
        httpStatus: response.status,
        durationMs,
        apiErrorStatus: data?.error?.status || null
      });

      if (
        response.status === 401 ||
        response.status === 403
      ) {
        throw new Error("GEMINI_KEY_REJECTED");
      }

      if (response.status === 429) {
        throw new Error("GEMINI_QUOTA");
      }

      throw new Error("GEMINI_REQUEST_FAILED");
    }

    const candidate = data?.candidates?.[0];

    const answer = (
      candidate?.content?.parts || []
    )
      .map(part =>
        typeof part.text === "string"
          ? part.text
          : ""
      )
      .join("")
      .trim();

    console.log("GEMINI_DIAGNOSTIC", {
      status: answer ? "success" : "empty_answer",
      durationMs,
      answerChars: answer.length,
      finishReason: candidate?.finishReason || null
    });

    if (!answer) {
      if (data?.promptFeedback?.blockReason) {
        throw new Error("GEMINI_BLOCKED");
      }

      throw new Error("GEMINI_EMPTY_RESPONSE");
    }

    return answer;

  } catch (error) {
    const timedOut =
      error?.name === "AbortError" ||
      /aborted/i.test(error?.message || "");

    console.warn("GEMINI_DIAGNOSTIC", {
      status: timedOut ? "timeout" : "error",
      durationMs: Date.now() - started,
      errorName: error?.name || "unknown",
      errorCode: error?.message || "unknown"
    });

    throw error;
  }
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте ключ Gemini.";

    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ.";

    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте позже.";

    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";

    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";

    default:
      return "Не получилось получить ответ от нейросети. Попробуйте немного позже.";
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

    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const startedAt = Date.now();

  const remainingMs = () =>
    TOTAL_RESPONSE_BUDGET_MS -
    (Date.now() - startedAt);

  const body =
    req.body &&
    typeof req.body === "object"
      ? req.body
      : {};

  const text = String(
    body?.request?.command ||
    body?.request?.original_utterance ||
    ""
  ).trim();

  const oldHistory = safeHistory(
    body?.state?.session?.history
  );

  const pending = String(
    body?.state?.session?.pending || ""
  ).slice(0, MAX_PENDING_CHARS);

  if (!text) {
    return res.status(200).json(
      aliceResponse(
        "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
        false,
        oldHistory
      )
    );
  }

  if (isContinue(text)) {
    if (!pending) {
      return res.status(200).json(
        aliceResponse(
          "Продолжения пока нет. Задай новый вопрос.",
          false,
          oldHistory
        )
      );
    }

    const [part, rest] = splitForAlice(pending);

    return res.status(200).json(
      aliceResponse(
        part,
        false,
        oldHistory,
        rest
      )
    );
  }

  try {
    let searchContext = "";

    const needsSearch = isSearchIntent(text);

    if (needsSearch) {
      const searchStarted = Date.now();

      const searchBudget = Math.min(
        SERPER_TIMEOUT_MS,
        Math.max(
          0,
          remainingMs() - 1500
        )
      );

      searchContext = await searchWeb(
        text,
        searchBudget
      );

      console.log("SEARCH_STAGE", {
        durationMs: Date.now() - searchStarted,
        hasResults: Boolean(searchContext),
        resultChars: searchContext.length,
        remainingMs: remainingMs()
      });

      if (!searchContext) {
        console.warn("REQUEST_DIAGNOSTIC", {
          status: "search_unavailable",
          totalMs: Date.now() - startedAt
        });

        return res.status(200).json(
          aliceResponse(
            "Не удалось получить актуальные данные из интернета. Попробуй повторить запрос немного позже.",
            false,
            oldHistory
          )
        );
      }
    }

    const geminiBudget = Math.max(
      0,
      Math.min(
        GEMINI_TIMEOUT_MS,
        remainingMs() - 300
      )
    );

    console.log("GEMINI_STAGE", {
      remainingMs: remainingMs(),
      geminiBudget,
      searchResultsAvailable: Boolean(searchContext)
    });

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      geminiBudget
    );

    const history = [
      ...oldHistory,
      {
        role: "user",
        text: text.slice(
          0,
          MAX_HISTORY_MESSAGE_CHARS
        )
      },
      {
        role: "model",
        text: answer.slice(
          0,
          MAX_HISTORY_MESSAGE_CHARS
        )
      }
    ].slice(-MAX_HISTORY_MESSAGES);

    const [part, rest] = splitForAlice(answer);

    console.log("REQUEST_DIAGNOSTIC", {
      status: "success",
      totalMs: Date.now() - startedAt,
      responseChars: part.length,
      hasContinuation: Boolean(rest)
    });

    return res.status(200).json(
      aliceResponse(
        part,
        false,
        history,
        rest
      )
    );

  } catch (error) {
    const timedOut =
      error?.name === "AbortError" ||
      /aborted/i.test(error?.message || "");

    const safeError = timedOut
      ? new Error("TIME_BUDGET_EXHAUSTED")
      : error;

    console.warn("REQUEST_DIAGNOSTIC", {
      status: "fallback",
      totalMs: Date.now() - startedAt,
      errorCode: safeError?.message || "unknown"
    });

    return res.status(200).json(
      aliceResponse(
        errorForUser(safeError),
        false,
        oldHistory
      )
    );
  }
}

export {
  aliceResponse,
  fitAliceText,
  isSearchIntent,
  safeHistory
};
