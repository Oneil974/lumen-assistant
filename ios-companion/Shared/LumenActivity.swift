import ActivityKit
import Foundation

/// Activité en direct (écran verrouillé + Dynamic Island) : ce que font les
/// agents de Lumen et ce qui attend une décision. Partagé entre l'app (qui la
/// démarre et la met à jour) et l'extension de widgets (qui la dessine).
struct LumenActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// « Agent Recherche · web_search » ou « 2 décisions en attente ».
        var title: String
        /// Dernière étape, ou texte de la demande.
        var detail: String
        /// Décisions en attente (approbations, déverrouillage).
        var pending: Int
        /// Un agent travaille en ce moment.
        var working: Bool
    }

    /// Nom de l'ordinateur (hôte de Lumen).
    var host: String
}

/// Liens profonds de l'app (widgets, Raccourcis) : lumen://<action>.
enum LumenLink: String {
    case ask, capture, talk, agents
    var url: URL { URL(string: "lumen://\(rawValue)")! }
}
