

// Temporary Gemini diagnostic endpoint.
// Delete this file after testing.

import crypto from 'node:crypto';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'WWW-Authenticate',
    'Basic realm="Gemini diagnostic"'
  );

  const password = process.env.DIAG_PASSWORD;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!password || password.length < 16) {
    return res.status(503).json({
      error: 'DIAG_PASSWORD must contain at least 16 characters'
    });
  }

  // Check diagnostic password.
  const authorization = req.headers.authorization || '';
  let credentials = '';

  try {
    if (authorization.startsWith('Basic ')) {
      credentials = Buffer.from(
        authorization.slice(6),
        'base64'
      ).toString('utf8');
    }
  } catch {}

  const expected = `diagnostic:${password}`;

  const receivedHash = crypto
    .createHash('sha256')
    .update(credentials)
    .digest();

  const expectedHash = crypto
    .createHash('sha256')
    .update(expected)
    .digest();

  if (!crypto.timingSafeEqual(receivedHash, expectedHash)) {
    return res.status(401).json({
      error: 'Authentication required'
    });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is missing'
    });
  }

  const model =
    process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

  const started = Date.now();
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 15000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: 'Ответь одним словом: привет' }
              ]
            }
          ],
          generationConfig: {
            maxOutputTokens: 40
          }
        }),
        signal: controller.signal
      }
    );

    const data = await response.json().catch(() => ({}));

    const errorMessage = data?.error?.message;

    return res.status(200).json({
      model,
      google_http_status: response.status,
      elapsed_ms: Date.now() - started,
      success: response.ok,
      error_code: data?.error?.code ?? null,
      error_status: data?.error?.status ?? null,
      error_message:
        typeof errorMessage === 'string'
          ? errorMessage.slice(0, 800)
              .replace(/AIza[\w-]+/g, '[REDACTED]')
          : null,
      answer: response.ok
        ? String(
            data?.candidates?.[0]?.content?.parts
              ?.map(part => part.text || '')
              .join('') || ''
          ).slice(0, 300)
        : null
    });

  } catch (error) {
    return res.status(200).json({
      model,
      elapsed_ms: Date.now() - started,
      success: false,
      network_error: controller.signal.aborted
        ? 'TIMEOUT_15_SECONDS'
        : 'NETWORK_ERROR',
      error_type: error?.name || 'UnknownError'
    });

  } finally {
    clearTimeout(timer);
  }
}
