# Czat, RAG czy agent?

Interaktywna lekcja: to samo pytanie w trzech podejściach do AI, porównane wiersz po wierszu.
Strona: https://workszop.github.io/chat-rag/ · PL (domyślnie) / EN · symulacja, bez wywołań modelu.

An interactive lesson comparing Chat, RAG and Agent on the same question, row by row.

## Run
Open `index.html` directly (works from `file://`) or `python3 -m http.server 8791`.
Keys: → / Space next · ← back · A play · R start over · 1-3 example · L language.

## Verify
`node tests/verify.mjs` (Playwright + system Chrome; override with `PLAYWRIGHT_MODULE`, `CHROME_BIN`).
Optional filter: `node tests/verify.mjs stepper`.
