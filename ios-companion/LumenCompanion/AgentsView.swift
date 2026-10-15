import SwiftUI

// Agents : créer, régler et piloter les agents autonomes de Lumen depuis
// l'iPhone, comme l'atelier du bureau. Le téléphone ne renvoie que les champs
// qu'il édite ; le serveur les fusionne sur la fiche existante (rien de ce que
// l'iPhone ignore — apparence du Village, mémoire, MCP — n'est effacé).

struct AgentInfo: Identifiable, Hashable {
    var id: String
    var name: String
    var icon: String
    var description: String
    var instruction: String
    var backend: String
    var model: String
    var sandbox: String
    var tools: [String]
    var cron: String
    var enabled: Bool
    var orchestrator: Bool
    var learning: Bool
    var tasks: [Task]
    /// Personnage Kenney (même rendu que sur l'ordinateur).
    var avatar: AgentAvatar

    struct Task: Hashable, Identifiable { let id: String; let text: String; let done: Bool }

    init(_ j: JSON) {
        id = j.str("id"); name = j.str("name"); icon = j.str("icon"); description = j.str("description")
        avatar = AgentAvatar(j["avatar"] as? [String: Any], seed: j.str("id").isEmpty ? j.str("name") : j.str("id"))
        instruction = j.str("instruction"); backend = j.str("backend"); model = j.str("model")
        sandbox = j.str("sandbox_id"); tools = (j["native_tools"] as? [String]) ?? []
        cron = j.str("cron"); enabled = j.bool("enabled"); orchestrator = j.bool("orchestrator"); learning = j.bool("learning_enabled")
        tasks = j.arr("tasks").map { Task(id: $0.str("id"), text: $0.str("text"), done: $0.bool("done")) }
    }

    static func blank() -> AgentInfo {
        var a = AgentInfo(["enabled": true])
        a.avatar = .random()
        return a
    }

    /// Champs édités par le téléphone (fusionnés côté serveur).
    var patch: [String: Any] {
        ["id": id, "name": name, "avatar": avatar.json, "description": description, "instruction": instruction,
         "backend": backend, "model": model, "sandbox_id": sandbox, "native_tools": tools, "cron": cron,
         "enabled": enabled, "orchestrator": orchestrator, "learning_enabled": learning]
    }

    var openTasks: Int { tasks.filter { !$0.done }.count }
}

struct ToolInfo: Identifiable, Hashable {
    let id: String, group: String, label: String, effect: String, risk: String
}

/// Tout ce que l'atelier du bureau expose au téléphone.
@MainActor
@Observable
final class AgentsModel {
    var agents: [AgentInfo] = []
    var running: Set<String> = []
    var sandboxes: [(id: String, name: String)] = []
    var tools: [ToolInfo] = []
    var loaded = false
    var failed = false

    func load(_ client: LumenClient) async {
        do {
            guard let j = try await client.api("agents/full") else { return }
            agents = j.arr("agents").map(AgentInfo.init).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            running = Set((j["running"] as? [String]) ?? [])
            sandboxes = j.arr("sandboxes").map { ($0.str("id"), $0.str("name")) }
            tools = j.arr("tools").map { ToolInfo(id: $0.str("id"), group: $0.str("group"), label: $0.str("label"), effect: $0.str("effect"), risk: $0.str("risk")) }
            failed = false
        } catch { failed = !loaded }
        loaded = true
    }
}

/// Feuille « Agents » : gestion + activité (approbations, runs).
struct AgentsView: View {
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var dismiss
    let client: LumenClient
    let toast: (String) -> Void
    @State private var tab = "agents"
    @State private var model = AgentsModel()
    @State private var path: [AgentRoute] = []

    enum AgentRoute: Hashable { case edit(AgentInfo), new }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    header
                    Segmented(items: [("agents", String(localized: "Agents")), ("activity", String(localized: "Activité"))], selection: $tab)
                    if tab == "agents" { list } else { AgentsActivity(client: client, toast: toast) }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 30)
            }
            .background(p.popover.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: AgentRoute.self) { r in
                switch r {
                case .edit(let a): AgentEditor(client: client, model: model, agent: a, toast: toast)
                case .new: AgentEditor(client: client, model: model, agent: .blank(), toast: toast)
                }
            }
        }
        .foregroundStyle(p.foreground)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(22)
        .presentationBackground(p.popover)
        .task {
            // L'état « au travail » bouge pendant qu'on regarde.
            while !Task.isCancelled {
                await model.load(client)
                try? await Task.sleep(for: .seconds(6))
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            IconBadge(symbol: "person.2", size: 40)
            VStack(alignment: .leading, spacing: 1) {
                Text("Agents").font(.system(size: 26, weight: .bold)).tracking(-0.5)
                Text(summary).font(.system(size: 12)).foregroundStyle(p.mutedForeground)
            }
            Spacer()
            Button { path.append(.new) } label: {
                Image(systemName: "plus").font(.system(size: 14, weight: .bold)).foregroundStyle(p.primaryForeground)
                    .frame(width: 32, height: 32).background(p.primary, in: Circle())
            }
            .accessibilityLabel("Nouvel agent")
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(p.mutedForeground)
                    .frame(width: 32, height: 32).background(p.muted, in: Circle())
            }
        }
        .padding(.top, 20)
    }

    private var summary: String {
        let active = model.agents.filter(\.enabled).count
        return String(localized: "\(model.agents.count) agent(s) · \(active) actif(s) · \(model.running.count) au travail")
    }

    @ViewBuilder private var list: some View {
        if !model.loaded {
            ProgressView().frame(maxWidth: .infinity).padding(30)
        } else if model.failed {
            EmptyRow(text: "Agents indisponibles.")
        } else if model.agents.isEmpty {
            VStack(spacing: 10) {
                IconBadge(symbol: "sparkles", size: 52)
                Text("Aucun agent pour l'instant").font(.system(size: 15, weight: .semibold))
                Text("Un agent travaille seul dans sa sandbox : veille, rapports, rangement…").font(.system(size: 13)).foregroundStyle(p.mutedForeground).multilineTextAlignment(.center)
                PrimaryButton(title: "Créer un agent") { path.append(.new) }.padding(.top, 4)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 30)
        } else {
            VStack(spacing: 8) {
                ForEach(model.agents) { a in
                    NavigationLink(value: AgentRoute.edit(a)) { AgentRow(agent: a, running: model.running.contains(a.id)) }
                        .buttonStyle(PressStyle())
                }
            }
            .padding(.top, 4)
        }
    }
}

private struct AgentRow: View {
    @Environment(\.palette) private var p
    let agent: AgentInfo
    let running: Bool

    var body: some View {
        HStack(spacing: 12) {
            AgentAvatarView(avatar: agent.avatar, size: 42, state: running ? .work : .idle)
                .frame(width: 48, height: 48)
                .background(agent.avatar.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).stroke(p.primary.opacity(running ? 0.6 : 0.2)))
            VStack(alignment: .leading, spacing: 3) {
                Text(agent.name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                if !agent.description.isEmpty {
                    Text(agent.description).font(.system(size: 12.5)).foregroundStyle(p.mutedForeground).lineLimit(1)
                }
                HStack(spacing: 5) {
                    if running { Chip(text: L("au travail"), symbol: "bolt.fill", tint: p.primary) }
                    else if agent.enabled { Chip(text: L("actif"), symbol: "checkmark", tint: p.success) }
                    else { Chip(text: L("en pause"), symbol: "pause.fill") }
                    if agent.openTasks > 0 { Chip(text: String(localized: "\(agent.openTasks) tâche(s)"), symbol: "checklist") }
                    if !agent.cron.isEmpty { Chip(text: L("planifié"), symbol: "clock") }
                    if agent.orchestrator { Chip(text: L("orchestre"), symbol: "point.3.connected.trianglepath.dotted") }
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(p.mutedForeground)
        }
        .lumenCard(active: running, radius: 16, padding: 12)
    }
}

/// Fiche d'un agent : identité, instructions, modèle, sandbox, outils,
/// planification, options ; lancer, confier une tâche, supprimer.
struct AgentEditor: View {
    @Environment(\.palette) private var p
    @Environment(\.dismiss) private var back
    let client: LumenClient
    let model: AgentsModel
    @State var agent: AgentInfo
    let toast: (String) -> Void
    @State private var saving = false
    @State private var taskText = ""
    @State private var confirmDelete = false
    @State private var dirty = false

    private var isNew: Bool { agent.id.isEmpty }
    private var running: Bool { model.running.contains(agent.id) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                topBar
                identity
                if !isNew { actions }
                section("Instructions", "text.quote") {
                    TextEditor(text: bind(\.instruction))
                        .font(.system(size: 14))
                        .frame(minHeight: 140)
                        .scrollContentBackground(.hidden)
                        .padding(8)
                        .background(p.background, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(alignment: .topLeading) {
                            if agent.instruction.isEmpty {
                                Text("Rôle, objectifs, règles… ex. « Chaque matin, résume les nouveautés de ma sandbox Veille dans un rapport. »")
                                    .font(.system(size: 13)).foregroundStyle(p.mutedForeground).padding(14).allowsHitTesting(false)
                            }
                        }
                }
                section("Modèle", "cpu") {
                    Segmented(items: [("", String(localized: "Auto")), ("ollama", "Ollama"), ("llama", "llama.cpp"), ("api", "API")], selection: bind(\.backend))
                    field("Modèle (vide = celui de Lumen)", text: bind(\.model))
                }
                section("Sandbox", "folder") {
                    Menu {
                        Button("Aucune") { agent.sandbox = ""; dirty = true }
                        ForEach(model.sandboxes, id: \.id) { sb in Button(sb.name) { agent.sandbox = sb.id; dirty = true } }
                    } label: {
                        HStack {
                            Image(systemName: "folder").foregroundStyle(p.primary)
                            Text(model.sandboxes.first { $0.id == agent.sandbox }?.name ?? L("Aucune")).foregroundStyle(p.foreground)
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                        }
                        .padding(12)
                        .background(p.background, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
                toolsSection
                section("Planification", "clock") {
                    Menu {
                        Button("Aucune (à la demande)") { agent.cron = ""; dirty = true }
                        Button("Toutes les heures") { agent.cron = "0 0 * * * *"; dirty = true }
                        Button("Chaque matin à 8 h") { agent.cron = "0 0 8 * * *"; dirty = true }
                        Button("Chaque soir à 19 h") { agent.cron = "0 0 19 * * *"; dirty = true }
                        Button("Du lundi au vendredi à 9 h") { agent.cron = "0 0 9 * * Mon-Fri"; dirty = true }
                    } label: {
                        HStack {
                            Image(systemName: "calendar.badge.clock").foregroundStyle(p.primary)
                            Text(cronLabel).foregroundStyle(p.foreground)
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundStyle(p.mutedForeground)
                        }
                        .padding(12)
                        .background(p.background, in: RoundedRectangle(cornerRadius: 12))
                    }
                    field("CRON (6 champs)", text: bind(\.cron), mono: true)
                }
                section("Options", "slider.horizontal.3") {
                    toggle("Actif", "power", bind(\.enabled))
                    toggle("Orchestrateur (délègue aux autres agents)", "point.3.connected.trianglepath.dotted", bind(\.orchestrator))
                    toggle("Apprend de ses tâches", "brain", bind(\.learning))
                }
                if !isNew && !agent.tasks.isEmpty {
                    section("Tâches", "checklist") {
                        ForEach(agent.tasks.suffix(12).reversed()) { t in
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: t.done ? "checkmark.circle.fill" : "circle").foregroundStyle(t.done ? p.success : p.mutedForeground)
                                Text(t.text).font(.system(size: 13)).foregroundStyle(t.done ? p.mutedForeground : p.foreground)
                            }
                        }
                    }
                }
                PrimaryButton(title: isNew ? "Créer l'agent" : (saving ? "Enregistrement…" : "Enregistrer"), disabled: agent.name.trimmingCharacters(in: .whitespaces).isEmpty || saving) { save() }
                    .padding(.top, 4)
                if !isNew {
                    Button(role: .destructive) { confirmDelete = true } label: {
                        Label("Supprimer l'agent", systemImage: "trash").font(.system(size: 14, weight: .medium))
                            .frame(maxWidth: .infinity).padding(.vertical, 10).foregroundStyle(p.destructive)
                    }
                    .buttonStyle(PressStyle())
                }
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 40)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(p.popover.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .confirmationDialog(String(localized: "Supprimer « \(agent.name) » ?"), isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Supprimer", role: .destructive) { delete() }
        } message: { Text("Sa sandbox et ses fichiers sont conservés.") }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            Button { back() } label: {
                Image(systemName: "chevron.left").font(.system(size: 14, weight: .semibold))
                    .frame(width: 34, height: 34).background(p.muted, in: Circle())
            }
            .buttonStyle(PressStyle())
            Text(isNew ? L("Nouvel agent") : agent.name).font(.system(size: 18, weight: .semibold)).lineLimit(1)
            Spacer()
            if running { Chip(text: L("au travail"), symbol: "bolt.fill", tint: p.primary) }
        }
        .padding(.top, 18)
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(spacing: 8) {
                field("Nom de l'agent", text: bind(\.name))
                field("Description courte", text: bind(\.description))
            }
            AvatarPicker(avatar: $agent.avatar) { dirty = true }
        }
        .lumenCard(radius: 18)
    }

    /// Lancer maintenant, ou confier une tâche précise.
    private var actions: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                IconBadge(symbol: "paperplane", size: 28)
                Text("Confier une tâche").font(.system(size: 14, weight: .semibold))
                Spacer()
                Button { run() } label: {
                    Label("Lancer", systemImage: "play.fill").font(.system(size: 13, weight: .semibold))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .foregroundStyle(p.primaryForeground).background(p.primary, in: Capsule())
                }
                .buttonStyle(PressStyle())
            }
            HStack(spacing: 8) {
                TextField("Ex. « Fais le point sur mes courriels de la semaine »", text: $taskText, axis: .vertical)
                    .font(.system(size: 14)).lineLimit(1...4)
                    .padding(10)
                    .background(p.background, in: RoundedRectangle(cornerRadius: 12))
                Button { give() } label: {
                    Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold)).foregroundStyle(p.primaryForeground)
                        .frame(width: 36, height: 36).background(p.primary, in: Circle())
                }
                .disabled(taskText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .opacity(taskText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
            }
        }
        .lumenCard(active: running, radius: 18)
    }

    private var toolsSection: some View {
        section("Outils", "wrench.and.screwdriver") {
            let groups = Dictionary(grouping: model.tools, by: \.group).sorted { $0.key < $1.key }
            if groups.isEmpty { Text("Catalogue indisponible.").font(.system(size: 13)).foregroundStyle(p.mutedForeground) }
            ForEach(groups, id: \.key) { group, items in
                Text(groupLabel(group).uppercased()).font(.system(size: 10.5, weight: .semibold)).tracking(0.5).foregroundStyle(p.mutedForeground).padding(.top, 4)
                ForEach(items) { t in
                    let on = agent.tools.contains(t.id)
                    Button {
                        if on { agent.tools.removeAll { $0 == t.id } } else { agent.tools.append(t.id) }
                        dirty = true
                        UISelectionFeedbackGenerator().selectionChanged()
                    } label: {
                        HStack(spacing: 10) {
                            IconBadge(symbol: LumenIcons.tool(t.id), tint: on ? nil : p.mutedForeground, size: 26)
                            Text(t.label).font(.system(size: 13.5)).foregroundStyle(p.foreground).lineLimit(1)
                            Spacer()
                            if t.effect != "read" {
                                Text(L(t.effect == "write" ? "écrit" : t.effect == "external" ? "externe" : "sensible"))
                                    .font(.system(size: 10.5, weight: .medium)).foregroundStyle(t.risk == "high" ? p.destructive : p.mutedForeground)
                            }
                            Image(systemName: on ? "checkmark.circle.fill" : "circle").foregroundStyle(on ? p.primary : p.mutedForeground)
                        }
                        .padding(.vertical, 3)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func groupLabel(_ g: String) -> String {
        switch g {
        case "vault": L("Coffre")
        case "home": L("Maison")
        case "web": L("Web")
        case "live": L("Données en direct")
        case "docs", "documents": L("Documents")
        case "memory": L("Mémoire")
        case "mail": L("Courrier")
        default: g.capitalized
        }
    }

    private var cronLabel: String {
        switch agent.cron {
        case "": L("À la demande")
        case "0 0 * * * *": L("Toutes les heures")
        case "0 0 8 * * *": L("Chaque matin à 8 h")
        case "0 0 19 * * *": L("Chaque soir à 19 h")
        case "0 0 9 * * Mon-Fri": L("Du lundi au vendredi à 9 h")
        default: L("Personnalisée")
        }
    }

    // MARK: Briques

    private func bind<T>(_ kp: WritableKeyPath<AgentInfo, T>) -> Binding<T> {
        Binding(get: { agent[keyPath: kp] }, set: { agent[keyPath: kp] = $0; dirty = true })
    }

    private func section<C: View>(_ title: String, _ symbol: String, @ViewBuilder _ c: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                IconBadge(symbol: symbol, size: 26)
                Text(L(title)).font(.system(size: 14, weight: .semibold))
            }
            c()
        }
        .lumenCard(radius: 18)
    }

    private func field(_ placeholder: String, text: Binding<String>, mono: Bool = false) -> some View {
        TextField(L(placeholder), text: text)
            .font(.system(size: 14, design: mono ? .monospaced : .default))
            .textInputAutocapitalization(mono ? .never : .sentences)
            .autocorrectionDisabled(mono)
            .padding(11)
            .background(p.background, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(p.border))
    }

    private func toggle(_ title: String, _ symbol: String, _ value: Binding<Bool>) -> some View {
        Toggle(isOn: value) {
            Label(L(title), systemImage: symbol).font(.system(size: 13.5))
        }
        .tint(p.primary)
    }

    // MARK: Actions

    private func save() {
        saving = true
        Task {
            do {
                let out = try await client.api("agents/save", body: ["agent": agent.patch])
                if let a = out?["agent"] as? JSON { agent = AgentInfo(a) }
                dirty = false
                toast(isNew ? "Agent créé" : "Agent enregistré")
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                await model.load(client)
                back()
            } catch {
                toast(L("Enregistrement impossible : ") + error.localizedDescription)
            }
            saving = false
        }
    }

    private func run() {
        Task {
            if dirty { _ = try? await client.api("agents/save", body: ["agent": agent.patch]); dirty = false }
            _ = try? await client.api("agents/run", body: ["id": agent.id])
            toast("Agent lancé")
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            await model.load(client)
        }
    }

    private func give() {
        let text = taskText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        taskText = ""
        Task {
            do {
                _ = try await client.api("agents/task", body: ["id": agent.id, "text": text])
                toast("Tâche confiée")
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                await model.load(client)
                if let fresh = model.agents.first(where: { $0.id == agent.id }) { agent.tasks = fresh.tasks }
            } catch { toast("Tâche refusée") }
        }
    }

    private func delete() {
        Task {
            _ = try? await client.api("agents/delete", body: ["id": agent.id])
            toast("Agent supprimé")
            await model.load(client)
            back()
        }
    }
}
