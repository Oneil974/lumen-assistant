import AVFoundation
import Observation
import Speech

/// Voix 100 % locale à l'iPhone, comme dans la PWA :
///  - énonciation AVSpeechSynthesizer (meilleure voix installée par défaut ;
///    les voix Siri ne sont pas ouvertes aux apps tierces) ;
///  - dictée native SFSpeechRecognizer, sur l'appareil quand c'est possible.
@MainActor
@Observable
final class SpeechService: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    private(set) var speaking = false
    private(set) var listening = false
    private(set) var partial = ""

    var voiceID: String {
        didSet { UserDefaults.standard.set(voiceID, forKey: "companionVoiceURI") }
    }

    private let synth = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private let audioEngine = AVAudioEngine()
    private var recognition: SFSpeechRecognitionTask?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var onFinal: ((String) -> Void)?

    override init() {
        voiceID = UserDefaults.standard.string(forKey: "companionVoiceURI") ?? ""
        super.init()
        synth.delegate = self
    }

    // MARK: Énonciation

    struct Voice: Identifiable, Hashable { let id: String; let label: String }

    /// Français puis anglais, meilleure qualité d'abord (même filtre que la PWA).
    var voices: [Voice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { !$0.voiceTraits.contains(.isNoveltyVoice) }
            .filter { $0.language.hasPrefix("fr") || $0.language.hasPrefix("en") }
            .sorted {
                let a = ($0.language.hasPrefix("fr") ? 0 : 1, -$0.quality.rawValue, $0.name)
                let b = ($1.language.hasPrefix("fr") ? 0 : 1, -$1.quality.rawValue, $1.name)
                return a < b
            }
            .map { v in
                let q = v.quality == .premium ? " · " + L("premium") : v.quality == .enhanced ? " · " + L("améliorée") : ""
                return Voice(id: v.identifier, label: "\(v.name) (\(v.language))\(q)")
            }
    }

    // La session audio se configure HORS du fil principal : ces appels
    // peuvent bloquer (Xcode le signale : « UI unresponsiveness »).
    private static let audioQueue = DispatchQueue(label: "lumen.audio-session")

    private static func configure(_ category: AVAudioSession.Category, mode: AVAudioSession.Mode,
                                  options: AVAudioSession.CategoryOptions) async -> Bool {
        await withCheckedContinuation { c in
            audioQueue.async {
                let s = AVAudioSession.sharedInstance()
                do {
                    try s.setCategory(category, mode: mode, options: options)
                    try s.setActive(true, options: .notifyOthersOnDeactivation)
                    c.resume(returning: true)
                } catch { c.resume(returning: false) }
            }
        }
    }

    private static func deactivate() {
        audioQueue.async { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }

    func speak(_ text: String, queue: Bool = false) {
        let clean = Self.stripForSpeech(text)
        guard !clean.isEmpty else { return }
        if !queue { synth.stopSpeaking(at: .immediate) }
        let u = AVSpeechUtterance(string: clean)
        u.voice = AVSpeechSynthesisVoice(identifier: voiceID) ?? Self.bestVoice()
        Task {
            _ = await Self.configure(.playback, mode: .spokenAudio, options: [.duckOthers])
            synth.speak(u)
        }
    }

    func stopSpeaking() {
        synth.stopSpeaking(at: .immediate)
        if let player { player.stop(); self.player = nil; finishSpeaking() }
    }

    /// Lit avec une voix nommée (voix système choisie pour un agent,
    /// « system:<nom> ») si l'iPhone la possède, sinon la voix réglée.
    func speak(_ text: String, voiceName: String) {
        let name = voiceName.lowercased()
        guard !name.isEmpty,
              let v = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.name.lowercased() == name || $0.name.lowercased().hasPrefix(name + " ") })
        else { speak(text); return }
        let clean = Self.stripForSpeech(text)
        guard !clean.isEmpty else { return }
        synth.stopSpeaking(at: .immediate)
        let u = AVSpeechUtterance(string: clean)
        u.voice = v
        Task {
            _ = await Self.configure(.playback, mode: .spokenAudio, options: [.duckOthers])
            synth.speak(u)
        }
    }

    /// Joue un WAV synthétisé par l'ordinateur (voix Piper/Kokoro d'un agent).
    /// false si le son est illisible : l'appelant parle alors lui-même.
    func play(wav: Data) async -> Bool {
        stopSpeaking()
        _ = await Self.configure(.playback, mode: .spokenAudio, options: [.duckOthers])
        guard let p = try? AVAudioPlayer(data: wav) else { return false }
        p.delegate = self
        player = p
        speaking = true
        return p.play()
    }

    nonisolated func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            guard self.player === p else { return }
            self.player = nil
            self.finishSpeaking()
        }
    }

    static func bestVoice() -> AVSpeechSynthesisVoice? {
        let lang = Locale.preferredLanguages.first ?? "fr-FR"
        let prefix = String(lang.prefix(2))
        return AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix(prefix) && !$0.voiceTraits.contains(.isNoveltyVoice) }
            .max { ($0.quality.rawValue, $0.language == lang ? 1 : 0) < ($1.quality.rawValue, $1.language == lang ? 1 : 0) }
            ?? AVSpeechSynthesisVoice(language: lang)
    }

    /// Emojis et symboles retirés avant lecture (ils restent à l'écran).
    static func stripForSpeech(_ text: String) -> String {
        let scalars = text.unicodeScalars.filter { !($0.properties.isEmojiPresentation || ($0.properties.isEmoji && $0.value > 0x238C) || $0.value == 0xFE0F || $0.value == 0x200D) }
        return String(String.UnicodeScalarView(scalars))
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) {
        Task { @MainActor in self.speaking = true }
    }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in self.finishSpeaking() }
    }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        Task { @MainActor in self.finishSpeaking() }
    }
    private func finishSpeaking() {
        guard !synth.isSpeaking, player == nil else { return }
        speaking = false
        onSpeakingDone?()
        if !listening { Self.deactivate() }
    }

    // MARK: Dictée

    /// Démarre (ou arrête) la dictée ; `onText` reçoit le texte au fil de l'eau.
    /// Fin de lecture (mode mains libres : on se remet à écouter).
    var onSpeakingDone: (() -> Void)?
    private var silenceTask: Task<Void, Never>?

    /// `onFinal` : appelé avec la phrase complète quand l'utilisateur se tait
    /// 1,4 s (mode mains libres) — sans lui, la dictée remplit juste le champ.
    func toggleDictation(onText: @escaping (String) -> Void, onFinal: ((String) -> Void)? = nil) async -> String? {
        if listening { stopDictation(); return nil }
        stopSpeaking()

        let auth = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
        guard auth == .authorized else { return "Autorise la reconnaissance vocale dans Réglages › Lumen." }
        guard await AVAudioApplication.requestRecordPermission() else { return "Autorise le micro dans Réglages › Lumen." }

        let locale = Locale(identifier: Locale.preferredLanguages.first ?? "fr-FR")
        guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(locale: Locale(identifier: "fr-FR")),
              recognizer.isAvailable else { return "Dictée indisponible." }

        guard await Self.configure(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker]) else {
            return "Micro indisponible."
        }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        req.addsPunctuation = true
        request = req

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in req.append(buffer) }
        audioEngine.prepare()
        do { try audioEngine.start() } catch { return "Micro indisponible." }

        listening = true
        partial = ""
        recognition = recognizer.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.partial = result.bestTranscription.formattedString
                    onText(self.partial)
                    if let onFinal {
                        // Silence de 1,4 s après la dernière évolution : fin de phrase.
                        self.silenceTask?.cancel()
                        let snapshot = self.partial
                        self.silenceTask = Task { @MainActor in
                            try? await Task.sleep(for: .milliseconds(1400))
                            guard !Task.isCancelled, self.listening, self.partial == snapshot, !snapshot.isEmpty else { return }
                            self.stopDictation()
                            onFinal(snapshot)
                        }
                    }
                    if result.isFinal {
                        let text = self.partial
                        self.stopDictation()
                        if let onFinal, !text.isEmpty { self.silenceTask?.cancel(); onFinal(text) }
                    }
                }
                if error != nil { self.stopDictation() }
            }
        }
        return nil
    }

    func stopDictation() {
        silenceTask?.cancel()
        guard listening else { return }
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        recognition?.cancel()
        recognition = nil
        request = nil
        listening = false
        Self.deactivate()
    }
}
