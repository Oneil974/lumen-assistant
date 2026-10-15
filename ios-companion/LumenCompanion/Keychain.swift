import Foundation
import Security

/// Jeton d'appairage, rangé dans le trousseau par adresse de Lumen (la PWA le
/// garde en localStorage ; ici on a mieux).
enum Keychain {
    private static let service = "com.lumen.companion.token"

    static func token(for server: URL) -> String? {
        var q = base(server)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func setToken(_ token: String?, for server: URL) {
        SecItemDelete(base(server) as CFDictionary)
        guard let token, !token.isEmpty else { return }
        var q = base(server)
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(q as CFDictionary, nil)
    }

    private static func base(_ server: URL) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: server.absoluteString]
    }
}
