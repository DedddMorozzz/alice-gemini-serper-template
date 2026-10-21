# Stable Alice skill configuration backup

This directory is a **non-secret configuration backup** for the tested Alice + Gemini + Serper webhook. It contains no credentials or personal conversations.

## Runtime
- Node.js 22; ESM; Vercel serverless entrypoint: `api/index.js`
- Alice webhook: `/api` (POST)
- Default Gemini model: `gemini-3.5-flash-lite`
- Search: Serper Google Search; enabled **only** when the separate word «найди» occurs
- Serper localization: `gl=ru`, `hl=ru`
- Alice reply maximum: 1024 characters
- Split long answers into parts; «продолжай» requests next part
- After the final part, say «Что-то ещё желаешь?»
- Preserve conversation state within a session; compact Yandex user/application state across launches (up to 1 KB)
- «начни новую тему» clears context
- Timing limits in code: 4200 ms overall, 2400 ms Serper, 3800 ms Gemini, 350 ms reserve

## Required Vercel environment variables
See `.env.example`. **Do not commit real keys**.

## Restore procedure
1. Find the stable Git branch `stable/alice-voice-v1` (snapshot of the tested code and this backup). The active development branch is `fix/gemini-timeouts`. The `main` branch is not changed.
2. In Vercel, inspect the project `alice-gemini-serper-template`, its linked GitHub repository, the Production/Preview branch settings, and configured environment variable **names**. Do not expose their values.
3. Restore the code from the stable branch into a new development branch or deploy that commit explicitly; avoid overwriting `main` without approval.
4. Confirm `GEMINI_API_KEY` and `SERPER_API_KEY` exist in the target Vercel environment; check `GEMINI_MODEL` if overridden.
5. Confirm the Yandex Dialogs webhook points to the correct deployed `/api` URL.
6. Run the GitHub Actions syntax/behavior tests and live conversation/continuation checks, then test the real speaker.

## Limitations
This backup does **not** export Vercel secrets, Yandex Dialogs console settings, or private account configuration. Restore these manually from the respective services. A single transient Gemini timeout in a ten-request live check was observed; the user chose not to investigate isolated network failures.
