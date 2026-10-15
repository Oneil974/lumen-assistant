import Foundation
import LocalAuthentication
import Security

/// Clé de déverrouillage Face ID : une clé P-256 créée DANS la Secure Enclave,
/// inexportable, utilisable seulement après Face ID (ou Touch ID) du
/// propriétaire actuel — si un visage est ajouté ou retiré, elle devient
/// inutilisable (`.biometryCurrentSet`). Lumen garde la clé publique et
/// vérifie la signature d'un défi (src-tauri/src/devices.rs).
enum BiometricKey {
    private static func tag(_ server: URL) -> Data {
        Data("lumen.unlock.\(server.absoluteString)".utf8)
    }

    static var available: Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    }

    static var biometryName: String {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        return ctx.biometryType == .touchID ? "Touch ID" : "Face ID"
    }

    static func exists(for server: URL) -> Bool { privateKey(for: server, context: nil) != nil }

    /// Crée (ou recrée) la clé et renvoie la clé publique SEC1 en base64.
    static func create(for server: URL) throws -> String {
        delete(for: server)
        var err: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .biometryCurrentSet], &err) else {
            throw err!.takeRetainedValue() as Error
        }
        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: tag(server),
                kSecAttrAccessControl as String: access,
            ],
        ]
        guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &err),
              let pub = SecKeyCopyPublicKey(key),
              let data = SecKeyCopyExternalRepresentation(pub, &err) as Data? else {
            throw err!.takeRetainedValue() as Error
        }
        return data.base64EncodedString()
    }

    static func delete(for server: URL) {
        SecItemDelete([
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag(server),
        ] as CFDictionary)
    }

    private static func privateKey(for server: URL, context: LAContext?) -> SecKey? {
        var q: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag(server),
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true,
        ]
        if let context { q[kSecUseAuthenticationContext as String] = context }
        else { q[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip }
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let out else { return nil }
        return (out as! SecKey)
    }

    /// Signe le défi : déclenche Face ID. Renvoie la signature DER en base64.
    static func sign(_ challenge: String, for server: URL, reason: String) async throws -> String {
        let ctx = LAContext()
        ctx.localizedReason = reason
        // Évaluation explicite d'abord : message clair, et l'échec « annulé »
        // remonte comme une erreur lisible.
        try await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        guard let key = privateKey(for: server, context: ctx) else {
            throw NSError(domain: "Lumen", code: 1, userInfo: [NSLocalizedDescriptionKey: L("Active Face ID dans les réglages de l'app.")])
        }
        var err: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, Data(challenge.utf8) as CFData, &err) as Data? else {
            throw err!.takeRetainedValue() as Error
        }
        return sig.base64EncodedString()
    }
}
