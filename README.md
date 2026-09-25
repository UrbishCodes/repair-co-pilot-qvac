# 🔧 Repair Co-Pilot

Photograph a dead circuit component — get a spoken diagnosis, a replacement pick, and hands-free repair steps. 100% on-device with the [QVAC SDK](https://qvac.tether.io); no cloud, no account, no datasheet hunting.

## How it works

1. **Photo** — snap the burnt or unknown component, close and straight-on.
2. **Confirm markings** — on-device OCR reads the printed part numbers; you verify them (it flags the classic `0`/`O`, `5`/`S` misreads) before anything else runs.
3. **Diagnosis** — the app searches your local datasheet library and produces an analysis card: identification, key specs with sources, likely failure cause, replacement part, numbered repair steps, and safety warnings.
4. **Chat + read aloud** — ask follow-ups ("what wattage?") grounded in the same context, and have anything read aloud while both hands stay on the board.

## Demo

> Demo video and screenshots go here.

## Install

Requires [Node.js](https://nodejs.org/) 20+.

```bash
git clone https://github.com/joshua80st/repair-co-pilot-qvac.git
cd repair-co-pilot-qvac
npm install
```

`npm install` pre-downloads the model weights once (~1.5 GB total). If the download is skipped, models fetch lazily on first use instead. You can also pre-download any time with:

```bash
npm run download-models
```

## Run

```bash
npm start
```

Then open **http://localhost:8091** — on a phone, open your computer's LAN address (same Wi-Fi) so you can photograph components directly.

### Datasheet library

The app ships with four sample datasheets (2N2222, 1N4148, 7805, resistor codes) that are indexed automatically on first diagnosis. Add your own via the **📚 Library** button: upload `.txt` datasheets or paste text. Everything stays on your device.

## The AI, on-device

| Model | Size | Job |
|---|---|---|
| EasyOCR (QVAC `ocr`) | ~100 MB | Reading printed markings |
| EmbeddingGemma 300M | ~300 MB | Datasheet search vectors |
| Qwen3 1.7B | ~1.1 GB | Diagnosis, chat, repair steps |
| SuperTonic TTS | ~150 MB | Hands-free read-aloud |

Built with **@qvac/sdk 0.19.x** (`loadModel`, `ocr`, `embed`, `ragIngest`, `ragSearch`, `completion`, `textToSpeech`, `unloadModel`).

## Safety

This is a repair aid, not a certified reference. Every spec shown traces to your confirmed markings or a retrieved datasheet excerpt — sources are listed on screen, and uncertain values are flagged for multimeter verification. Mains-voltage work always comes with explicit warnings; when in doubt, take it to a professional.

## License

MIT — see [LICENSE](LICENSE).
