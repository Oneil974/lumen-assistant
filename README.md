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

Lumen now ships its own inference engine: **nothing to install** before you can talk to a local model. It can also drive [Ollama](https://ollama.com), Apple's on-device models, or any OpenAI-compatible API when a cloud model is the better tool — each source remembering its own model.

➡️ **[Download the latest release](https://github.com/Oneil974/lumen-assistant/releases/latest)** · 🌐 **[Website](https://Oneil974.github.io/lumen-assistant/)** · 📝 **[Changelog](https://Oneil974.github.io/lumen-assistant/changelog.html)**

> [!NOTE]
> **Lumen is in beta and under active development.** Features move fast from one release to the next, and bugs are still around. Feedback is welcome through the [issues](https://github.com/Oneil974/lumen-assistant/issues).

---

## ✨ A living bar

A floating chat capsule, always within reach, with an **animated orb** that breathes, listens and reacts.

- **Four engines** — built-in llama.cpp (nothing to install), local Ollama, Apple models, or an OpenAI-compatible API. Switch source in one click; each one comes back with its own model.
- **Orb or avatar** — the WebGL glass orb, or your own **animated GLB model** whose animations follow the assistant's states.
- **Chat modes** — plain chat, **Documents** (your indexed files), action router, tool calling, or one specific workflow.
- **Understand this screen** — Lumen captures the real screen and has the active vision model describe it. Draw a rectangle to ask about one area instead of the whole display.
- **Voice & dictation** — **Piper ships inside the app** (Linux, Windows), plus Kokoro, system voices and whisper.cpp dictation. Fully offline if you want it.
- **Memory** — eight kinds of recollection, recalled before answering, under a compartmented access policy enforced in the backend.
- **Audible and visible notifications** — every kind of event has its own sound and its own signal on the orb.
- **iPhone companion & Telegram** — your session mirrored on your phone, or the assistant reachable from Telegram without opening a single port.

## 🖥️ Lumen OS — the immersive desktop

A complete working environment inside one window: multi-profile sessions, windows, widgets, Spotlight (⌘K), notification centre, light and dark themes.

<p align="center">
  <img src="assets/Lumen_Desktop_Pi.png" alt="Lumen OS — app launcher, Fluxo Designer (GPIO) and AI Assistant, here on a Raspberry Pi" width="700">
  <br>
  <sub><em>Lumen OS running on a Raspberry Pi: launcher, Fluxo Designer (GPIO blocks) and the AI Assistant, all local.</em></sub>
</p>

- **New icon dock & launcher** — a compact bar that gets out of the way, a full-screen launcher, and an app menu you arrange yourself.
- **AI sandbox** — isolated file spaces where agents read, write and run things without touching the rest of your machine.
- **Corpus (RAG)** — index your documents, question them in plain language, and see the passages each answer rests on, with their score.
- **Databases** — Baserow-style SQLite tables, plain-language queries (read-only), wired into the other apps.
- **Consultation mode** *(alpha)* — a calmer interface, built for touch, on a shared screen or a tablet.
- **Forge** — describe an app, Lumen generates it, you take over the code — without leaving the window.

## 🤖 Agents, Fluxo & Skills

- **Orchestrator & sub-agents** — a lead agent splits a request and delegates to specialists, with token and iteration budgets, and escalates instead of looping.
- **Automation mode** — a node-based flavour of Fluxo for scheduled and event-driven automations, with their run history.
- **Fluxo Designer** — a visual workflow editor: triggers, system actions, AI blocks, notifications.
- **MCP connectors** — Model Context Protocol servers plug in with one click (official remote servers, HTTPS with a header token).
- **Toolbox** — you choose which tools are exposed to the model, one by one: a tool you don't need costs context before you've even asked your question.
- **Opt-in web search** — off by default; nothing goes online until you turn it on.
- **Profiler** — what each call actually costs: context, tools, memory, throughput.

## 🎨 Thirty-odd apps, grouped into hubs

**Corpus** (indexed documents, sourced research) · **Prisme** (tables, analysis, ML models) · **Muse** (notes, mind maps, mood boards, generative canvas) · **Opus & Calc** (documents, presentations, spreadsheet) · **Tempo** (tasks, kanban, calendar) · **Écho** (AI podcast, voice studio) · **Forge** (app studio, code editor) · **Arcade** (games, generated adventure, companion) · plus Browser, Finance, Image Studio, Music Studio, Home Automation and Memory.

## 🔌 Hardware

- **Lumen Controller** — a physical companion on your local network: buttons bound to workflows, agents or prompts, and a knob that drives system volume.
- **RFID support** — tap a badge to fire a workflow, wake an agent, or switch profile and unlock your session without a password.
- **ESP32 firmware** — generate, flash and drive MicroPython firmware (sensors, LED matrices, relays, servos) and a physical orb avatar on a round display.

## 🍓 Lumen Pi

A dedicated Raspberry Pi build: **GPIO** Fluxo blocks (pigpiod) to drive real hardware, local voices, floating bar and full-screen mode — a fully local voice and home-automation assistant on a Pi.

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

**Nothing is required to get started**: the llama.cpp engine is built in, and Lumen downloads the model you pick the first time you open it.

The all-in-one scripts are still there for anyone who prefers **Ollama** as the engine, and (on Linux/Pi) for **Kokoro** voices and **whisper.cpp** dictation:

| System | Command (from `scripts/`) |
|---|---|
| macOS | `./setup-macos.sh` |
| Linux (Debian/Ubuntu) | `./setup-linux.sh` |
| Raspberry Pi OS | `./setup-pi.sh` |
| Windows | `powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1` |

Details, options and installing the voices separately: **[scripts/README.md](scripts/README.md)**.

## Privacy

In local mode, **no data leaves your machine**: model, inference, memory, documents and databases all stay on your disk. Web search and cloud API mode are optional and off by default; the API key, when there is one, never leaves the backend.

<p align="center"><img src="assets/divider.svg" alt="" width="700"></p>

This repository hosts the landing page and the application binaries (via *Releases*). The source code is not published here.
