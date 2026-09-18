import CryptoKit
import Foundation
import PiRemoteCore
import Security

enum DeviceIdentityStoreError: LocalizedError {
    case invalidStoredIdentity
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidStoredIdentity:
            return "The stored Pi Remote device identity is invalid."
        case let .keychain(status):
            return "Keychain operation failed with status \(status)."
        }
    }
}

actor DeviceIdentityStore {
    private struct StoredIdentity: Codable {
        let version: Int
        let id: String
        let name: String
        let signingPrivateKey: Data
        let keyAgreementPrivateKey: Data
    }

    private let service = "top.grimlee.piremote.identity"
    private let account = "device-identity-v1"
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    func loadOrCreate(deviceName: String = "iPhone") throws -> DevicePublicIdentity {
        if let stored = try loadStoredIdentity() {
            return try publicIdentity(from: stored)
        }

        let stored = StoredIdentity(
            version: 1,
            id: "device_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased(),
            name: deviceName,
            signingPrivateKey: Curve25519.Signing.PrivateKey().rawRepresentation,
            keyAgreementPrivateKey: Curve25519.KeyAgreement.PrivateKey().rawRepresentation
        )

        try save(stored)
        return try publicIdentity(from: stored)
    }

    func publicIdentity() throws -> DevicePublicIdentity {
        guard let stored = try loadStoredIdentity() else {
            throw DeviceIdentityStoreError.invalidStoredIdentity
        }
        return try publicIdentity(from: stored)
    }

    func signature(for message: Data) throws -> Data {
        guard let stored = try loadStoredIdentity() else {
            throw DeviceIdentityStoreError.invalidStoredIdentity
        }

        let key = try Curve25519.Signing.PrivateKey(
            rawRepresentation: stored.signingPrivateKey
        )
        return try key.signature(for: message)
    }

    private func publicIdentity(from stored: StoredIdentity) throws -> DevicePublicIdentity {
        guard stored.version == 1,
              stored.id.hasPrefix("device_"),
              !stored.name.isEmpty
        else {
            throw DeviceIdentityStoreError.invalidStoredIdentity
        }

        let signingKey = try Curve25519.Signing.PrivateKey(
            rawRepresentation: stored.signingPrivateKey
        )
        let agreementKey = try Curve25519.KeyAgreement.PrivateKey(
            rawRepresentation: stored.keyAgreementPrivateKey
        )

        return DevicePublicIdentity(
            id: stored.id,
            name: stored.name,
            signingPublicKey: signingKey.publicKey.rawRepresentation.base64URLEncodedString(),
            keyAgreementPublicKey: agreementKey.publicKey.rawRepresentation.base64URLEncodedString()
        )
    }

    private func loadStoredIdentity() throws -> StoredIdentity? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ]

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw DeviceIdentityStoreError.keychain(status)
        }
        guard let data = result as? Data else {
            throw DeviceIdentityStoreError.invalidStoredIdentity
        }

        let stored = try decoder.decode(StoredIdentity.self, from: data)
        guard stored.version == 1 else {
            throw DeviceIdentityStoreError.invalidStoredIdentity
        }
        return stored
    }

    private func save(_ stored: StoredIdentity) throws {
        let data = try encoder.encode(stored)

        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ]

        let attributes: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]

        let addQuery = query.merging(attributes) { _, new in new }
        let status = SecItemAdd(addQuery as CFDictionary, nil)

        if status == errSecDuplicateItem {
            let updateStatus = SecItemUpdate(
                query as CFDictionary,
                attributes as CFDictionary
            )
            guard updateStatus == errSecSuccess else {
                throw DeviceIdentityStoreError.keychain(updateStatus)
            }
            return
        }

        guard status == errSecSuccess else {
            throw DeviceIdentityStoreError.keychain(status)
        }
    }
}
