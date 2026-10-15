// Native application windows share the same lifecycle and diagnostics.
// Keep legacy command names stable for installed apps and physical shortcuts.
use super::{open_app_window_after_ipc, AppWindowSpec};

macro_rules! app_windows {
    ($( $command:ident => ($label:literal, $url:literal, $title:literal,
        $width:literal, $height:literal, $min_width:literal, $min_height:literal, $maximized:literal); )*) => {
        $(
            #[tauri::command]
            pub(crate) fn $command(app: tauri::AppHandle) -> Result<(), String> {
                open_app_window_after_ipc(app, AppWindowSpec {
                    label: $label, url: $url, title: $title,
                    width: $width, height: $height,
                    min_width: $min_width, min_height: $min_height, maximized: $maximized,
                })
            }
        )*
    };
}

app_windows! {
    open_fluxo_designer => ("fluxo-designer", "fluxo/designer.html", "Fluxo — Designer", 1180.0, 760.0, 860.0, 560.0, false);
    open_automations => ("automations", "automations/automations.html", "Lumen — Automations", 1280.0, 820.0, 980.0, 620.0, false);
    open_llm_log => ("llm-log", "llmlog/llmlog.html", "Lumen — Journal LLM", 980.0, 660.0, 720.0, 480.0, false);
    open_agents_manager => ("agents-manager", "agents/manager.html", "Lumen — Agents", 1040.0, 720.0, 820.0, 520.0, false);
    open_messenger => ("messenger", "messenger/messenger.html", "Lumen — Messages", 980.0, 720.0, 380.0, 520.0, false);
    open_profiler => ("profiler", "profiler/profiler.html", "Lumen — Profiler", 1180.0, 800.0, 900.0, 600.0, false);
    open_docs => ("docs", "docs/docs.html", "Lumen — Documentation", 1080.0, 760.0, 860.0, 540.0, false);
    open_moodboard => ("moodboard", "moodboard/moodboard.html", "Lumen — Moodboard", 1200.0, 820.0, 900.0, 600.0, false);
    open_image_studio => ("image-studio", "studio/studio.html", "Lumen — Studio d'images", 1180.0, 800.0, 880.0, 560.0, false);
    open_kanban_board => ("kanban-board", "kanban/board.html", "Lumen — Kanban", 1180.0, 760.0, 860.0, 540.0, false);
    open_inbox => ("inbox", "inbox/inbox.html", "Lumen — Messagerie", 1040.0, 700.0, 820.0, 520.0, false);
    open_vault => ("vault", "vault/vault.html", "Lumen — Coffre personnel", 1320.0, 860.0, 880.0, 620.0, false);
    open_memory => ("memory", "memory/memory.html", "Lumen — Mémoire", 1100.0, 740.0, 860.0, 560.0, false);
    open_calendar => ("calendar", "calendar/calendar.html", "Lumen — Calendrier", 1080.0, 740.0, 820.0, 560.0, false);
    open_storage => ("storage", "storage/storage.html", "Lumen — Stockage", 980.0, 720.0, 760.0, 520.0, false);
    open_games => ("games", "games/games.html", "Lumen — Jeux", 1180.0, 780.0, 900.0, 620.0, false);
    open_knowledge => ("knowledge", "knowledge/knowledge.html", "Lumen — Connaissances", 1080.0, 740.0, 820.0, 560.0, false);
    open_domotique => ("domotique", "domotique/domotique.html", "Lumen — Domotique", 1180.0, 780.0, 900.0, 600.0, false);
    open_data_analysis => ("data-analysis", "data-analysis/analysis.html", "Lumen — Data Analysis", 1180.0, 760.0, 900.0, 560.0, false);
    open_budget => ("budget", "budget/budget.html", "Lumen — Budget", 1180.0, 780.0, 860.0, 600.0, false);
}
