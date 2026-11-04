# Cams – dashboard RTSP (Tauri + backend Rust)

## Requisiti
- ffmpeg.exe (vedi sotto)
- Rust + MSVC Build Tools (solo per Tauri): https://rustup.rs

## Avvio
```
npm install
npx tauri icon percorso/logo.png   # una volta sola: genera le icone
npm run dev                        # app Tauri (avvia da sola il server Node)
```
Prova solo UI nel browser: `npm run server` → http://127.0.0.1:17890

## Configurazione: cameras.json
```json
{ "cameras": [ { "name": "Ingresso", "streams": ["rtsp://…/main", "rtsp://…/sub"] } ] }
```
`streams` accetta stringhe oppure `{ "label": "HD", "url": "rtsp://…" }`. Anche `stream1`, `stream2`… sono accettati.
Il file è riletto automaticamente a ogni salvataggio. In produzione si trova in `%APPDATA%\local.cams.dashboard\`.

## Uso
- **⚙ Impostazioni**: aggiungi/rimuovi telecamere e flussi, importa o esporta il JSON, oppure modificalo direttamente nella scheda "JSON". Nulla cambia finché non premi Salva; ogni salvataggio crea `cameras.json.bak`. Dopo il salvataggio si riavviano solo le camere con URL modificati.
- Layout (3x3, 3x4, …) dalla barra in alto; con più telecamere dei riquadri compaiono le pagine.
- Trascina un riquadro su un altro per spostarlo. Doppio clic = schermo pieno sulla telecamera (Esc per uscire).
- Passando il mouse su un riquadro: scelta flusso, proporzioni (anche personalizzate, es. `16:10`) e adattamento (Adatta / Ritaglia / Stira).
- Layout, ordine e impostazioni per telecamera sono salvati in `state.json`.
- Il flusso predefinito è il 2 (qualità minore) se presente; la scelta per telecamera resta salvata. Il tasto "Aggiorna" rilegge `cameras.json` e riavvia i flussi.

## Versione portable
`npm run build:portable` → `src-tauri\target\release\cams.exe` (nessun installer, nessun Node).
Cartella da distribuire:
```
Cams\
├── cams.exe
├── ffmpeg.exe      ← accanto all'exe (oppure nel PATH, oppure variabile FFMPEG)
└── data\           ← creata al primo avvio: cameras.json, state.json
```
