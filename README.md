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

## Consumo CPU
- Decodifica hardware attiva di default (`-hwaccel auto`; si disattiva con la variabile `CAMS_HWACCEL=none`). Se non disponibile ffmpeg ripiega sul software.
- I timestamp dei flussi sono quelli di arrivo (`-use_wallclock_as_timestamps 1`): alcune telecamere partono da un PTS enorme e il filtro `fps` duplicherebbe centinaia di migliaia di frame, saturando la CPU.
- FPS massimi 15 (i sub-stream delle telecamere trasmettono 5-15 fps); i processi ffmpeg girano a priorità bassa.
