# Lumen Assistant

**English** · [Français](README.fr.md)

<p align="center">
  <img src="assets/Lumen_Header.png" alt="Lumen — local-first desktop AI assistant" width="700">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-beta-ff9e6b" alt="Status: beta">
  <a href="https://github.com/Oneil974/lumen-assistant/releases/latest"><img src="https://img.shields.io/github/v/release/Oneil974/lumen-assistant?label=version&color=9961ff" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20·%20Windows%20·%20Linux%20·%20Raspberry%20Pi-47a3ff" alt="Platforms">
  <img src="https://img.shields.io/badge/AI-can%20run%20100%25%20locally-61f2c7" alt="Local-first">
  <img src="https://img.shields.io/badge/your%20data-stays%20on%20your%20machine-ff54a3" alt="Private by default">
</p>

<p align="center"><img src="assets/divider.svg" alt="" width="700"></p>

**A local-first desktop AI assistant — a living, private, agentic chat bar that grows into a full desktop.**

Lumen ships its own inference engine: **nothing to install** before you can talk to a local model. It can also drive [Ollama](https://ollama.com), Apple's on-device models, or any OpenAI-compatible API when a cloud model is the better tool — each source remembering its own model. Version **0.2** turns Lumen Desktop into a system: a lighter core, apps as installable packages from a Catalogue, an assistant that works in projects, and a presence on your phone and on Raspberry Pi.

➡️ **[Download the latest release](https://github.com/Oneil974/lumen-assistant/releases/latest)** · 🌐 **[Website](https://Oneil974.github.io/lumen-assistant/)** · 📝 **[Changelog](https://Oneil974.github.io/lumen-assistant/changelog.html)**

> [!NOTE]
> **Lumen is in beta and under active development.** Features move fast from one release to the next, and bugs are still around. Feedback is welcome through the [issues](https://github.com/Oneil974/lumen-assistant/issues).

---

## ✨ A living bar

A floating chat capsule, always within reach, with an **animated orb** that breathes, listens and reacts.

- **Four engines** — built-in llama.cpp (nothing to install), local Ollama, Apple models, or an OpenAI-compatible API. Switch source in one click; each one comes back with its own model.
- **Orb or avatar** — the WebGL glass orb, or your own **animated GLB model** whose animations follow the assistant's states.
- **Chat modes** — plain chat, **Documents** (your indexed files), action router, tool calling, or one specific workflow.
- **Understand this screen** — Lumen captures the real screen, or just the region you select, and has the active vision model describe it.
- **Floating prompt & context menu** — select text in any application: proofread, rewrite, summarise or translate from the context menu, or open a floating prompt sheet on the spot.
- **Projects, folders, pins & PDF** — group conversations in a project with instructions and a local knowledge base; sort them into folders, pin the important ones on a Pinterest-style board, export any thread to PDF. Summarise, compact or branch a long thread from any message.
- **@ and # mentions** — mention a tool or a document in the chat bar to force its call, whatever the engine.
- **Voice & dictation** — **Piper ships inside the app** (Linux, Windows), plus Kokoro, system voices and whisper.cpp dictation. Fully offline if you want it.
- **Memory** — eight kinds of recollection, recalled before answering, under a compartmented access policy enforced in the backend.
- **Halo capsule & notifications** — a persistent capsule shows running agents and their steps, notifications, weather and scores; every kind of event has its own sound and its own signal on the orb.
- **Mobile companion (PWA) & Telegram** — install Lumen on your phone's home screen: multi-user with a TOTP code per profile, camera capture for the vision model, agent approvals and push notifications. Or reach the assistant from Telegram without opening a single port.

## 🖥️ Lumen Desktop — the immersive desktop

A complete working environment inside one window: multi-profile sessions, windows, widgets, Spotlight (⌘K), notification centre, light and dark themes — and, since 0.2, **a lighter core with apps as installable packages**.

<p align="center">
  <img src="assets/Lumen_Desktop_Pi.png" alt="Lumen Desktop — app launcher, Fluxo Designer (GPIO) and AI Assistant, here on a Raspberry Pi" width="700">
  <br>
  <sub><em>Lumen Desktop running on a Raspberry Pi: launcher, Fluxo Designer (GPIO blocks) and the AI Assistant, all local.</em></sub>
</p>

- **Catalogue** — one screen to install apps (`.lumenapp` packages from a signed repository), GGUF models, voices, Fluxo workflows and avatars. Each app declares its capabilities; you grant them one by one.
- **App Intents** — apps promote actions to the assistant (create a note, schedule a task, run Python): the model can call them even when the app is closed.
- **Icon dock & launcher** — a compact bar that gets out of the way, a full-screen launcher, and an app menu you arrange yourself.
- **AI sandbox** — isolated file spaces where agents read, write and run things without touching the rest of your machine.
- **Corpus (RAG)** — index your documents, question them in plain language, and see the passages each answer rests on, with their score.
- **Databases** — Baserow-style SQLite tables, plain-language queries (read-only), wired into the other apps.
- **Consultation mode** *(alpha)* — a calmer interface, built for touch, on a shared screen or a tablet.
- **Forge** — describe an app, Lumen generates it, you take over the code — without leaving the window.

## 🤖 Agents, Fluxo & Skills

- **Agent wizard** — a guided path to define a personal agent: role, tools, budgets and guardrails.
- **Orchestrator & sub-agents** — a lead agent splits a request and delegates to specialists, with token and iteration budgets, and escalates instead of looping.
- **Scheduled tasks** — one view on everything that runs at a set time: AI requests, workflows, agents and reminders, with a run log.
- **Automation mode** — a node-based flavour of Fluxo for scheduled and event-driven automations, with their run history.
- **Fluxo Designer** — a visual workflow editor: triggers, system actions, AI blocks, notifications.
- **MCP connectors** — Model Context Protocol servers plug in with one click (official remote servers, HTTPS with a header token).
- **Toolbox** — you choose which tools are exposed to the model, one by one: a tool you don't need costs context before you've even asked your question.
- **Opt-in web search** — off by default; nothing goes online until you turn it on. Page and document extraction is more reliable in 0.2.
- **Profiler** — what each call actually costs: context, tools, memory, throughput.

## 🎨 Forty-odd apps, each in its own window

Every app is a package you install, update or remove from the Catalogue, and opens in its own window — several at once if you like.

- **Create** — Notes, Mind map, Mood board, Creative canvas, Photos, Image studio
- **Organise** — Calendar (with AI prompts), Kanban board, Scheduled tasks, Budget
- **Explore** — Corpus (indexed documents), Research (sourced reports), Databases, Data analysis, ML workshop (scikit-learn), Browser
- **Sound & voice** — AI podcast, Voice lab, Music studio
- **Lab** — Code editor, Python, Home automation
- **Play** — Games, generated Adventure, Companion, Village
- **Built in** — Opus & Calc (documents, presentations, spreadsheet), Fluxo Designer, Automations, agents team, inbox, LLM traces, Profiler, Memory, Keys, Storage, Settings

**Image generation** — PrismML **Bonsai Image** runs locally (Apple Silicon, NVIDIA GPU) and downloads on demand; Apple Image Playground on macOS 27; Ollama and OpenAI-compatible APIs behind the same interface.

### Pro edition (in preparation)

A single binary: Pro features unlock with an offline licence key. **Relia** (AI-assisted CRM, Factur-X quotes and invoices), **Meetings** (LAN video and team chat with AI minutes), **DB Studio**, **Data flows** (visual ETL), **Reporting**, **Data sources**, **Directory** and end-to-end encrypted **Team messaging** — plus an optional **Lumen Server** with roles, permissions and a shared AI source.

## 🔌 Hardware

- **Lumen Controller** — a physical companion on your local network: buttons bound to workflows, agents or prompts, and a knob that drives system volume.
- **RFID support** — tap a badge to fire a workflow, wake an agent, or switch profile and unlock your session without a password.
- **ESP32 firmware** — generate, flash and drive MicroPython firmware (sensors, LED matrices, relays, servos) and a physical orb avatar on a round display.

## 🍓 Lumen Pi

A dedicated Raspberry Pi build: **GPIO** Fluxo blocks (pigpiod) to drive real hardware, local voices, floating bar and full-screen mode — a fully local voice and home-automation assistant on a Pi. **LiteRT with Gemma 4 E2B** brings lightweight local inference to a board without a GPU.

<p align="center"><img src="assets/divider.svg" alt="" width="700"></p>

## Download

➡️ **[Latest release — download page](https://github.com/Oneil974/lumen-assistant/releases/latest)**

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `.dmg` |
| Windows | `.exe` (installer) or `.msi` |
| Linux (Debian/Ubuntu, x86_64) | `.deb` or `.AppImage` |
| Raspberry Pi / arm64 | `.deb` or `.AppImage` |

## Requirements & installation

**Nothing to install**: download, open, pick a model. The AI stack ships inside the application:

- **Inference** — the llama.cpp engine is built in; the model you choose in the first-run assistant (or the Catalogue) is downloaded by Lumen itself. On a Raspberry Pi, LiteRT with Gemma 4 E2B does the same job on a board without a GPU.
- **Voices** — Piper ships inside the app on Linux, Windows and Raspberry Pi; macOS uses the system voices. Voices are downloaded from the Catalogue, and the first-run assistant lets you pick one.
- **Images** — Bonsai Image and its models are downloaded on demand from the Catalogue.
- **Dictation** — native on macOS and Windows.

Lumen updates itself: releases are signed and the app checks for a new version once a day (`.dmg` and `.deb` are first-download formats; automatic updates apply to the `.app`, `-setup.exe`/`.msi` and `.AppImage` installs).

**Optional extras** — only if you want them:

| What | Where | How |
|---|---|---|
| **Ollama** as an alternative engine | any platform | install it from [ollama.com](https://ollama.com); Lumen detects it and lists its models |
| **Kokoro** voices (higher quality, slower) | Linux, Raspberry Pi | `scripts/setup-linux.sh` or `scripts/setup-pi.sh` |
| **whisper.cpp** local dictation | Linux, Raspberry Pi | same scripts |

Details: **[scripts/README.md](scripts/README.md)**.

## Privacy

In local mode, **no data leaves your machine**: model, inference, memory, documents and databases all stay on your disk. Web search and cloud API mode are optional and off by default; the API key, when there is one, never leaves the backend.

<p align="center"><img src="assets/divider.svg" alt="" width="700"></p>

This repository hosts the landing page and the application binaries (via *Releases*). The source code is not published here.
