// lumen-applefm — passerelle OpenAI-compatible vers Apple Foundation Models.
//
// Lumen parle à tous ses backends locaux (llama-server, LiteRT-LM) par l'API
// OpenAI. Le framework FoundationModels de macOS 27 n'a pas de serveur HTTP :
// ce petit exécutable en pose un, sur la boucle locale uniquement, pour que le
// reste de Lumen (barre, agents, Telegram, blocs Fluxo) n'ait rien à apprendre.
//
// Deux « modèles » sont exposés, selon `LanguageModel` :
//   - apple-on-device      : SystemLanguageModel.default (Apple Intelligence local)
//   - apple-private-cloud  : PrivateCloudComputeLanguageModel (macOS 27, quota Apple)
//
// Contrat servi : GET /health, GET /v1/models, POST /v1/chat/completions
// (stream ou non, outils OpenAI, response_format json_schema/json_object, images
// en data: URL). Chaque requête reconstruit sa session depuis les messages : le
// serveur est sans état, comme llama-server.
//
// Appels d'outils : FoundationModels exécute lui-même les Tools. Pour rendre la
// main au client (qui possède les vrais outils), chaque outil déclaré est un
// mandataire qui lève une erreur porteuse de l'appel ; on la rattrape et on la
// renvoie en `tool_calls`. Le tour suivant rejoue l'appel et sa sortie dans le
// transcript, et la génération reprend là où elle s'était arrêtée.
//
// Compilation : scripts/build-applefm.sh (swiftc, cible macOS 27).

import Foundation
import FoundationModels
import Network
import ImageIO
import CoreGraphics
import Security

// MARK: - Réglages

let listenHost = "127.0.0.1"
let listenPort: UInt16 = {
    if let raw = ProcessInfo.processInfo.environment["LUMEN_APPLEFM_PORT"], let p = UInt16(raw) { return p }
    var i = 1
    let args = CommandLine.arguments
    while i < args.count {
        if args[i] == "--port", i + 1 < args.count, let p = UInt16(args[i + 1]) { return p }
        i += 1
    }
    return 11437
}()

let modelOnDevice = "apple-on-device"
let modelPrivateCloud = "apple-private-cloud"

func log(_ message: String) {
    FileHandle.standardError.write(("[lumen-applefm] " + message + "\n").data(using: .utf8)!)
}

// MARK: - Modèles

/// Description d'un modèle pour `/v1/models` et `/health`.
struct ModelInfo {
    let id: String
    let available: Bool
    let reason: String?
    let capabilities: [String]
    /// Fenêtre de contexte annoncée par le framework (jetons), 0 si inconnue.
    /// Sur l'appareil elle dépend du Mac (8 192 sur macOS 27) : Lumen la lit
    /// ici plutôt que de la supposer.
    let contextSize: Int
}

/// Fenêtre de Private Cloud Compute : la propriété est `async throws` ;
/// on l'attend brièvement, sinon la valeur documentée (32 000).
func cloudContextSize(_ cloud: PrivateCloudComputeLanguageModel) -> Int {
    let group = DispatchGroup()
    var size = 32_000
    group.enter()
    Task {
        if let value = try? await cloud.contextSize { size = value }
        group.leave()
    }
    _ = group.wait(timeout: .now() + 1.5)
    return size
}

func unavailableReason(_ availability: SystemLanguageModel.Availability) -> String? {
    switch availability {
    case .available: return nil
    case .unavailable(let reason):
        switch reason {
        case .deviceNotEligible: return "device_not_eligible"
        case .appleIntelligenceNotEnabled: return "apple_intelligence_not_enabled"
        case .modelNotReady: return "model_not_ready"
        @unknown default: return "unavailable"
        }
    }
}

func unavailableReason(_ availability: PrivateCloudComputeLanguageModel.Availability) -> String? {
    switch availability {
    case .available: return nil
    case .unavailable(let reason):
        switch reason {
        case .deviceNotEligible: return "device_not_eligible"
        case .systemNotReady: return "system_not_ready"
        @unknown default: return "unavailable"
        }
    }
}

func capabilityNames(_ caps: LanguageModelCapabilities) -> [String] {
    var names: [String] = []
    if caps.contains(.vision) { names.append("vision") }
    if caps.contains(.toolCalling) { names.append("tools") }
    if caps.contains(.guidedGeneration) { names.append("json_schema") }
    if caps.contains(.reasoning) { names.append("reasoning") }
    return names
}

/// Private Cloud Compute est réservé aux exécutables porteurs de l'entitlement
/// `com.apple.developer.private-cloud-compute`, accordé par Apple sur demande
/// (https://developer.apple.com/contact/request/private-cloud-compute/). Sans
/// lui, `isAvailable` répond pourtant vrai et la première requête échoue avec
/// un ModelManagerError 1046 opaque : on vérifie donc l'entitlement nous-mêmes
/// pour ne proposer le modèle que s'il peut réellement servir.
let privateCloudEntitlement = "com.apple.developer.private-cloud-compute"
func hasPrivateCloudEntitlement() -> Bool {
    guard let task = SecTaskCreateFromSelf(nil) else { return false }
    guard let value = SecTaskCopyValueForEntitlement(task, privateCloudEntitlement as CFString, nil) else { return false }
    return (value as? Bool) == true
}

func listModels() -> [ModelInfo] {
    let local = SystemLanguageModel.default
    let cloud = PrivateCloudComputeLanguageModel()
    let cloudEntitled = hasPrivateCloudEntitlement()
    let cloudAvailable = cloud.isAvailable && cloudEntitled
    return [
        ModelInfo(id: modelOnDevice, available: local.isAvailable, reason: unavailableReason(local.availability),
                  capabilities: local.isAvailable ? capabilityNames(local.capabilities) : [],
                  contextSize: local.isAvailable ? local.contextSize : 0),
        ModelInfo(id: modelPrivateCloud, available: cloudAvailable,
                  reason: cloudEntitled ? unavailableReason(cloud.availability) : "entitlement_missing",
                  capabilities: cloudAvailable ? capabilityNames(cloud.capabilities) : [],
                  contextSize: cloudAvailable ? cloudContextSize(cloud) : 0),
    ]
}

// MARK: - Erreurs HTTP

struct HTTPError: Error {
    let status: Int
    let message: String
    let type: String
    init(_ status: Int, _ message: String, type: String = "invalid_request_error") {
        self.status = status; self.message = message; self.type = type
    }
}

// MARK: - Schéma JSON → GenerationSchema

/// Convertit un schéma JSON (paramètres d'outil OpenAI, `response_format`) en
/// schéma de génération guidée. Couvre ce que les outils de Lumen produisent :
/// objets, chaînes (avec `enum`), nombres, booléens, tableaux. Le reste retombe
/// sur une chaîne — le modèle produit alors du texte que l'outil saura lire.
func dynamicSchema(_ json: [String: Any], name: String) -> DynamicGenerationSchema {
    let description = json["description"] as? String
    var type = json["type"] as? String
    if type == nil, let types = json["type"] as? [String] { type = types.first(where: { $0 != "null" }) }
    if let options = json["enum"] as? [Any] {
        return DynamicGenerationSchema(name: name, description: description, anyOf: options.map { "\($0)" })
    }
    if let variants = (json["anyOf"] ?? json["oneOf"]) as? [[String: Any]], !variants.isEmpty {
        let usable = variants.filter { ($0["type"] as? String) != "null" }
        if usable.count == 1 { return dynamicSchema(usable[0], name: name) }
        return DynamicGenerationSchema(name: name, description: description,
                                       anyOf: usable.enumerated().map { dynamicSchema($0.element, name: "\(name)_\($0.offset)") })
    }
    switch type ?? (json["properties"] != nil ? "object" : "string") {
    case "object":
        let props = json["properties"] as? [String: Any] ?? [:]
        let required = Set(json["required"] as? [String] ?? [])
        let properties = props.keys.sorted().map { key -> DynamicGenerationSchema.Property in
            let sub = props[key] as? [String: Any] ?? [:]
            return DynamicGenerationSchema.Property(
                name: key,
                description: sub["description"] as? String,
                schema: dynamicSchema(sub, name: "\(name)_\(key)"),
                isOptional: !required.contains(key)
            )
        }
        return DynamicGenerationSchema(name: name, description: description, properties: properties)
    case "array":
        let items = json["items"] as? [String: Any] ?? ["type": "string"]
        return DynamicGenerationSchema(arrayOf: dynamicSchema(items, name: "\(name)_item"),
                                       minimumElements: json["minItems"] as? Int,
                                       maximumElements: json["maxItems"] as? Int)
    case "integer": return DynamicGenerationSchema(type: Int.self)
    case "number": return DynamicGenerationSchema(type: Double.self)
    case "boolean": return DynamicGenerationSchema(type: Bool.self)
    default: return DynamicGenerationSchema(type: String.self)
    }
}

func generationSchema(_ json: [String: Any], name: String) throws -> GenerationSchema {
    do {
        return try GenerationSchema(root: dynamicSchema(json, name: name), dependencies: [])
    } catch {
        throw HTTPError(400, "Schéma JSON non pris en charge par Apple Foundation Models : \(error.localizedDescription)")
    }
}

// MARK: - Outils mandataires

/// Erreur porteuse d'un appel d'outil décidé par le modèle.
struct ToolCallIntercepted: Error {
    let name: String
    let arguments: String
}

struct ProxyTool: Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String
    let name: String
    let description: String
    let parameters: GenerationSchema

    func call(arguments: GeneratedContent) async throws -> String {
        throw ToolCallIntercepted(name: name, arguments: arguments.jsonString)
    }
}

func parseTools(_ raw: Any?) throws -> [ProxyTool] {
    guard let list = raw as? [[String: Any]] else { return [] }
    return try list.compactMap { entry in
        guard let fn = entry["function"] as? [String: Any], let name = fn["name"] as? String, !name.isEmpty else { return nil }
        let params = fn["parameters"] as? [String: Any] ?? ["type": "object", "properties": [:]]
        return ProxyTool(name: name,
                         description: fn["description"] as? String ?? name,
                         parameters: try generationSchema(params, name: "\(name)_args"))
    }
}

// MARK: - Messages OpenAI → transcript

struct ContentParts {
    var text: String = ""
    var images: [CGImage] = []
}

func decodeDataURL(_ url: String) -> CGImage? {
    guard url.hasPrefix("data:"), let comma = url.firstIndex(of: ",") else { return nil }
    let payload = String(url[url.index(after: comma)...])
    guard let data = Data(base64Encoded: payload, options: .ignoreUnknownCharacters),
          let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

/// Le champ `content` d'OpenAI est une chaîne ou une liste de parties.
func contentParts(_ raw: Any?) -> ContentParts {
    var parts = ContentParts()
    if let text = raw as? String { parts.text = text; return parts }
    guard let list = raw as? [[String: Any]] else { return parts }
    var texts: [String] = []
    for part in list {
        switch part["type"] as? String {
        case "text": if let t = part["text"] as? String { texts.append(t) }
        case "image_url":
            let url = (part["image_url"] as? [String: Any])?["url"] as? String ?? part["image_url"] as? String ?? ""
            if let image = decodeDataURL(url) { parts.images.append(image) }
        default: break
        }
    }
    parts.text = texts.joined(separator: "\n")
    return parts
}

func textSegments(_ parts: ContentParts) -> [Transcript.Segment] {
    var segments: [Transcript.Segment] = []
    if !parts.text.isEmpty { segments.append(.text(.init(content: parts.text))) }
    for image in parts.images {
        segments.append(.attachment(.init(content: .image(.init(image)))))
    }
    return segments
}

struct ChatRequest {
    let modelId: String
    let instructions: String
    let toolDefinitions: [Transcript.ToolDefinition]
    let tools: [ProxyTool]
    let history: [Transcript.Entry]
    /// Dernier tour à soumettre. Vide quand le dernier message est une sortie
    /// d'outil : la génération reprend depuis le transcript.
    let prompt: ContentParts
    let options: GenerationOptions
    let contextOptions: ContextOptions
    let responseSchema: GenerationSchema?
    let wantsJsonObject: Bool
    let stream: Bool
}

func parseChatRequest(_ body: [String: Any]) throws -> ChatRequest {
    guard let messages = body["messages"] as? [[String: Any]], !messages.isEmpty else {
        throw HTTPError(400, "`messages` est requis")
    }
    let modelId = (body["model"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? modelOnDevice
    guard modelId == modelOnDevice || modelId == modelPrivateCloud else {
        throw HTTPError(404, "Modèle inconnu : \(modelId). Modèles disponibles : \(modelOnDevice), \(modelPrivateCloud)", type: "not_found_error")
    }

    let toolChoice = body["tool_choice"] as? String
    let tools = toolChoice == "none" ? [] : try parseTools(body["tools"])
    let toolDefinitions = tools.map { Transcript.ToolDefinition(tool: $0) }

    // Instructions = concaténation des messages système (Lumen n'en envoie
    // qu'un, mais certaines apps en ajoutent un second pour le format).
    var instructions = messages
        .filter { ($0["role"] as? String) == "system" || ($0["role"] as? String) == "developer" }
        .map { contentParts($0["content"]).text }
        .filter { !$0.isEmpty }
        .joined(separator: "\n\n")

    var responseSchema: GenerationSchema? = nil
    var wantsJsonObject = false
    if let format = body["response_format"] as? [String: Any] {
        switch format["type"] as? String {
        case "json_schema":
            let spec = format["json_schema"] as? [String: Any] ?? [:]
            let schema = spec["schema"] as? [String: Any] ?? format["schema"] as? [String: Any] ?? [:]
            responseSchema = try generationSchema(schema, name: (spec["name"] as? String) ?? "response")
        case "json_object":
            wantsJsonObject = true
            instructions += (instructions.isEmpty ? "" : "\n\n") + "Réponds uniquement avec un objet JSON valide, sans texte autour."
        default: break
        }
    }

    // Transcript : tout sauf le dernier message utilisateur, qui devient le prompt.
    var entries: [Transcript.Entry] = []
    if !instructions.isEmpty || !toolDefinitions.isEmpty {
        entries.append(.instructions(.init(segments: instructions.isEmpty ? [] : [.text(.init(content: instructions))],
                                           toolDefinitions: toolDefinitions)))
    }
    var toolNames: [String: String] = [:]
    var prompt = ContentParts()
    let lastIndex = messages.indices.last!
    let lastIsUser = (messages[lastIndex]["role"] as? String) == "user"
    for (index, message) in messages.enumerated() {
        let role = message["role"] as? String ?? "user"
        switch role {
        case "system", "developer":
            continue
        case "user":
            let parts = contentParts(message["content"])
            if index == lastIndex && lastIsUser { prompt = parts; continue }
            entries.append(.prompt(.init(segments: textSegments(parts))))
        case "assistant":
            if let calls = message["tool_calls"] as? [[String: Any]], !calls.isEmpty {
                let toolCalls = calls.compactMap { call -> Transcript.ToolCall? in
                    guard let fn = call["function"] as? [String: Any], let name = fn["name"] as? String else { return nil }
                    let id = call["id"] as? String ?? UUID().uuidString
                    toolNames[id] = name
                    let argsRaw = fn["arguments"] as? String ?? "{}"
                    let args = (try? GeneratedContent(json: argsRaw)) ?? GeneratedContent(argsRaw)
                    return Transcript.ToolCall(id: id, toolName: name, arguments: args)
                }
                if !toolCalls.isEmpty { entries.append(.toolCalls(.init(toolCalls))) }
            }
            let parts = contentParts(message["content"])
            if !parts.text.isEmpty {
                entries.append(.response(.init(assetIDs: [], segments: [.text(.init(content: parts.text))])))
            }
        case "tool":
            let id = message["tool_call_id"] as? String ?? UUID().uuidString
            let name = message["name"] as? String ?? toolNames[id] ?? "tool"
            let parts = contentParts(message["content"])
            entries.append(.toolOutput(.init(id: id, toolName: name, segments: [.text(.init(content: parts.text))])))
        default:
            continue
        }
    }

    var options = GenerationOptions()
    if let t = body["temperature"] as? Double { options.temperature = t }
    if let m = (body["max_completion_tokens"] ?? body["max_tokens"]) as? Int, m > 0 { options.maximumResponseTokens = m }

    var contextOptions = ContextOptions()
    switch body["reasoning_effort"] as? String {
    case "low", "minimal": contextOptions.reasoningLevel = .light
    case "medium": contextOptions.reasoningLevel = .moderate
    case "high", "xhigh": contextOptions.reasoningLevel = .deep
    default: break
    }

    return ChatRequest(modelId: modelId, instructions: instructions, toolDefinitions: toolDefinitions, tools: tools,
                       history: entries, prompt: prompt, options: options, contextOptions: contextOptions,
                       responseSchema: responseSchema, wantsJsonObject: wantsJsonObject,
                       stream: body["stream"] as? Bool ?? false)
}

// MARK: - Génération

struct Completion {
    var content: String = ""
    var toolCalls: [(id: String, name: String, arguments: String)] = []
    var inputTokens = 0
    var outputTokens = 0
    /// Chronométrage au format `timings` de llama-server : Lumen en tire les
    /// tokens/s affichés sous chaque réponse. `promptMs` = temps jusqu'au
    /// premier jeton (évaluation du prompt), `predictedMs` = le reste.
    var promptMs: Double = 0
    var predictedMs: Double = 0
    var totalMs: Double { promptMs + predictedMs }
    var finishReason: String { toolCalls.isEmpty ? "stop" : "tool_calls" }
}

func makeSession(_ req: ChatRequest) throws -> LanguageModelSession {
    let transcript = Transcript(entries: req.history)
    if req.modelId == modelPrivateCloud {
        let cloud = PrivateCloudComputeLanguageModel()
        guard hasPrivateCloudEntitlement() else {
            throw HTTPError(503, "Private Cloud Compute exige l'entitlement \(privateCloudEntitlement), absent de cette version de Lumen.", type: "server_error")
        }
        guard cloud.isAvailable else {
            throw HTTPError(503, "Private Cloud Compute indisponible (\(unavailableReason(cloud.availability) ?? "unavailable"))", type: "server_error")
        }
        return LanguageModelSession(model: cloud, tools: req.tools, transcript: transcript)
    }
    let local = SystemLanguageModel.default
    guard local.isAvailable else {
        throw HTTPError(503, "Apple Intelligence indisponible (\(unavailableReason(local.availability) ?? "unavailable"))", type: "server_error")
    }
    return LanguageModelSession(model: local, tools: req.tools, transcript: transcript)
}

func buildPrompt(_ parts: ContentParts) -> Prompt {
    // Reprise après une sortie d'outil : prompt vide, le transcript porte tout.
    // Vérifié sur macOS 27 : le modèle enchaîne bien sur la réponse finale.
    if parts.images.isEmpty { return Prompt(parts.text) }
    return Prompt {
        parts.text
        for image in parts.images { Attachment(image) }
    }
}

/// Message d'erreur lisible pour la bulle de conversation : les erreurs du
/// framework sont typées, autant en tirer une phrase plutôt qu'un identifiant.
func describe(_ error: Error) -> HTTPError {
    if let e = error as? HTTPError { return e }
    if let e = error as? LanguageModelError {
        switch e {
        case .contextSizeExceeded(let c):
            return HTTPError(400, "Conversation trop longue pour Apple Foundation Models (\(c.tokenCount) jetons pour une fenêtre de \(c.contextSize)). Démarrez une nouvelle conversation.", type: "context_length_exceeded")
        case .guardrailViolation: return HTTPError(400, "Apple Intelligence a refusé cette demande (garde-fous de sécurité).", type: "guardrail_violation")
        case .refusal: return HTTPError(400, "Apple Intelligence a refusé de répondre à cette demande.", type: "refusal")
        case .rateLimited: return HTTPError(429, "Apple Foundation Models : trop de requêtes, réessayez dans un instant.", type: "rate_limit_error")
        case .unsupportedLanguageOrLocale: return HTTPError(400, "Langue non prise en charge par Apple Foundation Models.", type: "unsupported_language")
        case .unsupportedGenerationGuide: return HTTPError(400, "Schéma de réponse non pris en charge par Apple Foundation Models.", type: "unsupported_schema")
        case .unsupportedCapability: return HTTPError(400, "Ce modèle Apple ne prend pas en charge cette fonction (images, outils ou sortie structurée).", type: "unsupported_capability")
        case .unsupportedTranscriptContent: return HTTPError(400, "Contenu de conversation non pris en charge par Apple Foundation Models.", type: "invalid_request_error")
        case .timeout: return HTTPError(504, "Apple Foundation Models n'a pas répondu à temps.", type: "timeout")
        @unknown default: break
        }
    }
    if let e = error as? PrivateCloudComputeLanguageModel.Error {
        switch e {
        case .networkFailure: return HTTPError(503, "Private Cloud Compute injoignable (réseau).", type: "server_error")
        case .quotaLimitReached(let q):
            let reset = q.resetDate.map { " Réinitialisation : \($0.formatted(date: .abbreviated, time: .shortened))." } ?? ""
            return HTTPError(429, "Quota Private Cloud Compute atteint.\(reset)", type: "rate_limit_error")
        case .serviceUnavailable: return HTTPError(503, "Private Cloud Compute indisponible pour le moment.", type: "server_error")
        @unknown default: break
        }
    }
    return HTTPError(500, error.localizedDescription, type: "server_error")
}

/// Génération complète. `onDelta` reçoit les morceaux de texte au fil de l'eau
/// (streaming SSE) ; nil en mode non-stream.
func generate(_ req: ChatRequest, onDelta: ((String) -> Void)?) async throws -> Completion {
    let session = try makeSession(req)
    let prompt = buildPrompt(req.prompt)
    var result = Completion()
    let start = Date()
    var firstToken: Date? = nil
    let ms = { (from: Date, to: Date) in to.timeIntervalSince(from) * 1000 }
    do {
        if let schema = req.responseSchema {
            let response = try await session.respond(to: prompt, schema: schema, options: req.options, contextOptions: req.contextOptions)
            result.content = response.content.jsonString
            onDelta?(result.content)
            result.inputTokens = response.usage.input.totalTokenCount
            result.outputTokens = response.usage.output.totalTokenCount
        } else {
            // Toujours en flux, même sans client SSE : c'est le seul moyen de
            // dater le premier jeton, donc de séparer évaluation du prompt et
            // génération dans les timings.
            var emitted = ""
            var usage: LanguageModelSession.Usage? = nil
            for try await snapshot in session.streamResponse(to: prompt, options: req.options, contextOptions: req.contextOptions) {
                let full = snapshot.content
                if firstToken == nil && !full.isEmpty { firstToken = Date() }
                if let onDelta {
                    if full.hasPrefix(emitted) {
                        let delta = String(full.dropFirst(emitted.count))
                        if !delta.isEmpty { onDelta(delta) }
                    } else {
                        // Le modèle a réécrit sa sortie (rare) : on renvoie tout.
                        onDelta(full)
                    }
                }
                emitted = full
                usage = snapshot.usage
            }
            result.content = emitted
            result.inputTokens = usage?.input.totalTokenCount ?? 0
            result.outputTokens = usage?.output.totalTokenCount ?? 0
        }
    } catch let error as LanguageModelSession.ToolCallError {
        guard let call = error.underlyingError as? ToolCallIntercepted else { throw describe(error.underlyingError) }
        result.toolCalls = [(id: "call_" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(24).description,
                             name: call.name, arguments: call.arguments)]
        result.inputTokens = session.usage.input.totalTokenCount
        result.outputTokens = session.usage.output.totalTokenCount
    } catch {
        throw describe(error)
    }
    let end = Date()
    if let first = firstToken {
        result.promptMs = ms(start, first)
        result.predictedMs = ms(first, end)
    } else {
        // Réponse d'un bloc (schéma, appel d'outil) : impossible de séparer,
        // tout est compté en génération pour que les tokens/s restent définis.
        result.predictedMs = ms(start, end)
    }
    return result
}

// MARK: - Réponses OpenAI

func completionId() -> String { "chatcmpl-" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(24) }
func now() -> Int { Int(Date().timeIntervalSince1970) }

func toolCallsJSON(_ calls: [(id: String, name: String, arguments: String)], streaming: Bool) -> [[String: Any]] {
    calls.enumerated().map { index, call in
        var entry: [String: Any] = ["id": call.id, "type": "function", "function": ["name": call.name, "arguments": call.arguments]]
        if streaming { entry["index"] = index }
        return entry
    }
}

func usageJSON(_ c: Completion) -> [String: Any] {
    ["prompt_tokens": c.inputTokens, "completion_tokens": c.outputTokens, "total_tokens": c.inputTokens + c.outputTokens]
}

/// Bloc `timings` au format llama-server, que Lumen sait déjà convertir en
/// métriques Ollama (`eval_count`, `eval_duration`…) pour ses widgets.
func timingsJSON(_ c: Completion) -> [String: Any] {
    [
        "prompt_n": c.inputTokens, "prompt_ms": c.promptMs,
        "predicted_n": c.outputTokens, "predicted_ms": c.predictedMs,
        "total_ms": c.totalMs,
        "predicted_per_second": c.predictedMs > 0 ? Double(c.outputTokens) / (c.predictedMs / 1000) : 0,
    ]
}

func completionJSON(_ req: ChatRequest, _ c: Completion, id: String) -> [String: Any] {
    var message: [String: Any] = ["role": "assistant", "content": c.toolCalls.isEmpty ? c.content : NSNull()]
    if !c.toolCalls.isEmpty { message["tool_calls"] = toolCallsJSON(c.toolCalls, streaming: false) }
    return [
        "id": id, "object": "chat.completion", "created": now(), "model": req.modelId,
        "choices": [["index": 0, "message": message, "finish_reason": c.finishReason, "logprobs": NSNull()]],
        "usage": usageJSON(c),
        "timings": timingsJSON(c),
    ]
}

func chunkJSON(_ req: ChatRequest, id: String, delta: [String: Any], finish: String?, usage: Completion? = nil) -> [String: Any] {
    var chunk: [String: Any] = [
        "id": id, "object": "chat.completion.chunk", "created": now(), "model": req.modelId,
        "choices": [["index": 0, "delta": delta, "finish_reason": finish.map { $0 as Any } ?? NSNull()]],
    ]
    if let u = usage {
        chunk["usage"] = usageJSON(u)
        chunk["timings"] = timingsJSON(u)
    }
    return chunk
}

func jsonData(_ object: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
}

// MARK: - Serveur HTTP minimal (Network.framework)

/// Garde les connexions ouvertes en vie : NWListener ne retient pas ses
/// connexions, et une `HTTPConnection` sans référence serait libérée avant la
/// réception de la requête.
final class ConnectionRegistry: @unchecked Sendable {
    static let shared = ConnectionRegistry()
    private var live: [ObjectIdentifier: HTTPConnection] = [:]
    private let lock = NSLock()
    func add(_ c: HTTPConnection) { lock.lock(); live[ObjectIdentifier(c)] = c; lock.unlock() }
    func remove(_ c: HTTPConnection) { lock.lock(); live[ObjectIdentifier(c)] = nil; lock.unlock() }
}

final class HTTPConnection: @unchecked Sendable {
    let connection: NWConnection
    private var buffer = Data()
    private var headersDone = false
    private var method = ""
    private var path = ""
    private var contentLength = 0
    private var headerEnd = 0
    private let lock = NSLock()
    private var closed = false

    init(_ connection: NWConnection) { self.connection = connection }

    func start() {
        ConnectionRegistry.shared.add(self)
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.close() }
        }
        connection.start(queue: .global(qos: .userInitiated))
        receive()
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data { self.buffer.append(data) }
            if error != nil { self.close(); return }
            if self.tryDispatch() { return }
            if isComplete { self.close(); return }
            self.receive()
        }
    }

    /// Vrai quand la requête est complète et partie en traitement.
    private func tryDispatch() -> Bool {
        if !headersDone {
            guard let range = buffer.range(of: Data("\r\n\r\n".utf8)) else { return false }
            let head = String(decoding: buffer[..<range.lowerBound], as: UTF8.self)
            let lines = head.components(separatedBy: "\r\n")
            let parts = lines.first?.split(separator: " ", maxSplits: 2).map(String.init) ?? []
            guard parts.count >= 2 else { send(HTTPError(400, "Requête malformée")); return true }
            method = parts[0].uppercased()
            path = parts[1]
            for line in lines.dropFirst() {
                let kv = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                if kv.count == 2, kv[0].lowercased() == "content-length" { contentLength = Int(kv[1]) ?? 0 }
            }
            headerEnd = range.upperBound
            headersDone = true
        }
        guard buffer.count - headerEnd >= contentLength else { return false }
        let body = buffer[headerEnd..<(headerEnd + contentLength)]
        Task { await self.route(body: Data(body)) }
        return true
    }

    private func route(body: Data) async {
        let route = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        switch (method, route) {
        case ("GET", "/health"), ("GET", "/"):
            let models = listModels()
            send(status: 200, json: [
                "ok": true,
                "available": models.contains { $0.available },
                "port": Int(listenPort),
                "models": models.map { ["id": $0.id, "available": $0.available, "reason": $0.reason ?? NSNull(), "capabilities": $0.capabilities, "context_size": $0.contextSize] },
            ])
        case ("GET", "/v1/models"), ("GET", "/models"):
            let data = listModels().filter { $0.available }.map { m -> [String: Any] in
                ["id": m.id, "object": "model", "created": 0, "owned_by": "apple", "capabilities": m.capabilities, "context_size": m.contextSize]
            }
            send(status: 200, json: ["object": "list", "data": data])
        case ("POST", "/v1/chat/completions"), ("POST", "/chat/completions"):
            await chat(body: body)
        case ("OPTIONS", _):
            send(status: 204, headers: ["Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS"], body: Data())
        default:
            send(HTTPError(404, "Route inconnue : \(method) \(route)", type: "not_found_error"))
        }
    }

    private func chat(body: Data) async {
        let req: ChatRequest
        do {
            guard let object = try JSONSerialization.jsonObject(with: body) as? [String: Any] else {
                throw HTTPError(400, "Corps JSON attendu")
            }
            req = try parseChatRequest(object)
        } catch {
            send(describe(error)); return
        }
        let id = completionId()
        if !req.stream {
            do {
                let completion = try await generate(req, onDelta: nil)
                send(status: 200, json: completionJSON(req, completion, id: id))
            } catch {
                send(describe(error))
            }
            return
        }
        // Streaming SSE en transfert par morceaux : l'en-tête part tout de
        // suite, puis un événement par delta, puis [DONE].
        sendHead(status: 200, headers: ["Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Transfer-Encoding": "chunked"])
        sendChunk(sse(chunkJSON(req, id: id, delta: ["role": "assistant", "content": ""], finish: nil)))
        do {
            let completion = try await generate(req) { delta in
                self.sendChunk(self.sse(chunkJSON(req, id: id, delta: ["content": delta], finish: nil)))
            }
            if !completion.toolCalls.isEmpty {
                sendChunk(sse(chunkJSON(req, id: id, delta: ["tool_calls": toolCallsJSON(completion.toolCalls, streaming: true)], finish: nil)))
            }
            sendChunk(sse(chunkJSON(req, id: id, delta: [:], finish: completion.finishReason, usage: completion)))
        } catch {
            let e = describe(error)
            sendChunk(sse(["error": ["message": e.message, "type": e.type, "code": e.status]]))
        }
        sendChunk(Data("data: [DONE]\n\n".utf8))
        sendChunk(Data())
        close()
    }

    private func sse(_ object: Any) -> Data {
        var data = Data("data: ".utf8)
        data.append(jsonData(object))
        data.append(Data("\n\n".utf8))
        return data
    }

    // -- Écriture --

    private func send(_ error: HTTPError) {
        send(status: error.status, json: ["error": ["message": error.message, "type": error.type, "code": error.status]])
    }

    private func send(status: Int, json: Any) {
        send(status: status, headers: ["Content-Type": "application/json; charset=utf-8"], body: jsonData(json))
    }

    private func send(status: Int, headers: [String: String], body: Data) {
        var all = headers
        all["Content-Length"] = String(body.count)
        sendHead(status: status, headers: all)
        write(body)
        close()
    }

    private func sendHead(status: Int, headers: [String: String]) {
        let reason: String
        switch status {
        case 200: reason = "OK"; case 204: reason = "No Content"; case 400: reason = "Bad Request"
        case 404: reason = "Not Found"; case 429: reason = "Too Many Requests"; case 503: reason = "Service Unavailable"; case 504: reason = "Gateway Timeout"
        default: reason = status >= 500 ? "Internal Server Error" : "Error"
        }
        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        var all = headers
        all["Connection"] = "close"
        all["Access-Control-Allow-Origin"] = "*"
        all["Server"] = "lumen-applefm"
        for (k, v) in all.sorted(by: { $0.key < $1.key }) { head += "\(k): \(v)\r\n" }
        head += "\r\n"
        write(Data(head.utf8))
    }

    private func sendChunk(_ data: Data) {
        var frame = Data(String(data.count, radix: 16).utf8)
        frame.append(Data("\r\n".utf8))
        frame.append(data)
        frame.append(Data("\r\n".utf8))
        write(frame)
    }

    private func write(_ data: Data) {
        lock.lock(); let isClosed = closed; lock.unlock()
        if isClosed { return }
        connection.send(content: data, completion: .contentProcessed { _ in })
    }

    private func close() {
        lock.lock()
        if closed { lock.unlock(); return }
        closed = true
        lock.unlock()
        // Laisser partir ce qui est en file avant de couper.
        connection.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [connection] _ in
            connection.cancel()
        })
        ConnectionRegistry.shared.remove(self)
    }
}

// MARK: - Point d'entrée

@main
struct LumenAppleFM {
    static func main() async {
        if CommandLine.arguments.contains("--probe") {
            // Mode sonde : imprime l'état puis s'arrête. Utilisé par Lumen pour
            // savoir s'il vaut la peine de proposer la source, sans ouvrir de port.
            let models = listModels()
            let json: [String: Any] = [
                "available": models.contains { $0.available },
                "models": models.map { ["id": $0.id, "available": $0.available, "reason": $0.reason ?? NSNull(), "capabilities": $0.capabilities, "context_size": $0.contextSize] },
            ]
            FileHandle.standardOutput.write(jsonData(json))
            FileHandle.standardOutput.write(Data("\n".utf8))
            return
        }

        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(listenHost), port: NWEndpoint.Port(rawValue: listenPort)!)
        let listener: NWListener
        do { listener = try NWListener(using: params) } catch {
            log("impossible d'écouter sur \(listenHost):\(listenPort) : \(error)")
            exit(2)
        }
        listener.newConnectionHandler = { connection in
            HTTPConnection(connection).start()
        }
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                log("à l'écoute sur http://\(listenHost):\(listenPort)/v1")
                // Préchauffe le modèle local : la première réponse arrive plus vite.
                if SystemLanguageModel.default.isAvailable {
                    LanguageModelSession(model: SystemLanguageModel.default).prewarm()
                }
            case .failed(let error):
                log("écoute interrompue : \(error)")
                exit(2)
            default: break
            }
        }
        listener.start(queue: .global(qos: .userInitiated))

        // Le processus est lancé par Lumen ; quand Lumen disparaît sans nous
        // tuer (crash, kill -9), on part avec lui pour ne pas squatter le port.
        let parent = getppid()
        while true {
            try? await Task.sleep(for: .seconds(2))
            if getppid() != parent { log("parent disparu, arrêt"); exit(0) }
        }
    }
}
