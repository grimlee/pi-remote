import Foundation
import PiRemoteCore
import Security

enum MachineGrantStoreError: LocalizedError {
    case invalidGrant
    case invalidStoredGrants
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidGrant:
            return "The machine authorization grant is invalid."
        case .invalidStoredGrants:
            return "Stored Pi Remote machine grants are invalid."
        case let .keychain(status):
            return "Keychain operation failed with status \(status)."
        }
    }
}

actor MachineGrantStore {
    private let service = "top.grimlee.piremote.identity"
    private let account = "machine-grants-v1"
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    func all(for device: DevicePublicIdentity) throws -> [MachineGrant] {
        try load().filter { grant in
            MachineGrantCrypto.isValid(grant)
                && grant.device.id == device.id
                && grant.device.signingPublicKey == device.signingPublicKey
                && grant.device.keyAgreementPublicKey == device.keyAgreementPublicKey
        }
    }

    func grant(
        machineId: String,
        signingPublicKey: String,
        keyAgreementPublicKey: String,
        for device: DevicePublicIdentity
    ) throws -> MachineGrant? {
        try all(for: device).first { grant in
            grant.machine.id == machineId
                && grant.machine.signingPublicKey == signingPublicKey
                && grant.machine.keyAgreementPublicKey == keyAgreementPublicKey
        }
    }

    func save(_ grant: MachineGrant, for device: DevicePublicIdentity) throws {
        guard MachineGrantCrypto.isValid(grant),
              grant.device.id == device.id,
              grant.device.signingPublicKey == device.signingPublicKey,
              grant.device.keyAgreementPublicKey == device.keyAgreementPublicKey
        else {
            throw MachineGrantStoreError.invalidGrant
        }

        var grants = try load()
        grants.removeAll {
            $0.machine.id == grant.machine.id
                && $0.machine.signingPublicKey == grant.machine.signingPublicKey
        }
        grants.append(grant)
        try persist(grants)
    }

    func remove(machineId: String) throws {
        var grants = try load()
        grants.removeAll { $0.machine.id == machineId }
        try persist(grants)
    }

    private func load() throws -> [MachineGrant] {
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
            return []
        }
        guard status == errSecSuccess else {
            throw MachineGrantStoreError.keychain(status)
        }
        guard let data = result as? Data,
              let grants = try? decoder.decode([MachineGrant].self, from: data),
              grants.allSatisfy(MachineGrantCrypto.isValid)
        else {
            throw MachineGrantStoreError.invalidStoredGrants
        }
        return grants
    }

    private func persist(_ grants: [MachineGrant]) throws {
        let data = try encoder.encode(grants)
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
                throw MachineGrantStoreError.keychain(updateStatus)
            }
            return
        }

        guard status == errSecSuccess else {
            throw MachineGrantStoreError.keychain(status)
        }
    }
}
