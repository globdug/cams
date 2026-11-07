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

## Rilasci e aggiornamento automatico
Il `cams.exe` portable lo compila GitHub Actions (`.github/workflows/release.yml`), non serve compilare in locale:
- **Pubblicare una versione:** `npm run release -- 0.2.1` (da `main`, con tutto committato). Alza la versione in `package.json` e `Cargo.toml`, crea il tag `v0.2.1` e lo spinge; la build parte da sola e pubblica nelle *Releases* `cams.exe` e `cams.exe.sha256`. Il workflow rifiuta un tag diverso dalla versione in `Cargo.toml`.
- **Build di prova senza release:** scheda *Actions* → *Release* → *Run workflow*; l'exe resta come artefatto del job.
- **Nell'app:** dopo l'avvio e ogni 6 ore l'app legge l'ultima release; se è più recente compare in basso «Installa vX.Y.Z e riavvia». Cliccando sul numero di versione si forza il controllo. L'installazione scarica `cams.exe`, ne verifica lo SHA-256, rinomina l'exe in uso in `cams.exe.old` (Windows lo permette) e mette il nuovo al suo posto, poi chiude gli ffmpeg e riparte. `data\` e `ffmpeg.exe` non si toccano, e `ffmpeg.exe` non viene aggiornato. Se la cartella non è scrivibile (es. `Program Files`) l'aggiornamento fallisce senza danni.
- L'aggiornamento legge le release del repo senza autenticarsi, quindi il repo deve essere pubblico.

## Consumo CPU
- Decodifica hardware attiva di default (`-hwaccel auto`; si disattiva con la variabile `CAMS_HWACCEL=none`). Se non disponibile ffmpeg ripiega sul software.
- I timestamp dei flussi sono quelli di arrivo (`-use_wallclock_as_timestamps 1`): alcune telecamere partono da un PTS enorme e il filtro `fps` duplicherebbe centinaia di migliaia di frame, saturando la CPU.
- FPS massimi 15 (i sub-stream delle telecamere trasmettono 5-15 fps); i processi ffmpeg girano a priorità bassa.

## Gruppi, viste e statistiche
- **Vista** (barra in alto): tutte le telecamere, un gruppo, oppure una singola telecamera. Le telecamere fuori vista non avviano ffmpeg (meno CPU).
- **👥 Gruppi**: crea gruppi (es. Casa, Ufficio) con nome e telecamere spuntate. Sono salvati in `state.json`, quindi non si perdono se riscrivi `cameras.json`.
- **⟳ sul riquadro** (compare al passaggio del mouse): riavvia solo il flusso di quella telecamera.
- **ⓘ sul riquadro / 📊 Statistiche**: overlay tecnico con codec, profilo, risoluzione, fps e bitrate del flusso originale, fps/bitrate/risoluzione in uscita, frame duplicati/scartati, velocità di ffmpeg, tipo di decodifica (hardware/software), CPU del processo ffmpeg e tempo di attività. I dati sono anche su `GET /api/stats`.

### Selezione al volo
**☑ Scegli** (accanto al menu Vista) apre un pannello con una casella per telecamera: spuntando o togliendo, la vista diventa «Selezione» senza creare un gruppo. Il pannello parte dalla vista corrente; con «Salva come gruppo» la selezione diventa un gruppo riutilizzabile.

### Riavvio dei flussi al cambio di dimensione
Cambiando layout o selezione, un flusso viene riavviato solo se il riquadro ha davvero bisogno di più dettaglio e la sorgente lo ha (il backend espone la larghezza nativa in `/api/streams`). I sub-stream a 640 px non si riavviano mai per un riquadro più grande.

### Chiusura dei flussi
ffmpeg non viene mai ucciso di colpo: il backend gli manda `q` su stdin, così chiude la sessione RTSP con un TEARDOWN (ci mette da mezzo secondo a 2 s, perché legge stdin ogni `-stats_period`); solo dopo 4 s di margine (3 s alla chiusura dell'app) lo termina a forza. Senza TEARDOWN alcuni NVR (Reolink) tengono aperte le sessioni vecchie e, accumulandosi, mescolano i flussi: pacchetti RTP fuori sequenza («bad cseq»), immagini corrotte o di un altro canale. Nelle statistiche (ⓘ) la riga «Rete RTP» conta questi pacchetti. Chiudi l'app normalmente: con «Termina attività» o `taskkill /F` il TEARDOWN non parte.
