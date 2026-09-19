import Foundation
import PiRemoteCore
import Security

struct PairedHostProfile: Codable, Hashable, Sendable {
    let version: Int
    let relayURL: String
    let transport: PairingTransport?
    let fallbackRelayURL: String?
    let machine: PairingMachineIdentity

    init(
        version: Int = 1,
        relayURL: String,
        transport: PairingTransport? = nil,
        fallbackRelayURL: String? = nil,
        machine: PairingMachineIdentity
    ) {
        self.version = version
        self.relayURL = relayURL
        self.transport = transport
        self.fallbackRelayURL = fallbackRelayURL
        self.machine = machine
    }
}

enum PairedHostProfileStoreError: LocalizedError {
    case invalidProfile
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidProfile:
            return "The stored Pi Remote host profile is invalid."
        case let .keychain(status):
            return "Keychain operation failed with status \(status)."
        }
    }
}

actor PairedHostProfileStore {
    private let service = "top.grimlee.piremote.identity"
    private let account = "paired-host-profile-v1"
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    func load() throws -> PairedHostProfile? {
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
            throw PairedHostProfileStoreError.keychain(status)
        }
        guard let data = result as? Data,
              let profile = try? decoder.decode(
                PairedHostProfile.self,
                from: data
              ),
              profile.version == 1,
              profile.machine.id.hasPrefix("machine_"),
              URL(string: profile.relayURL) != nil
        else {
            throw PairedHostProfileStoreError.invalidProfile
        }
        return profile
    }

    func save(_ profile: PairedHostProfile) throws {
        guard profile.version == 1,
              profile.machine.id.hasPrefix("machine_"),
              URL(string: profile.relayURL) != nil
        else {
            throw PairedHostProfileStoreError.invalidProfile
        }

        let data = try encoder.encode(profile)
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
                throw PairedHostProfileStoreError.keychain(updateStatus)
            }
            return
        }

        guard status == errSecSuccess else {
            throw PairedHostProfileStoreError.keychain(status)
        }
    }

    func clear() throws {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw PairedHostProfileStoreError.keychain(status)
        }
    }
}
