import Foundation
import PiRemoteCore

private struct ConversationCacheRecord: Codable, Sendable {
    let version: Int
    let machineId: String
    let sessionId: String
    let updatedAt: Date
    let messages: [JSONValue]
}

actor ConversationCacheStore {
    private let rootURL: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(rootURL: URL? = nil) {
        if let rootURL {
            self.rootURL = rootURL
        } else {
            let base = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first ?? URL(
                fileURLWithPath: NSTemporaryDirectory(),
                isDirectory: true
            )
            self.rootURL = base
                .appendingPathComponent("PiRemote", isDirectory: true)
                .appendingPathComponent("Conversations", isDirectory: true)
        }
    }

    func load(
        machineId: String,
        sessionId: String
    ) throws -> [JSONValue] {
        let url = fileURL(
            machineId: machineId,
            sessionId: sessionId
        )
        guard FileManager.default.fileExists(atPath: url.path) else {
            return []
        }

        let data = try Data(contentsOf: url)
        let record = try decoder.decode(
            ConversationCacheRecord.self,
            from: data
        )

        guard record.version == 1,
              record.machineId == machineId,
              record.sessionId == sessionId
        else {
            return []
        }

        return record.messages
    }

    func save(
        machineId: String,
        sessionId: String,
        messages: [JSONValue]
    ) throws {
        let directory = machineDirectory(machineId: machineId)
        try ensureDirectory(directory)

        let record = ConversationCacheRecord(
            version: 1,
            machineId: machineId,
            sessionId: sessionId,
            updatedAt: Date(),
            messages: messages
        )
        let data = try encoder.encode(record)
        let url = fileURL(
            machineId: machineId,
            sessionId: sessionId
        )

        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes(
            [
                .protectionKey:
                    FileProtectionType.completeUntilFirstUserAuthentication
            ],
            ofItemAtPath: url.path
        )
    }

    func remove(machineId: String) throws {
        let directory = machineDirectory(machineId: machineId)
        guard FileManager.default.fileExists(
            atPath: directory.path
        ) else {
            return
        }
        try FileManager.default.removeItem(at: directory)
    }

    private func ensureDirectory(_ url: URL) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [
                .protectionKey:
                    FileProtectionType.completeUntilFirstUserAuthentication
            ]
        )
    }

    private func machineDirectory(machineId: String) -> URL {
        rootURL.appendingPathComponent(
            safePathComponent(machineId),
            isDirectory: true
        )
    }

    private func fileURL(
        machineId: String,
        sessionId: String
    ) -> URL {
        machineDirectory(machineId: machineId)
            .appendingPathComponent(
                safePathComponent(sessionId)
            )
            .appendingPathExtension("json")
    }

    private func safePathComponent(_ value: String) -> String {
        let safe = value.map { character -> Character in
            if character.isLetter
                || character.isNumber
                || "-_.".contains(character) {
                return character
            }
            return "_"
        }
        return String(safe)
    }
}
